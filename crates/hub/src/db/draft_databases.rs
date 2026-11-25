//! Draft databases: Notion-style typed tables whose rows are `drafts` records
//! with `database_id` set. See the frozen API contract for shapes.

use std::collections::HashSet;

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::now_ms;

pub const RESERVED_NAMES: [&str; 4] = ["title", "created_at", "updated_at", "id"];
pub const MAX_BATCH: usize = 500;
const DEFAULT_LIMIT: i64 = 100;
const MAX_LIMIT: i64 = 500;
/// Result cap for public share queries.
pub const PUBLIC_MAX_LIMIT: i64 = 200;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum DdError {
    BadRequest(String),
    NotFound(String),
    Conflict { message: String, id: String },
    Internal(String),
}

impl From<rusqlite::Error> for DdError {
    fn from(e: rusqlite::Error) -> Self {
        DdError::Internal(format!("DB error: {e}"))
    }
}

pub type R<T> = Result<T, DdError>;

fn bad<T>(msg: impl Into<String>) -> R<T> {
    Err(DdError::BadRequest(msg.into()))
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    Text,
    Number,
    Select,
    MultiSelect,
    Date,
    Checkbox,
    Url,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SelectOption {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Column {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ColumnType,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<SelectOption>,
}

#[derive(Deserialize, Clone, Debug)]
pub struct ColumnInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(rename = "type", default)]
    pub ty: Option<ColumnType>,
    #[serde(default)]
    pub options: Vec<SelectOption>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Filter {
    pub column: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Sort {
    pub column: String,
    #[serde(default = "default_dir")]
    pub dir: String,
}

fn default_dir() -> String {
    "asc".to_string()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct View {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default = "default_view_type")]
    pub ty: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sorts: Vec<Sort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_columns: Option<Vec<String>>,
}

fn default_view_type() -> String {
    "table".to_string()
}

#[derive(Serialize, Clone, Debug)]
pub struct Database {
    pub id: String,
    pub name: String,
    pub project_group: String,
    pub columns: Vec<Column>,
    pub views: Vec<View>,
    pub row_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DbRow {
    pub id: String,
    pub database_id: String,
    pub title: String,
    pub properties: Map<String, Value>,
    pub has_content: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct DbRowFull {
    #[serde(flatten)]
    pub row: DbRow,
    pub content: String,
}

#[derive(Deserialize, Default, Debug)]
pub struct QueryRequest {
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub sorts: Vec<Sort>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

#[derive(Serialize, Debug)]
pub struct QueryResult {
    pub rows: Vec<DbRow>,
    pub total: i64,
    pub offset: i64,
    pub limit: i64,
}

#[derive(Deserialize, Debug)]
pub struct GroupsRequest {
    pub group_by: String,
    #[serde(default)]
    pub filters: Vec<Filter>,
    #[serde(default)]
    pub search: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Group {
    pub value: Value,
    pub count: i64,
}

#[derive(Deserialize, Debug)]
pub struct RowInput {
    pub title: String,
    #[serde(default)]
    pub properties: Option<Map<String, Value>>,
    #[serde(default)]
    pub content: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct UpsertResult {
    pub rows: Vec<DbRow>,
    pub created: usize,
    pub updated: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConflictMode {
    Update,
    Create,
}

impl ConflictMode {
    pub fn parse(s: Option<&str>) -> R<Self> {
        match s {
            None | Some("update") => Ok(Self::Update),
            Some("create") => Ok(Self::Create),
            Some(other) => bad(format!(
                "unknown on_conflict '{other}' (expected 'update' or 'create')"
            )),
        }
    }
}

#[derive(Default)]
pub struct DatabasePatch {
    pub name: Option<String>,
    pub columns: Option<Vec<ColumnInput>>,
    pub views: Option<Vec<View>>,
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut last_us = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            last_us = false;
        } else if !last_us && !s.is_empty() {
            s.push('_');
            last_us = true;
        }
    }
    while s.ends_with('_') {
        s.pop();
    }
    s.truncate(40);
    while s.ends_with('_') {
        s.pop();
    }
    if s.is_empty() {
        "col".to_string()
    } else {
        s
    }
}

fn unique_id(base: &str, taken: &HashSet<String>) -> String {
    let is_free = |id: &str| !taken.contains(id) && !RESERVED_NAMES.contains(&id);
    if is_free(base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let cand = format!("{base}_{n}");
        if is_free(&cand) {
            return cand;
        }
        n += 1;
    }
}

/// Column ids end up inside a JSON path, so they must stay `[a-z0-9_]+`.
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn normalize_options(ty: ColumnType, options: &[SelectOption]) -> Vec<SelectOption> {
    if !matches!(ty, ColumnType::Select | ColumnType::MultiSelect) {
        return Vec::new();
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for o in options {
        let name = o.name.trim();
        if name.is_empty() || !seen.insert(name.to_string()) {
            continue;
        }
        out.push(SelectOption {
            name: name.to_string(),
            color: o.color.clone(),
        });
    }
    out
}

/// Build the full replacement column list. Returns (columns, dropped ids).
fn build_columns(existing: &[Column], inputs: &[ColumnInput]) -> R<(Vec<Column>, Vec<String>)> {
    // Ids of dropped columns stay taken so that a new column can never
    // resurrect old values.
    let mut taken: HashSet<String> = existing.iter().map(|c| c.id.clone()).collect();
    let mut names = HashSet::new();
    let mut kept_ids = HashSet::new();
    let mut out = Vec::new();
    for input in inputs {
        let name = input.name.trim();
        if name.is_empty() {
            return bad("column name must not be empty");
        }
        let lower = name.to_lowercase();
        if RESERVED_NAMES.contains(&lower.as_str()) {
            return bad(format!("column name '{name}' is reserved"));
        }
        if !names.insert(lower) {
            return bad(format!("duplicate column name '{name}'"));
        }
        match input.id.as_deref().filter(|s| !s.is_empty()) {
            Some(id) => {
                let Some(old) = existing.iter().find(|c| c.id == id) else {
                    return bad(format!("unknown column id '{id}'"));
                };
                if !kept_ids.insert(id.to_string()) {
                    return bad(format!("column id '{id}' listed twice"));
                }
                if let Some(ty) = input.ty {
                    if ty != old.ty {
                        return bad(format!(
                            "column '{}': changing the type is not allowed",
                            old.name
                        ));
                    }
                }
                out.push(Column {
                    id: old.id.clone(),
                    name: name.to_string(),
                    ty: old.ty,
                    options: normalize_options(old.ty, &input.options),
                });
            }
            None => {
                let Some(ty) = input.ty else {
                    return bad(format!("column '{name}' needs a type"));
                };
                let id = unique_id(&slugify(name), &taken);
                taken.insert(id.clone());
                out.push(Column {
                    id,
                    name: name.to_string(),
                    ty,
                    options: normalize_options(ty, &input.options),
                });
            }
        }
    }
    let dropped = existing
        .iter()
        .filter(|c| !kept_ids.contains(&c.id))
        .map(|c| c.id.clone())
        .collect();
    Ok((out, dropped))
}

fn visible_columns_hint(cols: &[Column]) -> String {
    if cols.is_empty() {
        "(this database has no columns)".to_string()
    } else {
        cols.iter()
            .map(|c| format!("{} ({})", c.name, c.id))
            .collect::<Vec<_>>()
            .join(", ")
    }
}

// ---------------------------------------------------------------------------
// Property coercion
// ---------------------------------------------------------------------------

fn col_err<T>(col: &Column, reason: &str) -> R<T> {
    bad(format!("column '{}': {reason}", col.name))
}

fn num_from(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) => s.trim().parse::<f64>().ok().filter(|f| f.is_finite()),
        _ => None,
    }
}

fn bool_from(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" | "yes" | "1" => Some(true),
            "false" | "no" | "0" => Some(false),
            _ => None,
        },
        Value::Number(n) => match n.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn scalar_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn ensure_option(col: &mut Column, name: &str, changed: &mut bool) {
    if !col.options.iter().any(|o| o.name == name) {
        col.options.push(SelectOption {
            name: name.to_string(),
            color: None,
        });
        *changed = true;
    }
}

/// Coerce one value for a column. `Ok(None)` means "remove the property".
fn coerce_value(col: &mut Column, v: &Value, changed: &mut bool) -> R<Option<Value>> {
    match v {
        Value::Null => return Ok(None),
        Value::String(s) if s.trim().is_empty() => return Ok(None),
        _ => {}
    }
    match col.ty {
        ColumnType::Text | ColumnType::Url => match scalar_string(v) {
            Some(s) => Ok(Some(Value::String(s))),
            None => col_err(col, "expected a string"),
        },
        ColumnType::Number => {
            if let Value::Number(_) = v {
                return match num_from(v) {
                    Some(_) => Ok(Some(v.clone())),
                    None => col_err(col, "expected a finite number"),
                };
            }
            if let Value::String(s) = v {
                if let Ok(i) = s.trim().parse::<i64>() {
                    return Ok(Some(Value::from(i)));
                }
                if let Some(n) = num_from(v).and_then(serde_json::Number::from_f64) {
                    return Ok(Some(Value::Number(n)));
                }
            }
            col_err(col, "expected a number or numeric string")
        }
        ColumnType::Checkbox => match bool_from(v) {
            Some(b) => Ok(Some(Value::Bool(b))),
            None => col_err(col, "expected true/false (or yes/no/1/0)"),
        },
        ColumnType::Select => match v {
            Value::String(s) => {
                let s = s.trim().to_string();
                ensure_option(col, &s, changed);
                Ok(Some(Value::String(s)))
            }
            _ => col_err(col, "expected a string option"),
        },
        ColumnType::MultiSelect => {
            let items: Vec<String> = match v {
                Value::Array(a) => {
                    let mut out = Vec::new();
                    for item in a {
                        match item {
                            Value::String(s) => out.push(s.trim().to_string()),
                            _ => return col_err(col, "expected an array of strings"),
                        }
                    }
                    out
                }
                Value::String(s) => s.split(',').map(|p| p.trim().to_string()).collect(),
                _ => return col_err(col, "expected an array of strings or a comma-separated string"),
            };
            let mut seen = HashSet::new();
            let items: Vec<String> = items
                .into_iter()
                .filter(|s| !s.is_empty() && seen.insert(s.clone()))
                .collect();
            if items.is_empty() {
                return Ok(None);
            }
            for item in &items {
                ensure_option(col, item, changed);
            }
            Ok(Some(Value::Array(items.into_iter().map(Value::String).collect())))
        }
        ColumnType::Date => match v {
            Value::String(s) => {
                let s = s.trim();
                let ok = (s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok())
                    || chrono::DateTime::parse_from_rfc3339(s).is_ok();
                if ok {
                    Ok(Some(Value::String(s.to_string())))
                } else {
                    col_err(col, "expected YYYY-MM-DD or an RFC 3339 datetime")
                }
            }
            _ => col_err(col, "expected a date string"),
        },
    }
}

/// Resolve property keys (id or case-insensitive name) and coerce values.
fn coerce_properties(
    cols: &mut [Column],
    input: &Map<String, Value>,
    changed: &mut bool,
) -> R<Vec<(String, Option<Value>)>> {
    let mut out = Vec::new();
    for (key, v) in input {
        let k = key.trim();
        let idx = cols
            .iter()
            .position(|c| c.id == k)
            .or_else(|| cols.iter().position(|c| c.name.to_lowercase() == k.to_lowercase()));
        let Some(idx) = idx else {
            return bad(format!(
                "unknown property '{key}'; valid columns: {}",
                visible_columns_hint(cols)
            ));
        };
        let val = coerce_value(&mut cols[idx], v, changed)?;
        out.push((cols[idx].id.clone(), val));
    }
    Ok(out)
}

fn apply_sets(props: &mut Map<String, Value>, sets: Vec<(String, Option<Value>)>) {
    for (id, v) in sets {
        match v {
            Some(v) => {
                props.insert(id, v);
            }
            None => {
                props.remove(&id);
            }
        }
    }
}

fn visible_props(mut props: Map<String, Value>, cols: &[Column]) -> Map<String, Value> {
    props.retain(|k, _| cols.iter().any(|c| &c.id == k));
    props
}

fn parse_props(s: &str) -> Map<String, Value> {
    serde_json::from_str::<Value>(s)
        .ok()
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Filter / sort compilation (values and JSON paths are always bound)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Eq,
    Neq,
    Contains,
    NotContains,
    Gt,
    Gte,
    Lt,
    Lte,
    IsEmpty,
    IsNotEmpty,
}

fn parse_op(s: &str) -> R<Op> {
    Ok(match s {
        "eq" => Op::Eq,
        "neq" => Op::Neq,
        "contains" => Op::Contains,
        "not_contains" => Op::NotContains,
        "gt" => Op::Gt,
        "gte" => Op::Gte,
        "lt" => Op::Lt,
        "lte" => Op::Lte,
        "is_empty" => Op::IsEmpty,
        "is_not_empty" => Op::IsNotEmpty,
        other => {
            return bad(format!(
                "unknown operator '{other}' (expected eq, neq, contains, not_contains, gt, gte, lt, lte, is_empty, is_not_empty)"
            ))
        }
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Number,
    Bool,
    Multi,
}

enum Target<'a> {
    Title,
    CreatedAt,
    UpdatedAt,
    Col(&'a Column),
}

impl Target<'_> {
    fn key(&self) -> String {
        match self {
            Target::Title => "title".into(),
            Target::CreatedAt => "created_at".into(),
            Target::UpdatedAt => "updated_at".into(),
            Target::Col(c) => c.id.clone(),
        }
    }

    fn kind(&self) -> Kind {
        match self {
            Target::Title => Kind::Text,
            Target::CreatedAt | Target::UpdatedAt => Kind::Number,
            Target::Col(c) => match c.ty {
                ColumnType::Number => Kind::Number,
                ColumnType::Checkbox => Kind::Bool,
                ColumnType::MultiSelect => Kind::Multi,
                _ => Kind::Text,
            },
        }
    }
}

fn resolve_target<'a>(cols: &'a [Column], key: &str) -> R<Target<'a>> {
    let k = key.trim();
    let lower = k.to_lowercase();
    if let Some(c) = cols.iter().find(|c| c.id == k) {
        return Ok(Target::Col(c));
    }
    if let Some(c) = cols.iter().find(|c| c.name.to_lowercase() == lower) {
        return Ok(Target::Col(c));
    }
    match lower.as_str() {
        "title" => Ok(Target::Title),
        "created_at" => Ok(Target::CreatedAt),
        "updated_at" => Ok(Target::UpdatedAt),
        _ => bad(format!(
            "unknown column '{key}'; valid columns: title, created_at, updated_at, {}",
            visible_columns_hint(cols)
        )),
    }
}

/// The property column id a filter/sort key refers to (`None` for the title /
/// timestamp pseudo-columns and for unknown keys).
pub(crate) fn property_column_id(cols: &[Column], key: &str) -> Option<String> {
    match resolve_target(cols, key) {
        Ok(Target::Col(c)) => Some(c.id.clone()),
        _ => None,
    }
}

#[derive(Default)]
struct Binds(Vec<SqlValue>);

impl Binds {
    fn push(&mut self, v: SqlValue) -> String {
        self.0.push(v);
        format!("?{}", self.0.len())
    }
}

struct Expr {
    /// SQL scalar expression for the column value.
    x: String,
    /// Placeholder holding the JSON path (property columns only).
    path: Option<String>,
}

fn target_expr(t: &Target<'_>, b: &mut Binds) -> R<Expr> {
    Ok(match t {
        Target::Title => Expr { x: "title".into(), path: None },
        Target::CreatedAt => Expr { x: "created_at".into(), path: None },
        Target::UpdatedAt => Expr { x: "updated_at".into(), path: None },
        Target::Col(c) => {
            if !is_valid_id(&c.id) {
                return bad(format!("column '{}' has an invalid id", c.name));
            }
            let ph = b.push(SqlValue::Text(format!("$.\"{}\"", c.id)));
            Expr {
                x: format!("json_extract(properties, {ph})"),
                path: Some(ph),
            }
        }
    })
}

fn filter_value(kind: Kind, col: &str, v: &Value) -> R<SqlValue> {
    match kind {
        Kind::Text | Kind::Multi => match scalar_string(v) {
            Some(s) => Ok(SqlValue::Text(s)),
            None => bad(format!("filter on '{col}': value must be a string")),
        },
        Kind::Number => match num_from(v) {
            Some(f) => Ok(SqlValue::Real(f)),
            None => bad(format!("filter on '{col}': value must be a number")),
        },
        Kind::Bool => match bool_from(v) {
            Some(b) => Ok(SqlValue::Integer(i64::from(b))),
            None => bad(format!("filter on '{col}': value must be a boolean")),
        },
    }
}

fn compile_filter(cols: &[Column], f: &Filter, b: &mut Binds) -> R<String> {
    let op = parse_op(&f.op)?;
    let target = resolve_target(cols, &f.column)?;
    let kind = target.kind();
    let e = target_expr(&target, b)?;
    let x = &e.x;
    if op == Op::IsEmpty || op == Op::IsNotEmpty {
        let multi = if kind == Kind::Multi {
            format!(" OR {x} = '[]'")
        } else {
            String::new()
        };
        let empty = format!("({x} IS NULL OR {x} = ''{multi})");
        return Ok(if op == Op::IsEmpty { empty } else { format!("NOT {empty}") });
    }
    let Some(raw) = f.value.as_ref().filter(|v| !v.is_null()) else {
        return bad(format!("filter on '{}': value is required", f.column));
    };
    let val = filter_value(kind, &f.column, raw)?;
    let p = b.push(val);
    // multi_select eq/neq are treated as "array contains" / "does not contain".
    let op = match (kind, op) {
        (Kind::Multi, Op::Eq) => Op::Contains,
        (Kind::Multi, Op::Neq) => Op::NotContains,
        _ => op,
    };
    let sql = match op {
        Op::Eq => match kind {
            Kind::Bool => format!("COALESCE({x}, 0) = {p}"),
            _ => format!("{x} = {p}"),
        },
        Op::Neq => match kind {
            Kind::Bool => format!("COALESCE({x}, 0) != {p}"),
            _ => format!("{x} IS NOT {p}"),
        },
        Op::Gt | Op::Gte | Op::Lt | Op::Lte => {
            if kind == Kind::Multi {
                return bad(format!("operator '{}' is not supported on multi_select '{}'", f.op, f.column));
            }
            let sym = match op {
                Op::Gt => ">",
                Op::Gte => ">=",
                Op::Lt => "<",
                _ => "<=",
            };
            if kind == Kind::Bool {
                format!("COALESCE({x}, 0) {sym} {p}")
            } else {
                format!("{x} {sym} {p}")
            }
        }
        Op::Contains | Op::NotContains => {
            let neg = op == Op::NotContains;
            let core = match kind {
                Kind::Multi => {
                    let path = e.path.as_deref().unwrap_or("'$'");
                    format!("EXISTS (SELECT 1 FROM json_each(properties, {path}) WHERE value = {p})")
                }
                Kind::Text => format!("instr(lower(COALESCE({x}, '')), lower({p})) > 0"),
                _ => {
                    return bad(format!(
                        "operator '{}' is not supported on column '{}'",
                        f.op, f.column
                    ))
                }
            };
            if neg {
                format!("NOT ({core})")
            } else {
                core
            }
        }
        Op::IsEmpty | Op::IsNotEmpty => unreachable!(),
    };
    Ok(format!("({sql})"))
}

fn compile_sort(cols: &[Column], s: &Sort, b: &mut Binds) -> R<String> {
    let dir = match s.dir.to_lowercase().as_str() {
        "asc" => "ASC",
        "desc" => "DESC",
        other => return bad(format!("unknown sort direction '{other}' (expected asc or desc)")),
    };
    let target = resolve_target(cols, &s.column)?;
    let e = target_expr(&target, b)?;
    Ok(match target {
        // Property sorts keep missing values last in both directions.
        Target::Col(_) => format!("({0} IS NULL), {0} {dir}", e.x),
        _ => format!("{} {dir}", e.x),
    })
}

fn build_where(
    cols: &[Column],
    user_id: &str,
    db_id: &str,
    filters: &[Filter],
    search: Option<&str>,
    only_id: Option<&str>,
    b: &mut Binds,
) -> R<String> {
    let u = b.push(SqlValue::Text(user_id.to_string()));
    let d = b.push(SqlValue::Text(db_id.to_string()));
    let mut parts = vec![format!("user_id = {u}"), format!("database_id = {d}")];
    // Internal only (public share row lookup); never reachable from a client filter.
    if let Some(id) = only_id {
        let p = b.push(SqlValue::Text(id.to_string()));
        parts.push(format!("id = {p}"));
    }
    for f in filters {
        parts.push(compile_filter(cols, f, b)?);
    }
    if let Some(q) = search.map(str::trim).filter(|q| !q.is_empty()) {
        let p = b.push(SqlValue::Text(q.to_string()));
        parts.push(format!("instr(lower(title), lower({p})) > 0"));
    }
    Ok(parts.join(" AND "))
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

fn normalize_views(cols: &[Column], views: Vec<View>) -> R<Vec<View>> {
    if views.is_empty() {
        return bad("at least one view is required");
    }
    let mut ids: HashSet<String> = views
        .iter()
        .filter(|v| !v.id.is_empty())
        .map(|v| v.id.clone())
        .collect();
    let explicit = views.iter().filter(|v| !v.id.is_empty()).count();
    if ids.len() != explicit {
        return bad("duplicate view id");
    }
    let mut out = Vec::new();
    for mut v in views {
        if v.name.trim().is_empty() {
            return bad("view name must not be empty");
        }
        v.name = v.name.trim().to_string();
        if v.ty != "table" && v.ty != "board" {
            return bad(format!("unknown view type '{}' (expected table or board)", v.ty));
        }
        if v.id.is_empty() {
            let id = unique_id(&slugify(&v.name), &ids);
            ids.insert(id.clone());
            v.id = id;
        }
        let mut scratch = Binds::default();
        for f in &mut v.filters {
            compile_filter(cols, f, &mut scratch)?;
            f.column = resolve_target(cols, &f.column)?.key();
        }
        for s in &mut v.sorts {
            compile_sort(cols, s, &mut scratch)?;
            s.column = resolve_target(cols, &s.column)?.key();
        }
        if let Some(g) = v.group_by.clone().filter(|g| !g.is_empty()) {
            match resolve_target(cols, &g)? {
                Target::Col(c) if matches!(c.ty, ColumnType::Select | ColumnType::Checkbox) => {
                    v.group_by = Some(c.id.clone());
                }
                _ => return bad(format!("group_by '{g}' must be a select or checkbox column")),
            }
        } else {
            v.group_by = None;
        }
        if let Some(h) = v.hidden_columns.take() {
            let mut norm = Vec::new();
            for k in h {
                match resolve_target(cols, &k)? {
                    Target::Col(c) => norm.push(c.id.clone()),
                    _ => return bad(format!("hidden column '{k}' must be a property column")),
                }
            }
            v.hidden_columns = Some(norm);
        }
        out.push(v);
    }
    Ok(out)
}

/// Drop view references to columns that no longer exist.
fn prune_views(cols: &[Column], views: Vec<View>) -> Vec<View> {
    views
        .into_iter()
        .map(|mut v| {
            v.filters.retain(|f| resolve_target(cols, &f.column).is_ok());
            v.sorts.retain(|s| resolve_target(cols, &s.column).is_ok());
            if let Some(g) = &v.group_by {
                let ok = matches!(
                    resolve_target(cols, g),
                    Ok(Target::Col(c)) if matches!(c.ty, ColumnType::Select | ColumnType::Checkbox)
                );
                if !ok {
                    v.group_by = None;
                }
            }
            if let Some(h) = &mut v.hidden_columns {
                h.retain(|k| cols.iter().any(|c| &c.id == k));
            }
            v
        })
        .collect()
}

fn default_views() -> Vec<View> {
    vec![View {
        id: "default".into(),
        name: "Table".into(),
        ty: "table".into(),
        filters: vec![],
        sorts: vec![],
        group_by: None,
        hidden_columns: None,
    }]
}

// ---------------------------------------------------------------------------
// Database CRUD
// ---------------------------------------------------------------------------

const DB_SELECT: &str = "id, name, project_group, columns, views, created_at, updated_at,
    (SELECT COUNT(*) FROM drafts WHERE drafts.database_id = draft_databases.id)";

fn map_database(r: &rusqlite::Row<'_>) -> rusqlite::Result<Database> {
    let columns: String = r.get(3)?;
    let views: String = r.get(4)?;
    Ok(Database {
        id: r.get(0)?,
        name: r.get(1)?,
        project_group: r.get(2)?,
        columns: serde_json::from_str(&columns).unwrap_or_default(),
        views: serde_json::from_str(&views).unwrap_or_default(),
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
        row_count: r.get(7)?,
    })
}

pub fn list_databases(
    conn: &Connection,
    user_id: &str,
    project: Option<&str>,
) -> R<Vec<Database>> {
    let project = project.map(str::trim).filter(|p| !p.is_empty());
    let sql = format!(
        "SELECT {DB_SELECT} FROM draft_databases
         WHERE user_id = ?1 AND (?2 IS NULL OR project_group = ?2)
         ORDER BY updated_at DESC, id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![user_id, project], map_database)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn get_database(conn: &Connection, user_id: &str, id: &str) -> R<Database> {
    let sql = format!("SELECT {DB_SELECT} FROM draft_databases WHERE id = ?1 AND user_id = ?2");
    conn.query_row(&sql, params![id, user_id], map_database)
        .optional()?
        .ok_or_else(|| DdError::NotFound("draft database not found".into()))
}

/// Create a database. Returns (database, created); `created` is false when an
/// existing one was returned because of `if_not_exists`.
pub fn create_database(
    conn: &Connection,
    user_id: &str,
    name: &str,
    project_group: Option<&str>,
    columns: &[ColumnInput],
    if_not_exists: bool,
) -> R<(Database, bool)> {
    let name = name.trim();
    if name.is_empty() {
        return bad("name must not be empty");
    }
    let project = project_group.map(str::trim).filter(|p| !p.is_empty()).unwrap_or("~");
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM draft_databases WHERE user_id = ?1 AND project_group = ?2 AND name = ?3",
            params![user_id, project, name],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        if if_not_exists {
            return Ok((get_database(conn, user_id, &id)?, false));
        }
        return Err(DdError::Conflict {
            message: format!("a database named '{name}' already exists in project '{project}'"),
            id,
        });
    }
    let (cols, _) = build_columns(&[], columns)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    conn.execute(
        "INSERT INTO draft_databases (id, user_id, name, project_group, columns, views, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            user_id,
            name,
            project,
            serde_json::to_string(&cols).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&default_views()).unwrap_or_else(|_| "[]".into()),
            now
        ],
    )?;
    Ok((get_database(conn, user_id, &id)?, true))
}

pub fn patch_database(
    conn: &mut Connection,
    user_id: &str,
    id: &str,
    patch: DatabasePatch,
) -> R<Database> {
    // IMMEDIATE: take the write lock up front so busy_timeout applies (a deferred
    // read-then-write upgrade fails at once with "database is locked").
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let db = get_database(&tx, user_id, id)?;
    let mut name = db.name.clone();
    if let Some(n) = patch.name.as_deref() {
        let n = n.trim();
        if n.is_empty() {
            return bad("name must not be empty");
        }
        if n != db.name {
            let clash: Option<String> = tx
                .query_row(
                    "SELECT id FROM draft_databases
                     WHERE user_id = ?1 AND project_group = ?2 AND name = ?3 AND id != ?4",
                    params![user_id, db.project_group, n, id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(cid) = clash {
                return Err(DdError::Conflict {
                    message: format!(
                        "a database named '{n}' already exists in project '{}'",
                        db.project_group
                    ),
                    id: cid,
                });
            }
        }
        name = n.to_string();
    }
    let mut columns = db.columns.clone();
    let mut views = db.views.clone();
    if let Some(inputs) = &patch.columns {
        let (cols, dropped) = build_columns(&db.columns, inputs)?;
        // Scrub dropped values so a later column can never resurrect them.
        for d in &dropped {
            if is_valid_id(d) {
                tx.execute(
                    "UPDATE drafts SET properties = json_remove(properties, ?1) WHERE database_id = ?2",
                    params![format!("$.\"{d}\""), id],
                )?;
            }
        }
        columns = cols;
        views = prune_views(&columns, views);
    }
    if let Some(v) = patch.views {
        views = normalize_views(&columns, v)?;
    }
    if views.is_empty() {
        views = default_views();
    }
    tx.execute(
        "UPDATE draft_databases SET name = ?1, columns = ?2, views = ?3, updated_at = ?4 WHERE id = ?5",
        params![
            name,
            serde_json::to_string(&columns).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&views).unwrap_or_else(|_| "[]".into()),
            now_ms(),
            id
        ],
    )?;
    let out = get_database(&tx, user_id, id)?;
    tx.commit()?;
    Ok(out)
}

pub fn delete_database(conn: &mut Connection, user_id: &str, id: &str) -> R<()> {
    // IMMEDIATE: take the write lock up front so busy_timeout applies (a deferred
    // read-then-write upgrade fails at once with "database is locked").
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    get_database(&tx, user_id, id)?;
    tx.execute(
        "DELETE FROM draft_versions WHERE draft_id IN (SELECT id FROM drafts WHERE database_id = ?1)",
        params![id],
    )?;
    tx.execute("DELETE FROM drafts WHERE database_id = ?1", params![id])?;
    tx.execute(
        "DELETE FROM draft_databases WHERE id = ?1 AND user_id = ?2",
        params![id, user_id],
    )?;
    tx.commit()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const ROW_SELECT: &str = "id, title, properties, length(content) > 0, created_at, updated_at";

fn map_row(r: &rusqlite::Row<'_>, db_id: &str, cols: &[Column]) -> rusqlite::Result<DbRow> {
    let props: String = r.get(2)?;
    Ok(DbRow {
        id: r.get(0)?,
        database_id: db_id.to_string(),
        title: r.get(1)?,
        properties: visible_props(parse_props(&props), cols),
        has_content: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

pub fn query_rows(
    conn: &Connection,
    user_id: &str,
    db_id: &str,
    req: &QueryRequest,
) -> R<QueryResult> {
    query_rows_inner(conn, user_id, db_id, req, None)
}

/// Same as `query_rows`, optionally restricted to one row id. The id
/// restriction is an internal parameter (public share row lookups); it is not
/// part of `QueryRequest`, so no client can supply it.
pub(crate) fn query_rows_inner(
    conn: &Connection,
    user_id: &str,
    db_id: &str,
    req: &QueryRequest,
    only_id: Option<&str>,
) -> R<QueryResult> {
    let db = get_database(conn, user_id, db_id)?;
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = req.offset.unwrap_or(0).max(0);
    let mut b = Binds::default();
    let wh = build_where(&db.columns, user_id, db_id, &req.filters, req.search.as_deref(), only_id, &mut b)?;
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM drafts WHERE {wh}"),
        params_from_iter(b.0.iter()),
        |r| r.get(0),
    )?;
    let mut order = Vec::new();
    for s in &req.sorts {
        order.push(compile_sort(&db.columns, s, &mut b)?);
    }
    if order.is_empty() {
        order.push("created_at ASC".to_string());
    }
    // rowid is insertion order: a stable tiebreak that keeps one batch in input order.
    order.push("rowid ASC".to_string());
    let sql = format!(
        "SELECT {ROW_SELECT} FROM drafts WHERE {wh} ORDER BY {} LIMIT {limit} OFFSET {offset}",
        order.join(", ")
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params_from_iter(b.0.iter()), |r| map_row(r, db_id, &db.columns))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(QueryResult { rows, total, offset, limit })
}

pub fn group_rows(
    conn: &Connection,
    user_id: &str,
    db_id: &str,
    req: &GroupsRequest,
) -> R<Vec<Group>> {
    let db = get_database(conn, user_id, db_id)?;
    let target = resolve_target(&db.columns, &req.group_by)?;
    match &target {
        Target::Col(c) if c.ty == ColumnType::MultiSelect => {
            return bad(format!("cannot group by multi_select column '{}'", c.name))
        }
        Target::Col(c) if matches!(c.ty, ColumnType::Select | ColumnType::Checkbox) => {}
        _ => {
            return bad(format!(
                "group_by '{}' must be a select or checkbox column",
                req.group_by
            ))
        }
    }
    let mut b = Binds::default();
    let wh = build_where(&db.columns, user_id, db_id, &req.filters, req.search.as_deref(), None, &mut b)?;
    let e = target_expr(&target, &mut b)?;
    let is_bool = target.kind() == Kind::Bool;
    let sql = format!(
        "SELECT {0} AS v, COUNT(*) FROM drafts WHERE {wh} GROUP BY v ORDER BY (v IS NULL), v",
        e.x
    );
    let mut stmt = conn.prepare(&sql)?;
    let groups = stmt
        .query_map(params_from_iter(b.0.iter()), |r| {
            let v: SqlValue = r.get(0)?;
            let value = match v {
                SqlValue::Null => Value::Null,
                SqlValue::Integer(i) if is_bool => Value::Bool(i != 0),
                SqlValue::Integer(i) => Value::from(i),
                SqlValue::Real(f) => Value::from(f),
                SqlValue::Text(s) => Value::String(s),
                SqlValue::Blob(_) => Value::Null,
            };
            Ok(Group { value, count: r.get(1)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(groups)
}

fn row_ctx(e: DdError, i: usize) -> DdError {
    match e {
        DdError::BadRequest(m) => DdError::BadRequest(format!("row {i}: {m}")),
        other => other,
    }
}

fn save_columns(conn: &Connection, db_id: &str, cols: &[Column], changed: bool) -> R<()> {
    if changed {
        conn.execute(
            "UPDATE draft_databases SET columns = ?1, updated_at = ?2 WHERE id = ?3",
            params![
                serde_json::to_string(cols).unwrap_or_else(|_| "[]".into()),
                now_ms(),
                db_id
            ],
        )?;
    } else {
        touch_database(conn, db_id)?;
    }
    Ok(())
}

fn touch_database(conn: &Connection, db_id: &str) -> R<()> {
    conn.execute(
        "UPDATE draft_databases SET updated_at = ?1 WHERE id = ?2",
        params![now_ms(), db_id],
    )?;
    Ok(())
}

pub fn upsert_rows(
    conn: &mut Connection,
    user_id: &str,
    db_id: &str,
    rows: Vec<RowInput>,
    mode: ConflictMode,
) -> R<UpsertResult> {
    if rows.len() > MAX_BATCH {
        return bad(format!("at most {MAX_BATCH} rows per request"));
    }
    // IMMEDIATE: take the write lock up front so busy_timeout applies (a deferred
    // read-then-write upgrade fails at once with "database is locked").
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut db = get_database(&tx, user_id, db_id)?;
    let mut cols_changed = false;
    let now = now_ms();
    let mut out = Vec::with_capacity(rows.len());
    let (mut created, mut updated) = (0usize, 0usize);
    for (i, input) in rows.into_iter().enumerate() {
        let title = input.title.trim().to_string();
        if title.is_empty() {
            return bad(format!("row {i}: title must not be empty"));
        }
        let sets = match &input.properties {
            Some(m) => coerce_properties(&mut db.columns, m, &mut cols_changed).map_err(|e| row_ctx(e, i))?,
            None => Vec::new(),
        };
        let existing: Option<(String, String, i64, bool)> = if mode == ConflictMode::Update {
            let mut stmt = tx.prepare_cached(
                // INDEXED BY: with the ORDER BY the planner otherwise walks
                // idx_drafts_database_created and filters titles — a full scan per row.
                "SELECT id, properties, created_at, length(content) > 0
                 FROM drafts INDEXED BY idx_drafts_database_title
                 WHERE database_id = ?1 AND title = ?2 AND user_id = ?3
                 ORDER BY created_at, rowid LIMIT 1",
            )?;
            stmt.query_row(params![db_id, title, user_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .optional()?
        } else {
            None
        };
        match existing {
            Some((id, props_json, created_at, had_content)) => {
                let mut props = parse_props(&props_json);
                apply_sets(&mut props, sets);
                tx.prepare_cached(
                    "UPDATE drafts SET properties = ?1, content = COALESCE(?2, content), updated_at = ?3
                     WHERE id = ?4",
                )?
                .execute(params![
                    serde_json::to_string(&props).unwrap_or_else(|_| "{}".into()),
                    input.content,
                    now,
                    id
                ])?;
                updated += 1;
                out.push(DbRow {
                    id,
                    database_id: db_id.to_string(),
                    title,
                    properties: visible_props(props, &db.columns),
                    has_content: input.content.as_ref().map(|c| !c.is_empty()).unwrap_or(had_content),
                    created_at,
                    updated_at: now,
                });
            }
            None => {
                let mut props = Map::new();
                apply_sets(&mut props, sets);
                let id = uuid::Uuid::new_v4().to_string();
                let created_at = now;
                let content = input.content.unwrap_or_default();
                tx.prepare_cached(
                    "INSERT INTO drafts (id, user_id, title, content, project_group, source_terminal_id,
                        pinned, archived, created_at, updated_at, database_id, properties)
                     VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0, 0, ?6, ?6, ?7, ?8)",
                )?
                .execute(params![
                    id,
                    user_id,
                    title,
                    content,
                    db.project_group,
                    created_at,
                    db_id,
                    serde_json::to_string(&props).unwrap_or_else(|_| "{}".into())
                ])?;
                created += 1;
                out.push(DbRow {
                    id,
                    database_id: db_id.to_string(),
                    title,
                    properties: visible_props(props, &db.columns),
                    has_content: !content.is_empty(),
                    created_at,
                    updated_at: created_at,
                });
            }
        }
    }
    if !out.is_empty() || cols_changed {
        save_columns(&tx, db_id, &db.columns, cols_changed)?;
    }
    tx.commit()?;
    Ok(UpsertResult { rows: out, created, updated })
}

pub fn get_row(conn: &Connection, user_id: &str, db_id: &str, row_id: &str) -> R<DbRowFull> {
    let db = get_database(conn, user_id, db_id)?;
    let sql = format!(
        "SELECT {ROW_SELECT}, content FROM drafts
         WHERE id = ?1 AND database_id = ?2 AND user_id = ?3"
    );
    conn.query_row(&sql, params![row_id, db_id, user_id], |r| {
        Ok(DbRowFull {
            row: map_row(r, db_id, &db.columns)?,
            content: r.get(6)?,
        })
    })
    .optional()?
    .ok_or_else(|| DdError::NotFound("row not found".into()))
}

pub fn patch_row(
    conn: &mut Connection,
    user_id: &str,
    db_id: &str,
    row_id: &str,
    title: Option<&str>,
    properties: Option<&Map<String, Value>>,
    content: Option<&str>,
) -> R<DbRowFull> {
    // IMMEDIATE: take the write lock up front so busy_timeout applies (a deferred
    // read-then-write upgrade fails at once with "database is locked").
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let mut db = get_database(&tx, user_id, db_id)?;
    let existing = get_row(&tx, user_id, db_id, row_id)?;
    // Re-read raw properties so orphaned values are not lost (none are kept after
    // a column drop, but stay defensive).
    let raw: String = tx.query_row(
        "SELECT properties FROM drafts WHERE id = ?1",
        params![row_id],
        |r| r.get(0),
    )?;
    let mut props = parse_props(&raw);
    let mut cols_changed = false;
    if let Some(m) = properties {
        let sets = coerce_properties(&mut db.columns, m, &mut cols_changed)?;
        apply_sets(&mut props, sets);
    }
    let new_title = match title.map(str::trim) {
        Some("") => return bad("title must not be empty"),
        Some(t) => t.to_string(),
        None => existing.row.title.clone(),
    };
    // Keep the previous state when the title or body actually changes.
    if new_title != existing.row.title || content.is_some_and(|c| c != existing.content) {
        super::draft_shares::record_version(
            &tx,
            user_id,
            row_id,
            &existing.row.title,
            &existing.content,
        )?;
    }
    tx.execute(
        "UPDATE drafts SET title = ?1, properties = ?2, content = COALESCE(?3, content), updated_at = ?4
         WHERE id = ?5",
        params![
            new_title,
            serde_json::to_string(&props).unwrap_or_else(|_| "{}".into()),
            content,
            now_ms(),
            row_id
        ],
    )?;
    save_columns(&tx, db_id, &db.columns, cols_changed)?;
    let out = get_row(&tx, user_id, db_id, row_id)?;
    tx.commit()?;
    Ok(out)
}

pub fn delete_row(conn: &mut Connection, user_id: &str, db_id: &str, row_id: &str) -> R<()> {
    let n = delete_rows(conn, user_id, db_id, &[row_id.to_string()])?;
    if n == 0 {
        return Err(DdError::NotFound("row not found".into()));
    }
    Ok(())
}

pub fn delete_rows(conn: &mut Connection, user_id: &str, db_id: &str, ids: &[String]) -> R<usize> {
    if ids.len() > MAX_BATCH {
        return bad(format!("at most {MAX_BATCH} ids per request"));
    }
    // IMMEDIATE: take the write lock up front so busy_timeout applies (a deferred
    // read-then-write upgrade fails at once with "database is locked").
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    get_database(&tx, user_id, db_id)?;
    let mut deleted = 0;
    {
        let mut stmt = tx.prepare(
            "DELETE FROM drafts WHERE id = ?1 AND database_id = ?2 AND user_id = ?3",
        )?;
        let mut drop_versions = tx.prepare(
            "DELETE FROM draft_versions WHERE draft_id = ?1 AND user_id = ?2
               AND NOT EXISTS (SELECT 1 FROM drafts WHERE id = ?1)",
        )?;
        for id in ids {
            let n = stmt.execute(params![id, db_id, user_id])?;
            if n > 0 {
                drop_versions.execute(params![id, user_id])?;
            }
            deleted += n;
        }
    }
    if deleted > 0 {
        touch_database(&tx, db_id)?;
    }
    tx.commit()?;
    Ok(deleted)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::drafts::{get_draft, list_drafts, upsert_draft};
    use crate::db::init_db;
    use serde_json::json;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (id, provider, provider_id, display_name, role, created_at)
             VALUES ('u1', 'local', 'u1', 'Test', 'admin', 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn ci(name: &str, ty: ColumnType) -> ColumnInput {
        ColumnInput { id: None, name: name.into(), ty: Some(ty), options: vec![] }
    }

    fn task_db(conn: &Connection) -> Database {
        let cols = vec![
            ci("Status", ColumnType::Select),
            ci("Tags", ColumnType::MultiSelect),
            ci("Points", ColumnType::Number),
            ci("Due", ColumnType::Date),
            ci("Done", ColumnType::Checkbox),
            ci("Link", ColumnType::Url),
            ci("Notes", ColumnType::Text),
        ];
        create_database(conn, "u1", "tasks", Some("proj"), &cols, false).unwrap().0
    }

    fn row(title: &str, props: Value) -> RowInput {
        RowInput {
            title: title.into(),
            properties: props.as_object().cloned(),
            content: None,
        }
    }

    fn filt(column: &str, op: &str, value: Value) -> Filter {
        Filter {
            column: column.into(),
            op: op.into(),
            value: if value.is_null() { None } else { Some(value) },
        }
    }

    fn q(conn: &Connection, db: &str, req: QueryRequest) -> QueryResult {
        query_rows(conn, "u1", db, &req).unwrap()
    }

    fn titles(r: &QueryResult) -> Vec<String> {
        r.rows.iter().map(|x| x.title.clone()).collect()
    }

    fn is_bad<T: std::fmt::Debug>(r: R<T>) -> String {
        match r {
            Err(DdError::BadRequest(m)) => m,
            other => panic!("expected BadRequest, got {other:?}"),
        }
    }

    fn seed(conn: &mut Connection, db: &str) {
        let rows = vec![
            row("Alpha", json!({"Status":"todo","Tags":["a","b"],"Points":5,"Due":"2026-12-01","Done":false})),
            row("beta", json!({"Status":"doing","Tags":"b, c","Points":"12","Due":"2026-12-05","Done":true})),
            row("Gamma", json!({"Status":"todo","Tags":["c"],"Points":2})),
            row("Delta", json!({"Points":5,"Done":"yes"})),
        ];
        upsert_rows(conn, "u1", db, rows, ConflictMode::Update).unwrap();
    }

    #[test]
    fn database_crud_and_conflicts() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        assert_eq!(db.row_count, 0);
        assert_eq!(db.views.len(), 1);
        assert_eq!(db.views[0].id, "default");
        let ids: Vec<_> = db.columns.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids[0], "status");

        // Name clash -> Conflict carrying the existing id; if_not_exists returns it.
        match create_database(&conn, "u1", "tasks", Some("proj"), &[], false) {
            Err(DdError::Conflict { id, .. }) => assert_eq!(id, db.id),
            other => panic!("{other:?}"),
        }
        let (again, created) = create_database(&conn, "u1", "tasks", Some("proj"), &[], true).unwrap();
        assert!(!created);
        assert_eq!(again.id, db.id);
        // Same name in another project is fine.
        create_database(&conn, "u1", "tasks", Some("other"), &[], false).unwrap();

        assert_eq!(list_databases(&conn, "u1", None).unwrap().len(), 2);
        assert_eq!(list_databases(&conn, "u1", Some("proj")).unwrap().len(), 1);
        assert!(matches!(get_database(&conn, "u2", &db.id), Err(DdError::NotFound(_))));

        let patched = patch_database(
            &mut conn,
            "u1",
            &db.id,
            DatabasePatch { name: Some("work".into()), ..Default::default() },
        )
        .unwrap();
        assert_eq!(patched.name, "work");
        // Renaming into an existing name is a conflict.
        create_database(&conn, "u1", "taken", Some("proj"), &[], false).unwrap();
        assert!(matches!(
            patch_database(&mut conn, "u1", &db.id, DatabasePatch { name: Some("taken".into()), ..Default::default() }),
            Err(DdError::Conflict { .. })
        ));

        delete_database(&mut conn, "u1", &db.id).unwrap();
        assert!(matches!(get_database(&conn, "u1", &db.id), Err(DdError::NotFound(_))));
    }

    #[test]
    fn column_id_generation() {
        let conn = test_conn();
        let cols = vec![
            ci("Due Date", ColumnType::Date),
            ci("due date", ColumnType::Date), // duplicate name (case-insens.)
        ];
        assert!(is_bad(create_database(&conn, "u1", "x", None, &cols, false)).contains("duplicate"));
        let cols = vec![ci("状态", ColumnType::Text), ci("日期", ColumnType::Text), ci("Due-Date", ColumnType::Date), ci("Due Date", ColumnType::Date)];
        let (db, _) = create_database(&conn, "u1", "y", None, &cols, false).unwrap();
        let ids: Vec<_> = db.columns.iter().map(|c| c.id.clone()).collect();
        assert_eq!(ids, vec!["col", "col_2", "due_date", "due_date_2"]);
        // Reserved names are rejected; reserved slugs are skipped.
        assert!(is_bad(create_database(&conn, "u1", "z", None, &[ci("Title", ColumnType::Text)], false)).contains("reserved"));
        let (db, _) = create_database(&conn, "u1", "w", None, &[ci("Created At", ColumnType::Text)], false).unwrap();
        assert_eq!(db.columns[0].id, "created_at_2");
    }

    #[test]
    fn column_replacement_rules() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        upsert_rows(&mut conn, "u1", &db.id, vec![row("r", json!({"Points": 3, "Notes": "hi"}))], ConflictMode::Update).unwrap();

        // Type change rejected.
        let mut inputs: Vec<ColumnInput> = db
            .columns
            .iter()
            .map(|c| ColumnInput { id: Some(c.id.clone()), name: c.name.clone(), ty: Some(c.ty), options: c.options.clone() })
            .collect();
        let mut bad_inputs = inputs.clone();
        bad_inputs[2].ty = Some(ColumnType::Text);
        assert!(is_bad(patch_database(&mut conn, "u1", &db.id, DatabasePatch { columns: Some(bad_inputs), ..Default::default() })).contains("type"));
        // Unknown id rejected.
        let mut unk = inputs.clone();
        unk[0].id = Some("nope".into());
        is_bad(patch_database(&mut conn, "u1", &db.id, DatabasePatch { columns: Some(unk), ..Default::default() }));

        // Rename "Points" -> "Score" (id kept), drop "Notes", add a new column.
        inputs[2].name = "Score".into();
        inputs.retain(|c| c.id.as_deref() != Some("notes"));
        inputs.push(ci("Owner", ColumnType::Text));
        let p = patch_database(&mut conn, "u1", &db.id, DatabasePatch { columns: Some(inputs), ..Default::default() }).unwrap();
        assert_eq!(p.columns.iter().find(|c| c.id == "points").unwrap().name, "Score");
        assert!(p.columns.iter().any(|c| c.id == "owner"));
        assert!(!p.columns.iter().any(|c| c.id == "notes"));
        let r = q(&conn, &db.id, QueryRequest::default());
        assert_eq!(r.rows[0].properties.get("points"), Some(&json!(3)));
        assert!(r.rows[0].properties.get("notes").is_none());

        // Re-adding a dropped name must not resurrect the old value.
        let mut again: Vec<ColumnInput> = p
            .columns
            .iter()
            .map(|c| ColumnInput { id: Some(c.id.clone()), name: c.name.clone(), ty: Some(c.ty), options: c.options.clone() })
            .collect();
        again.push(ci("Notes", ColumnType::Text));
        let p2 = patch_database(&mut conn, "u1", &db.id, DatabasePatch { columns: Some(again), ..Default::default() }).unwrap();
        // Dropped values were scrubbed, so the re-added column starts empty.
        assert_eq!(p2.columns.last().unwrap().id, "notes");
        assert!(q(&conn, &db.id, QueryRequest::default()).rows[0].properties.get("notes").is_none());
    }

    #[test]
    fn views_validation_and_pruning() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        let view = View {
            id: String::new(),
            name: "Board".into(),
            ty: "board".into(),
            filters: vec![filt("Points", "gt", json!(1))],
            sorts: vec![Sort { column: "due".into(), dir: "desc".into() }],
            group_by: Some("Status".into()),
            hidden_columns: Some(vec!["Link".into()]),
        };
        let p = patch_database(&mut conn, "u1", &db.id, DatabasePatch { views: Some(vec![view.clone()]), ..Default::default() }).unwrap();
        assert_eq!(p.views[0].id, "board");
        assert_eq!(p.views[0].group_by.as_deref(), Some("status"));
        assert_eq!(p.views[0].filters[0].column, "points");
        assert_eq!(p.views[0].hidden_columns.as_ref().unwrap()[0], "link");
        // Empty views, bad group_by, bad filter column are rejected.
        is_bad(patch_database(&mut conn, "u1", &db.id, DatabasePatch { views: Some(vec![]), ..Default::default() }));
        let mut v = view.clone();
        v.group_by = Some("points".into());
        is_bad(patch_database(&mut conn, "u1", &db.id, DatabasePatch { views: Some(vec![v]), ..Default::default() }));
        let mut v = view.clone();
        v.filters = vec![filt("nope", "eq", json!(1))];
        is_bad(patch_database(&mut conn, "u1", &db.id, DatabasePatch { views: Some(vec![v]), ..Default::default() }));
        // Dropping the group_by column prunes the reference instead of failing.
        let keep: Vec<ColumnInput> = p
            .columns
            .iter()
            .filter(|c| c.id != "status")
            .map(|c| ColumnInput { id: Some(c.id.clone()), name: c.name.clone(), ty: Some(c.ty), options: vec![] })
            .collect();
        let p = patch_database(&mut conn, "u1", &db.id, DatabasePatch { columns: Some(keep), ..Default::default() }).unwrap();
        assert!(p.views[0].group_by.is_none());
    }

    #[test]
    fn coercion_every_type() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        let res = upsert_rows(
            &mut conn,
            "u1",
            &db.id,
            vec![row(
                "t",
                json!({
                    "status": "todo", "TAGS": "x, y,x", "points": "7.5", "due": "2026-12-01T10:00:00Z",
                    "done": "No", "link": 42, "notes": true
                }),
            )],
            ConflictMode::Update,
        )
        .unwrap();
        let p = &res.rows[0].properties;
        assert_eq!(p["status"], json!("todo"));
        assert_eq!(p["tags"], json!(["x", "y"]));
        assert_eq!(p["points"], json!(7.5));
        assert_eq!(p["due"], json!("2026-12-01T10:00:00Z"));
        assert_eq!(p["done"], json!(false));
        assert_eq!(p["link"], json!("42"));
        assert_eq!(p["notes"], json!("true"));
        // Integer strings stay integers.
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("t", json!({"points": "9"}))], ConflictMode::Update).unwrap();
        assert_eq!(r.rows[0].properties["points"], json!(9));

        // Options auto-added and persisted.
        let d = get_database(&conn, "u1", &db.id).unwrap();
        let names = |id: &str| d.columns.iter().find(|c| c.id == id).unwrap().options.iter().map(|o| o.name.clone()).collect::<Vec<_>>();
        assert_eq!(names("status"), vec!["todo"]);
        assert_eq!(names("tags"), vec!["x", "y"]);
        assert!(d.updated_at >= db.updated_at);

        // null / "" remove.
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("t", json!({"status": null, "notes": ""}))], ConflictMode::Update).unwrap();
        assert!(r.rows[0].properties.get("status").is_none());
        assert!(r.rows[0].properties.get("notes").is_none());

        // Invalid values.
        for (k, v) in [("points", json!("abc")), ("done", json!("maybe")), ("due", json!("12/01/2026")), ("due", json!("2026-13-40")), ("tags", json!([1])), ("status", json!(["a"]))] {
            let msg = is_bad(upsert_rows(&mut conn, "u1", &db.id, vec![row("bad", json!({ k: v }))], ConflictMode::Update));
            assert!(msg.contains("column"), "{msg}");
        }
        // Unknown key names the valid columns.
        let msg = is_bad(upsert_rows(&mut conn, "u1", &db.id, vec![row("bad", json!({"zzz": 1}))], ConflictMode::Update));
        assert!(msg.contains("valid columns") && msg.contains("Status"), "{msg}");
        // A failed batch rolls back entirely (including the good first row).
        let before = q(&conn, &db.id, QueryRequest::default()).total;
        is_bad(upsert_rows(&mut conn, "u1", &db.id, vec![row("ok", json!({})), row("bad", json!({"points": "x"}))], ConflictMode::Update));
        assert_eq!(q(&conn, &db.id, QueryRequest::default()).total, before);
    }

    #[test]
    fn batch_upsert_semantics() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        let mut first = row("A", json!({"status": "todo", "points": 1}));
        first.content = Some("body".into());
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![first, row("B", json!({}))], ConflictMode::Update).unwrap();
        assert_eq!((r.created, r.updated), (2, 0));
        assert!(r.rows[0].has_content && !r.rows[1].has_content);
        // Insertion order is preserved by the default ordering.
        assert_eq!(titles(&q(&conn, &db.id, QueryRequest::default())), vec!["A", "B"]);

        // Update merges properties, keeps content when not provided.
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("A", json!({"points": 2, "notes": "n"}))], ConflictMode::Update).unwrap();
        assert_eq!((r.created, r.updated), (0, 1));
        let full = get_row(&conn, "u1", &db.id, &r.rows[0].id).unwrap();
        assert_eq!(full.content, "body");
        assert_eq!(full.row.properties["status"], json!("todo"));
        assert_eq!(full.row.properties["points"], json!(2));
        // Content replaced when provided.
        let mut upd = row("A", json!({}));
        upd.content = Some("new".into());
        upsert_rows(&mut conn, "u1", &db.id, vec![upd], ConflictMode::Update).unwrap();
        assert_eq!(get_row(&conn, "u1", &db.id, &full.row.id).unwrap().content, "new");

        // on_conflict=create always inserts; duplicate titles within a batch merge in update mode.
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("A", json!({}))], ConflictMode::Create).unwrap();
        assert_eq!(r.created, 1);
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("N", json!({"points": 1})), row("N", json!({"notes": "x"}))], ConflictMode::Update).unwrap();
        assert_eq!((r.created, r.updated), (1, 1));
        assert_eq!(r.rows[1].properties["points"], json!(1));

        // Limits and validation.
        assert!(is_bad(upsert_rows(&mut conn, "u1", &db.id, (0..501).map(|i| row(&format!("r{i}"), json!({}))).collect(), ConflictMode::Update)).contains("500"));
        is_bad(upsert_rows(&mut conn, "u1", &db.id, vec![row("  ", json!({}))], ConflictMode::Update));
        assert!(ConflictMode::parse(Some("weird")).is_err());
    }

    #[test]
    fn row_patch_delete_and_updated_at() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("A", json!({"status": "todo", "points": 1}))], ConflictMode::Update).unwrap();
        let id = r.rows[0].id.clone();
        conn.execute("UPDATE drafts SET updated_at = 1 WHERE id = ?1", [&id]).unwrap();
        conn.execute("UPDATE draft_databases SET updated_at = 1 WHERE id = ?1", [&db.id]).unwrap();
        let props = json!({"status": null, "points": 4}).as_object().cloned().unwrap();
        let p = patch_row(&mut conn, "u1", &db.id, &id, Some("A2"), Some(&props), Some("md")).unwrap();
        assert_eq!(p.row.title, "A2");
        assert!(p.row.properties.get("status").is_none());
        assert_eq!(p.row.properties["points"], json!(4));
        assert_eq!(p.content, "md");
        assert!(p.row.updated_at > 1);
        assert!(get_database(&conn, "u1", &db.id).unwrap().updated_at > 1);
        is_bad(patch_row(&mut conn, "u1", &db.id, &id, Some(" "), None, None));
        assert!(matches!(patch_row(&mut conn, "u1", &db.id, "nope", None, None, None), Err(DdError::NotFound(_))));

        assert_eq!(get_database(&conn, "u1", &db.id).unwrap().row_count, 1);
        delete_row(&mut conn, "u1", &db.id, &id).unwrap();
        assert!(matches!(delete_row(&mut conn, "u1", &db.id, &id), Err(DdError::NotFound(_))));
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("x", json!({})), row("y", json!({}))], ConflictMode::Update).unwrap();
        let ids: Vec<String> = r.rows.iter().map(|r| r.id.clone()).chain(["ghost".to_string()]).collect();
        assert_eq!(delete_rows(&mut conn, "u1", &db.id, &ids).unwrap(), 2);
        assert_eq!(get_database(&conn, "u1", &db.id).unwrap().row_count, 0);
    }

    #[test]
    fn query_operators() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        seed(&mut conn, &db.id);
        let f = |filters: Vec<Filter>| {
            titles(&q(&conn, &db.id, QueryRequest { filters, sorts: vec![], ..Default::default() }))
        };
        assert_eq!(f(vec![filt("status", "eq", json!("todo"))]), vec!["Alpha", "Gamma"]);
        // neq includes rows with no value.
        assert_eq!(f(vec![filt("status", "neq", json!("todo"))]), vec!["beta", "Delta"]);
        // Numbers compare numerically ("12" stored as 12, not lexicographic).
        assert_eq!(f(vec![filt("points", "gt", json!(5))]), vec!["beta"]);
        assert_eq!(f(vec![filt("points", "gte", json!("5"))]), vec!["Alpha", "beta", "Delta"]);
        assert_eq!(f(vec![filt("points", "lt", json!(5))]), vec!["Gamma"]);
        assert_eq!(f(vec![filt("points", "lte", json!(5)), filt("status", "eq", json!("todo"))]), vec!["Alpha", "Gamma"]);
        assert_eq!(f(vec![filt("points", "eq", json!(2))]), vec!["Gamma"]);
        // Dates are lexicographic.
        assert_eq!(f(vec![filt("due", "gte", json!("2026-12-02"))]), vec!["beta"]);
        assert_eq!(f(vec![filt("due", "lt", json!("2026-12-02"))]), vec!["Alpha"]);
        // Checkbox: missing counts as false.
        assert_eq!(f(vec![filt("done", "eq", json!(true))]), vec!["beta", "Delta"]);
        assert_eq!(f(vec![filt("done", "eq", json!(false))]), vec!["Alpha", "Gamma"]);
        // multi_select contains = array contains (exact option), not substring.
        assert_eq!(f(vec![filt("tags", "contains", json!("b"))]), vec!["Alpha", "beta"]);
        assert_eq!(f(vec![filt("tags", "contains", json!("a"))]), vec!["Alpha"]);
        assert_eq!(f(vec![filt("tags", "not_contains", json!("b"))]), vec!["Gamma", "Delta"]);
        // Text contains is a case-insensitive substring; title too.
        assert_eq!(f(vec![filt("title", "contains", json!("ALP"))]), vec!["Alpha"]);
        assert_eq!(f(vec![filt("status", "contains", json!("DO"))]), vec!["Alpha", "beta", "Gamma"]);
        assert_eq!(f(vec![filt("title", "not_contains", json!("a"))]), Vec::<String>::new());
        // is_empty / is_not_empty (missing, null, "", []).
        assert_eq!(f(vec![filt("status", "is_empty", Value::Null)]), vec!["Delta"]);
        assert_eq!(f(vec![filt("tags", "is_empty", Value::Null)]), vec!["Delta"]);
        assert_eq!(f(vec![filt("due", "is_not_empty", Value::Null)]), vec!["Alpha", "beta"]);
        // Column can be addressed by display name.
        assert_eq!(f(vec![filt("Status", "eq", json!("doing"))]), vec!["beta"]);
        // Pseudo-column created_at filters numerically.
        assert_eq!(f(vec![filt("created_at", "gte", json!(0))]).len(), 4);
        // Search.
        let r = q(&conn, &db.id, QueryRequest { search: Some("ET".into()), ..Default::default() });
        assert_eq!(titles(&r), vec!["beta"]);
        // Errors.
        assert!(is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt("zzz", "eq", json!(1))], ..Default::default() })).contains("unknown column"));
        assert!(is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt("status", "like", json!(1))], ..Default::default() })).contains("unknown operator"));
        is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt("points", "contains", json!(1))], ..Default::default() }));
        is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt("points", "gt", json!("abc"))], ..Default::default() }));
        is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt("points", "gt", Value::Null)], ..Default::default() }));
        is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { sorts: vec![Sort { column: "points".into(), dir: "up".into() }], ..Default::default() }));
    }

    #[test]
    fn query_sorts_pagination_total() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        seed(&mut conn, &db.id);
        let sort = |c: &str, d: &str| Sort { column: c.into(), dir: d.into() };
        // Number sort; Alpha/Delta tie at 5 and keep insertion (rowid) order.
        let r = q(&conn, &db.id, QueryRequest { sorts: vec![sort("points", "desc")], ..Default::default() });
        let t = titles(&r);
        assert_eq!(t[0], "beta");
        assert_eq!(t[3], "Gamma");
        assert_eq!(&t[1..3], ["Alpha", "Delta"]);
        // Missing values sort last in both directions.
        let r = q(&conn, &db.id, QueryRequest { sorts: vec![sort("due", "asc")], ..Default::default() });
        assert_eq!(&titles(&r)[..2], ["Alpha", "beta"]);
        let r = q(&conn, &db.id, QueryRequest { sorts: vec![sort("due", "desc")], ..Default::default() });
        assert_eq!(&titles(&r)[..2], ["beta", "Alpha"]);
        // Multi-key sort.
        let r = q(&conn, &db.id, QueryRequest { sorts: vec![sort("status", "asc"), sort("title", "desc")], ..Default::default() });
        assert_eq!(titles(&r), vec!["beta", "Gamma", "Alpha", "Delta"]);
        // Limit / offset / total.
        let r = q(&conn, &db.id, QueryRequest { limit: Some(2), offset: Some(1), ..Default::default() });
        assert_eq!((r.total, r.rows.len(), r.offset, r.limit), (4, 2, 1, 2));
        assert_eq!(titles(&r), vec!["beta", "Gamma"]);
        let r = q(&conn, &db.id, QueryRequest { filters: vec![filt("status", "eq", json!("todo"))], limit: Some(1), ..Default::default() });
        assert_eq!((r.total, r.rows.len()), (2, 1));
        let r = q(&conn, &db.id, QueryRequest { limit: Some(9999), ..Default::default() });
        assert_eq!(r.limit, 500);
        // Rows never carry content.
        assert!(serde_json::to_value(&r.rows[0]).unwrap().get("content").is_none());
    }

    #[test]
    fn groups_logic() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        seed(&mut conn, &db.id);
        let g = |by: &str, filters: Vec<Filter>| {
            group_rows(&conn, "u1", &db.id, &GroupsRequest { group_by: by.into(), filters, search: None })
        };
        let groups = g("status", vec![]).unwrap();
        let v: Vec<_> = groups.iter().map(|g| (g.value.clone(), g.count)).collect();
        assert_eq!(v, vec![(json!("doing"), 1), (json!("todo"), 2), (Value::Null, 1)]);
        let groups = g("done", vec![]).unwrap();
        let v: Vec<_> = groups.iter().map(|g| (g.value.clone(), g.count)).collect();
        assert!(v.contains(&(json!(true), 2)) && v.contains(&(json!(false), 1)) && v.contains(&(Value::Null, 1)));
        let groups = g("status", vec![filt("points", "gte", json!(5))]).unwrap();
        assert_eq!(groups.iter().map(|g| g.count).sum::<i64>(), 3);
        assert!(is_bad(g("tags", vec![])).contains("multi_select"));
        is_bad(g("points", vec![]));
        is_bad(g("title", vec![]));
    }

    #[test]
    fn drafts_interaction() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        let r = upsert_rows(&mut conn, "u1", &db.id, vec![row("Same", json!({}))], ConflictMode::Update).unwrap();
        let row_id = r.rows[0].id.clone();
        let plain = upsert_draft(&conn, "u1", "Same", "plain", "proj", None, false, false).unwrap();
        // Upsert-by-title never matches the row.
        assert_ne!(plain.id, row_id);
        let again = upsert_draft(&conn, "u1", "Same", "plain2", "proj", None, false, false).unwrap();
        assert_eq!(again.id, plain.id);
        // list_drafts excludes rows.
        let l = list_drafts(&conn, "u1", None, true).unwrap();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].id, plain.id);
        assert!(list_drafts(&conn, "u1", Some("proj"), true).unwrap().iter().all(|d| d.id != row_id));
        // get_draft returns the row; the stale auto-archive rule does not apply.
        conn.execute("UPDATE drafts SET updated_at = 1 WHERE id IN (?1, ?2)", [&row_id, &plain.id]).unwrap();
        let d = get_draft(&conn, "u1", &row_id).unwrap().unwrap();
        assert!(!d.archived);
        assert!(get_draft(&conn, "u1", &plain.id).unwrap().unwrap().archived);
        assert_eq!(d.project_group, "proj");
    }

    #[test]
    fn deleting_database_removes_rows() {
        let mut conn = test_conn();
        let db = task_db(&conn);
        seed(&mut conn, &db.id);
        let other = create_database(&conn, "u1", "other", None, &[ci("A", ColumnType::Text)], false).unwrap().0;
        upsert_rows(&mut conn, "u1", &other.id, vec![row("keep", json!({}))], ConflictMode::Update).unwrap();
        delete_database(&mut conn, "u1", &db.id).unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM drafts WHERE database_id = ?1", [&db.id], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
        assert_eq!(get_database(&conn, "u1", &other.id).unwrap().row_count, 1);
    }

    #[test]
    fn injection_is_rejected_not_executed() {
        let mut conn = test_conn();
        let evil = "x\"] '; DROP TABLE drafts; --";
        let (db, _) = create_database(&conn, "u1", "inj", None, &[ci(evil, ColumnType::Text), ci("Ok", ColumnType::Text)], false).unwrap();
        // The generated id is a safe slug.
        assert!(db.columns.iter().all(|c| is_valid_id(&c.id)));
        upsert_rows(&mut conn, "u1", &db.id, vec![row("r", json!({"ok": "v'; DROP TABLE drafts; --"}))], ConflictMode::Update).unwrap();
        for bad_col in ["ok\"] OR 1=1 --", "properties) OR (1=1", "json_extract(properties,'$.ok')", "ok'"] {
            let msg = is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { filters: vec![filt(bad_col, "eq", json!("x"))], ..Default::default() }));
            assert!(msg.contains("unknown column"));
            is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { sorts: vec![Sort { column: bad_col.into(), dir: "asc".into() }], ..Default::default() }));
        }
        is_bad(query_rows(&conn, "u1", &db.id, &QueryRequest { sorts: vec![Sort { column: "ok".into(), dir: "asc; DROP TABLE drafts".into() }], ..Default::default() }));
        // Values are bound, so quote-bearing values are just data.
        let r = q(&conn, &db.id, QueryRequest { filters: vec![filt("ok", "eq", json!("v'; DROP TABLE drafts; --"))], ..Default::default() });
        assert_eq!(r.total, 1);
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM drafts", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        // A tampered stored column id never reaches SQL.
        let tampered = vec![Column { id: "a\"b".into(), name: "T".into(), ty: ColumnType::Text, options: vec![] }];
        is_bad(compile_filter(&tampered, &filt("T", "eq", json!("x")), &mut Binds::default()));
    }

    #[test]
    #[ignore]
    fn perf_100k_rows() {
        use std::time::Instant;
        let path = std::env::temp_dir().join(format!("perf_dd_{}.db", uuid::Uuid::new_v4()));
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;").unwrap();
        init_db(&conn).unwrap();
        conn.execute(
            "INSERT INTO users (id, provider, provider_id, display_name, role, created_at)
             VALUES ('u1', 'local', 'u1', 'Test', 'admin', 1)",
            [],
        )
        .unwrap();
        let cols = vec![
            ci("Status", ColumnType::Select),
            ci("Priority", ColumnType::Number),
            ci("Tags", ColumnType::MultiSelect),
        ];
        let (db, _) = create_database(&conn, "u1", "perf", None, &cols, false).unwrap();
        let statuses = ["todo", "doing", "done", "blocked", "later"];
        let t = Instant::now();
        for batch in 0..200 {
            let rows: Vec<RowInput> = (0..500)
                .map(|i| {
                    let n = batch * 500 + i;
                    row(
                        &format!("Task number {n}"),
                        json!({"status": statuses[n % 5], "priority": (n * 7919) % 1000, "tags": [format!("t{}", n % 20)]}),
                    )
                })
                .collect();
            upsert_rows(&mut conn, "u1", &db.id, rows, ConflictMode::Update).unwrap();
        }
        eprintln!("PERF insert 100k rows: {} ms", t.elapsed().as_millis());

        let t = Instant::now();
        let r = q(
            &conn,
            &db.id,
            QueryRequest {
                filters: vec![filt("status", "eq", json!("todo"))],
                sorts: vec![Sort { column: "priority".into(), dir: "desc".into() }],
                limit: Some(100),
                ..Default::default()
            },
        );
        eprintln!("PERF (a) filtered+sorted first page: {} ms (total {}, rows {})", t.elapsed().as_millis(), r.total, r.rows.len());

        let t = Instant::now();
        let r = q(&conn, &db.id, QueryRequest { limit: Some(1), ..Default::default() });
        eprintln!("PERF (b) total count: {} ms (total {})", t.elapsed().as_millis(), r.total);

        let t = Instant::now();
        let r = q(&conn, &db.id, QueryRequest { search: Some("number 99999".into()), ..Default::default() });
        eprintln!("PERF (c) title search: {} ms (total {})", t.elapsed().as_millis(), r.total);
        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
