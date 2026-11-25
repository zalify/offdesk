//! `offdesk db` — draft databases: Notion-style structured tables whose rows
//! are drafts. Pure parsing/rendering helpers live at the top of the file and
//! are unit tested; the async command functions below only do I/O.

use unicode_width::UnicodeWidthStr;
use std::io::Read;
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::client::HubClient;
use crate::commands::draft::infer_project_group;
use crate::commands::{json_pretty, out_line};
use crate::resolve::short_id;
use crate::CliError;

const COLUMN_TYPES: [&str; 7] = [
    "text",
    "number",
    "select",
    "multi_select",
    "date",
    "checkbox",
    "url",
];
const RESERVED_NAMES: [&str; 4] = ["title", "id", "created_at", "updated_at"];
const IMPORT_CHUNK: usize = 300;
const EXPORT_PAGE: usize = 500;
const TABLE_CELL_MAX: usize = 40;

fn usage<T>(message: impl Into<String>) -> Result<T, CliError> {
    Err(CliError::Usage(message.into()))
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/// Parse `name:type[=opt1,opt2]` into a hub column definition (no id).
pub fn parse_col_spec(spec: &str) -> Result<Value, CliError> {
    let (head, opts) = match spec.split_once('=') {
        Some((head, opts)) => (head, Some(opts)),
        None => (spec, None),
    };
    let Some((name, ty)) = head.rsplit_once(':') else {
        return usage(format!("bad column spec '{spec}': expected <name>:<type>[=opt1,opt2]"));
    };
    let name = name.trim();
    let ty = ty.trim().to_ascii_lowercase();
    if name.is_empty() {
        return usage(format!("bad column spec '{spec}': empty column name"));
    }
    if RESERVED_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
        return usage(format!("column name '{name}' is reserved"));
    }
    if !COLUMN_TYPES.contains(&ty.as_str()) {
        return usage(format!(
            "bad column type '{ty}' in '{spec}': expected one of {}",
            COLUMN_TYPES.join(", ")
        ));
    }
    let mut column = json!({ "name": name, "type": ty });
    if let Some(opts) = opts {
        if ty != "select" && ty != "multi_select" {
            return usage(format!(
                "bad column spec '{spec}': options (=a,b) only apply to select / multi_select"
            ));
        }
        let options: Vec<Value> = opts
            .split(',')
            .map(str::trim)
            .filter(|o| !o.is_empty())
            .map(|o| json!({ "name": o }))
            .collect();
        if !options.is_empty() {
            column["options"] = Value::Array(options);
        }
    }
    Ok(column)
}

/// Turn a CLI string into a JSON value: bools and canonical numbers become
/// JSON bools/numbers, everything else stays a string (the hub coerces by
/// column type). Non-canonical numerics such as `007` stay strings so text
/// columns keep them intact.
pub fn typed_value(raw: &str) -> Value {
    match raw {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        _ => {}
    }
    if let Ok(int) = raw.parse::<i64>() {
        if int.to_string() == raw {
            return json!(int);
        }
    }
    if raw.contains(['.', 'e', 'E']) {
        if let Ok(float) = raw.parse::<f64>() {
            if let Some(number) = serde_json::Number::from_f64(float) {
                if number.to_string() == raw {
                    return Value::Number(number);
                }
            }
        }
    }
    Value::String(raw.to_string())
}

/// `(token, hub op)` pairs; at any one position longer tokens come first.
const WHERE_OPS: [(&str, &str); 8] = [
    (">=", "gte"),
    ("<=", "lte"),
    ("!=", "neq"),
    ("!~", "not_contains"),
    ("=", "eq"),
    ("~", "contains"),
    (">", "gt"),
    ("<", "lt"),
];

/// Parse a `--where` expression into a hub filter. The first operator found
/// scanning left to right wins, so later operator characters belong to the
/// value (`name!=a=b`, `url=https://a/b?x=1`).
pub fn parse_where(expr: &str) -> Result<Value, CliError> {
    for (i, _) in expr.char_indices() {
        let rest = &expr[i..];
        let column = expr[..i].trim();
        if rest == ":empty" || rest == ":not_empty" {
            if column.is_empty() {
                break;
            }
            let op = if rest == ":empty" { "is_empty" } else { "is_not_empty" };
            return Ok(json!({ "column": column, "op": op }));
        }
        for (token, op) in WHERE_OPS {
            if let Some(value) = rest.strip_prefix(token) {
                if column.is_empty() {
                    return usage(format!("bad --where '{expr}': missing column before '{token}'"));
                }
                return Ok(json!({ "column": column, "op": op, "value": typed_value(value) }));
            }
        }
    }
    usage(format!(
        "bad --where '{expr}': expected col=v, col!=v, col~v, col!~v, col>v, col>=v, col<v, col<=v, col:empty or col:not_empty"
    ))
}

/// Parse `<col>[:asc|:desc]` into a hub sort.
pub fn parse_sort(spec: &str) -> Result<Value, CliError> {
    let (column, dir) = match spec.rsplit_once(':') {
        Some((column, dir)) if dir.eq_ignore_ascii_case("asc") || dir.eq_ignore_ascii_case("desc") => {
            (column, dir.to_ascii_lowercase())
        }
        _ => (spec, "asc".to_string()),
    };
    let column = column.trim();
    if column.is_empty() {
        return usage(format!("bad --sort '{spec}': empty column"));
    }
    Ok(json!({ "column": column, "dir": dir }))
}

/// Parse `<col>=<value>`. An empty value yields JSON null, which clears the
/// property on the hub.
pub fn parse_set(spec: &str) -> Result<(String, Value), CliError> {
    let Some((column, value)) = spec.split_once('=') else {
        return usage(format!("bad --set '{spec}': expected <col>=<value>"));
    };
    let column = column.trim();
    if column.is_empty() {
        return usage(format!("bad --set '{spec}': empty column name"));
    }
    let value = if value.is_empty() {
        Value::Null
    } else {
        typed_value(value)
    };
    Ok((column.to_string(), value))
}

pub fn parse_sets(specs: &[String]) -> Result<Map<String, Value>, CliError> {
    let mut map = Map::new();
    for spec in specs {
        let (column, value) = parse_set(spec)?;
        map.insert(column, value);
    }
    Ok(map)
}

/// Build the body for `POST .../rows/query`.
pub fn build_query_body(
    wheres: &[String],
    sorts: &[String],
    search: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<Value, CliError> {
    let mut body = Map::new();
    if !wheres.is_empty() {
        let filters = wheres.iter().map(|w| parse_where(w)).collect::<Result<Vec<_>, _>>()?;
        body.insert("filters".into(), Value::Array(filters));
    }
    if !sorts.is_empty() {
        let sorts = sorts.iter().map(|s| parse_sort(s)).collect::<Result<Vec<_>, _>>()?;
        body.insert("sorts".into(), Value::Array(sorts));
    }
    if let Some(search) = search {
        body.insert("search".into(), json!(search));
    }
    if let Some(limit) = limit {
        body.insert("limit".into(), json!(limit));
    }
    if let Some(offset) = offset {
        body.insert("offset".into(), json!(offset));
    }
    Ok(Value::Object(body))
}

// ---------------------------------------------------------------------------
// Database / row lookup helpers (pure)
// ---------------------------------------------------------------------------

fn str_field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn columns_of(db: &Value) -> Vec<Value> {
    db.get("columns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn describe_db(db: &Value) -> String {
    format!(
        "  {}  {}  [{}]",
        short_id(str_field(db, "id")),
        str_field(db, "name"),
        str_field(db, "project_group")
    )
}

fn ambiguous_dbs(query: &str, matches: &[&Value]) -> CliError {
    let candidates = matches.iter().map(|d| describe_db(d)).collect::<Vec<_>>().join("\n");
    CliError::Usage(format!(
        "database '{query}' is ambiguous (use the id or --project) — candidates:\n{candidates}"
    ))
}

/// Find a database by name (case-insensitive, inferred group first, then all
/// projects), else by id / unique id prefix. `Ok(None)` means no match.
pub fn find_db<'a>(dbs: &'a [Value], query: &str, group: &str) -> Result<Option<&'a Value>, CliError> {
    let named: Vec<&Value> = dbs
        .iter()
        .filter(|d| str_field(d, "name").eq_ignore_ascii_case(query))
        .collect();
    let in_group: Vec<&Value> = named
        .iter()
        .copied()
        .filter(|d| str_field(d, "project_group") == group)
        .collect();
    if in_group.len() == 1 {
        return Ok(Some(in_group[0]));
    }
    if in_group.len() > 1 {
        return Err(ambiguous_dbs(query, &in_group));
    }
    match named.len() {
        1 => return Ok(Some(named[0])),
        n if n > 1 => return Err(ambiguous_dbs(query, &named)),
        _ => {}
    }
    if let Some(exact) = dbs.iter().find(|d| str_field(d, "id") == query) {
        return Ok(Some(exact));
    }
    let by_prefix: Vec<&Value> = dbs
        .iter()
        .filter(|d| !query.is_empty() && str_field(d, "id").starts_with(query))
        .collect();
    match by_prefix.len() {
        0 => Ok(None),
        1 => Ok(Some(by_prefix[0])),
        _ => Err(ambiguous_dbs(query, &by_prefix)),
    }
}

async fn resolve_db(client: &HubClient, query: &str, project: Option<&str>) -> Result<Value, CliError> {
    let dbs = client.db_list(None).await?;
    let dbs = dbs.as_array().cloned().unwrap_or_default();
    let group = project.map(str::to_string).unwrap_or_else(infer_project_group);
    match find_db(&dbs, query, &group)? {
        Some(db) => Ok(db.clone()),
        None => {
            let names = dbs.iter().map(describe_db).collect::<Vec<_>>().join("\n");
            let hint = if names.is_empty() {
                "no databases exist yet (create one with `offdesk db create`)".to_string()
            } else {
                format!("available databases:\n{names}")
            };
            usage(format!("no database matching '{query}'; {hint}"))
        }
    }
}

fn describe_row(row: &Value) -> String {
    format!("  {}  {}", short_id(str_field(row, "id")), str_field(row, "title"))
}

/// Resolve a row by exact title (query with an `eq` title filter), else by id
/// or unique id prefix.
async fn resolve_row(client: &HubClient, db_id: &str, query: &str) -> Result<Value, CliError> {
    let body = json!({
        "filters": [{ "column": "title", "op": "eq", "value": query }],
        "limit": 50
    });
    let found = client.db_rows_query(db_id, &body).await?;
    let rows = found.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    match rows.len() {
        1 => return Ok(rows[0].clone()),
        0 => {}
        _ => {
            let candidates = rows.iter().map(describe_row).collect::<Vec<_>>().join("\n");
            return usage(format!(
                "row title '{query}' is ambiguous (use the id) — candidates:\n{candidates}"
            ));
        }
    }
    // Exact id, then unique id prefix.
    if let Ok(row) = client.db_row_get(db_id, query).await {
        return Ok(row);
    }
    let mut matches: Vec<Value> = Vec::new();
    let mut offset = 0usize;
    loop {
        let page = client
            .db_rows_query(db_id, &json!({ "limit": EXPORT_PAGE, "offset": offset }))
            .await?;
        let rows = page.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let total = page.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
        let n = rows.len();
        matches.extend(rows.into_iter().filter(|r| str_field(r, "id").starts_with(query)));
        offset += n;
        if n == 0 || offset >= total {
            break;
        }
    }
    match matches.len() {
        0 => usage(format!("no row matching '{query}' (by exact title or id)")),
        1 => Ok(matches.remove(0)),
        _ => {
            let candidates = matches.iter().map(describe_row).collect::<Vec<_>>().join("\n");
            usage(format!("'{query}' is ambiguous — candidates:\n{candidates}"))
        }
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Flatten whitespace and cut to `max` chars, marking the cut with an ellipsis.
pub fn truncate_cell(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .map(|c| if matches!(c, '\n' | '\r' | '\t') { ' ' } else { c })
        .collect();
    if flat.chars().count() <= max {
        return flat;
    }
    let mut cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// Plain-text rendering of a property value.
pub fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Array(items) => items.iter().map(cell_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

/// Aligned text table with a header line; cells are truncated.
pub fn render_table(headers: &[String], rows: &[Vec<String>], max_cell: usize) -> String {
    let clipped: Vec<Vec<String>> = rows
        .iter()
        .map(|row| row.iter().map(|c| truncate_cell(c, max_cell)).collect())
        .collect();
    let mut widths: Vec<usize> = headers.iter().map(|h| UnicodeWidthStr::width(h.as_str())).collect();
    for row in &clipped {
        for (i, cell) in row.iter().enumerate() {
            if i < widths.len() {
                widths[i] = widths[i].max(UnicodeWidthStr::width(cell.as_str()));
            }
        }
    }
    let line = |cells: &[String]| -> String {
        let mut out = String::new();
        for (i, width) in widths.iter().enumerate() {
            let cell = cells.get(i).map(String::as_str).unwrap_or("");
            out.push_str(cell);
            if i + 1 < widths.len() {
                out.push_str(&" ".repeat(width - UnicodeWidthStr::width(cell) + 2));
            }
        }
        out.trim_end().to_string()
    };
    let mut lines = vec![line(headers)];
    lines.extend(clipped.iter().map(|row| line(row)));
    lines.join("\n")
}

fn properties_of(row: &Value) -> Option<&Map<String, Value>> {
    row.get("properties").and_then(Value::as_object)
}

fn rows_table(db: &Value, rows: &[Value]) -> String {
    let columns = columns_of(db);
    let mut headers = vec!["ID".to_string(), "TITLE".to_string()];
    headers.extend(columns.iter().map(|c| str_field(c, "name").to_string()));
    let body: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            let mut cells = vec![short_id(str_field(row, "id")).to_string(), str_field(row, "title").to_string()];
            for column in &columns {
                let value = properties_of(row).and_then(|p| p.get(str_field(column, "id")));
                cells.push(value.map(cell_text).unwrap_or_default());
            }
            cells
        })
        .collect();
    render_table(&headers, &body, TABLE_CELL_MAX)
}

fn describe_columns(columns: &[Value]) -> Vec<String> {
    columns
        .iter()
        .map(|c| {
            let options: Vec<&str> = c
                .get("options")
                .and_then(Value::as_array)
                .map(|o| o.iter().map(|o| str_field(o, "name")).collect())
                .unwrap_or_default();
            let suffix = if options.is_empty() {
                String::new()
            } else {
                format!("  [{}]", options.join(", "))
            };
            format!("  {}  {}{}", str_field(c, "name"), str_field(c, "type"), suffix)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

/// Where each CSV header goes when importing.
#[derive(Debug, PartialEq)]
pub struct CsvPlan {
    pub title_idx: usize,
    /// `(csv column index, database column name)` for every non-title header.
    pub mapped: Vec<(usize, String)>,
    /// Headers that match no existing column.
    pub unknown: Vec<String>,
}

/// Map CSV headers onto the title and the database's columns (`existing` are
/// column names; empty for a database that does not exist yet).
pub fn plan_csv(headers: &[String], title_col: Option<&str>, existing: &[String]) -> Result<CsvPlan, CliError> {
    let find = |name: &str| headers.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
    let title_idx = match title_col {
        Some(name) => find(name).ok_or_else(|| {
            CliError::Usage(format!(
                "--title-col '{name}' not found in CSV headers: {}",
                headers.join(", ")
            ))
        })?,
        None => find("title").or_else(|| find("name")).unwrap_or(0),
    };
    if headers.is_empty() {
        return usage("CSV has no header row");
    }
    let mut seen: Vec<String> = Vec::new();
    let mut mapped = Vec::new();
    let mut unknown = Vec::new();
    for (i, header) in headers.iter().enumerate() {
        let name = header.trim();
        if name.is_empty() {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        if seen.contains(&lower) {
            return usage(format!("duplicate CSV header '{name}'"));
        }
        seen.push(lower);
        if i == title_idx {
            continue;
        }
        match existing.iter().find(|c| c.eq_ignore_ascii_case(name)) {
            Some(column) => mapped.push((i, column.clone())),
            None => {
                mapped.push((i, name.to_string()));
                unknown.push(name.to_string());
            }
        }
    }
    Ok(CsvPlan { title_idx, mapped, unknown })
}

/// Convert CSV records into batch rows. Empty cells are omitted (so an
/// update never clears data); rows without a title are skipped and counted.
pub fn build_import_rows(records: &[Vec<String>], plan: &CsvPlan) -> (Vec<Value>, usize) {
    let mut rows = Vec::new();
    let mut skipped = 0;
    for record in records {
        let title = record.get(plan.title_idx).map(|t| t.trim()).unwrap_or("");
        if title.is_empty() {
            skipped += 1;
            continue;
        }
        let mut properties = Map::new();
        for (idx, name) in &plan.mapped {
            if let Some(cell) = record.get(*idx) {
                if !cell.is_empty() {
                    properties.insert(name.clone(), Value::String(cell.clone()));
                }
            }
        }
        let mut row = json!({ "title": title });
        if !properties.is_empty() {
            row["properties"] = Value::Object(properties);
        }
        rows.push(row);
    }
    (rows, skipped)
}

/// Parse CSV text with a header row. Ragged rows are tolerated.
pub fn parse_csv(input: &[u8]) -> Result<(Vec<String>, Vec<Vec<String>>), CliError> {
    let mut reader = csv::ReaderBuilder::new().has_headers(true).flexible(true).from_reader(input);
    let mut headers: Vec<String> = reader
        .headers()
        .map_err(|e| CliError::Usage(format!("invalid CSV: {e}")))?
        .iter()
        .map(str::to_string)
        .collect();
    if let Some(first) = headers.first_mut() {
        *first = first.trim_start_matches('\u{feff}').to_string();
    }
    let mut records = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| CliError::Usage(format!("invalid CSV: {e}")))?;
        records.push(record.iter().map(str::to_string).collect());
    }
    Ok((headers, records))
}

fn rows_to_csv(db: &Value, rows: &[Value]) -> Result<String, CliError> {
    let columns = columns_of(db);
    let mut writer = csv::Writer::from_writer(Vec::new());
    let mut header = vec!["title".to_string()];
    header.extend(columns.iter().map(|c| str_field(c, "name").to_string()));
    let fail = |e: csv::Error| CliError::Protocol(format!("failed to write CSV: {e}"));
    writer.write_record(&header).map_err(fail)?;
    for row in rows {
        let mut record = vec![str_field(row, "title").to_string()];
        for column in &columns {
            let value = properties_of(row).and_then(|p| p.get(str_field(column, "id")));
            record.push(value.map(cell_text).unwrap_or_default());
        }
        writer.write_record(&record).map_err(fail)?;
    }
    let bytes = writer
        .into_inner()
        .map_err(|e| CliError::Protocol(format!("failed to write CSV: {e}")))?;
    String::from_utf8(bytes).map_err(|e| CliError::Protocol(format!("CSV was not UTF-8: {e}")))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn read_stdin() -> Result<String, CliError> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| CliError::Usage(format!("failed to read stdin: {e}")))?;
    Ok(buf)
}

fn content_arg(content: Option<String>, from_stdin: bool) -> Result<Option<String>, CliError> {
    if from_stdin {
        return read_stdin().map(Some);
    }
    Ok(content)
}

fn print_json(value: &Value) -> Result<(), CliError> {
    out_line(&json_pretty(value)?);
    Ok(())
}

pub async fn create(
    client: &HubClient,
    name: &str,
    cols: &[String],
    project: Option<String>,
    if_not_exists: bool,
    json: bool,
) -> Result<(), CliError> {
    let columns = cols.iter().map(|c| parse_col_spec(c)).collect::<Result<Vec<_>, _>>()?;
    let project_group = project.unwrap_or_else(infer_project_group);
    let body = json!({
        "name": name,
        "project_group": project_group,
        "columns": columns,
        "if_not_exists": if_not_exists
    });
    let db = client.db_create(&body).await?;
    if json {
        return print_json(&db);
    }
    out_line(&format!(
        "database {} [{}] \"{}\" ({} columns)",
        short_id(str_field(&db, "id")),
        str_field(&db, "project_group"),
        str_field(&db, "name"),
        columns_of(&db).len()
    ));
    Ok(())
}

pub async fn list(
    client: &HubClient,
    project: Option<String>,
    all_projects: bool,
    json: bool,
) -> Result<(), CliError> {
    let group = if all_projects {
        None
    } else {
        Some(project.unwrap_or_else(infer_project_group))
    };
    let dbs = client.db_list(group.as_deref()).await?;
    if json {
        return print_json(&dbs);
    }
    let dbs = dbs.as_array().cloned().unwrap_or_default();
    if dbs.is_empty() {
        out_line("no databases");
        return Ok(());
    }
    let headers: Vec<String> = ["NAME", "ID", "PROJECT", "COLS", "ROWS"].map(String::from).to_vec();
    let rows: Vec<Vec<String>> = dbs
        .iter()
        .map(|d| {
            vec![
                str_field(d, "name").to_string(),
                short_id(str_field(d, "id")).to_string(),
                str_field(d, "project_group").to_string(),
                columns_of(d).len().to_string(),
                d.get("row_count").and_then(Value::as_i64).unwrap_or(0).to_string(),
            ]
        })
        .collect();
    out_line(&render_table(&headers, &rows, 60));
    Ok(())
}

fn print_schema(db: &Value) {
    out_line(&format!(
        "{} {} [{}]",
        str_field(db, "name"),
        short_id(str_field(db, "id")),
        str_field(db, "project_group")
    ));
    out_line("columns:");
    for line in describe_columns(&columns_of(db)) {
        out_line(&line);
    }
    out_line("views:");
    for view in db.get("views").and_then(Value::as_array).into_iter().flatten() {
        let count = |key: &str| view.get(key).and_then(Value::as_array).map(Vec::len).unwrap_or(0);
        let group = view
            .get("group_by")
            .and_then(Value::as_str)
            .map(|g| format!(", group_by {g}"))
            .unwrap_or_default();
        out_line(&format!(
            "  {}  {}  ({} filters, {} sorts{})",
            str_field(view, "name"),
            str_field(view, "type"),
            count("filters"),
            count("sorts"),
            group
        ));
    }
}

pub async fn schema(
    client: &HubClient,
    db: &str,
    add_cols: &[String],
    rm_cols: &[String],
    rename: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let current = resolve_db(client, db, None).await?;
    let modifying = !add_cols.is_empty() || !rm_cols.is_empty() || rename.is_some();
    let result = if modifying {
        let mut body = Map::new();
        if let Some(name) = &rename {
            body.insert("name".into(), json!(name));
        }
        if !add_cols.is_empty() || !rm_cols.is_empty() {
            let mut columns = columns_of(&current);
            for name in rm_cols {
                let before = columns.len();
                columns.retain(|c| !str_field(c, "name").eq_ignore_ascii_case(name));
                if columns.len() == before {
                    return usage(format!("--rm-col: no column named '{name}'"));
                }
            }
            for spec in add_cols {
                columns.push(parse_col_spec(spec)?);
            }
            body.insert("columns".into(), Value::Array(columns));
        }
        client.db_patch(str_field(&current, "id"), &Value::Object(body)).await?
    } else {
        current
    };
    if json {
        return print_json(&result);
    }
    print_schema(&result);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn add(
    client: &HubClient,
    db: &str,
    title: &str,
    sets: &[String],
    content: Option<String>,
    content_stdin: bool,
    new: bool,
    json: bool,
) -> Result<(), CliError> {
    let properties = parse_sets(sets)?;
    let content = content_arg(content, content_stdin)?;
    let database = resolve_db(client, db, None).await?;
    let mut row = json!({ "title": title });
    if !properties.is_empty() {
        row["properties"] = Value::Object(properties);
    }
    if let Some(content) = content {
        row["content"] = json!(content);
    }
    let body = json!({ "rows": [row], "on_conflict": if new { "create" } else { "update" } });
    let response = client.db_rows_batch(str_field(&database, "id"), &body).await?;
    if json {
        return print_json(&response);
    }
    let created = response.get("created").and_then(Value::as_u64).unwrap_or(0);
    let saved = response
        .get("rows")
        .and_then(Value::as_array)
        .and_then(|r| r.first())
        .cloned()
        .unwrap_or(Value::Null);
    out_line(&format!(
        "{} row {} \"{}\"",
        if created > 0 { "created" } else { "updated" },
        short_id(str_field(&saved, "id")),
        str_field(&saved, "title")
    ));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn update(
    client: &HubClient,
    db: &str,
    row: &str,
    sets: &[String],
    title: Option<String>,
    content: Option<String>,
    content_stdin: bool,
    json: bool,
) -> Result<(), CliError> {
    let properties = parse_sets(sets)?;
    let content = content_arg(content, content_stdin)?;
    if properties.is_empty() && title.is_none() && content.is_none() {
        return usage("nothing to update: pass --set, --title, --content or --content-stdin");
    }
    let database = resolve_db(client, db, None).await?;
    let db_id = str_field(&database, "id").to_string();
    let target = resolve_row(client, &db_id, row).await?;
    let mut body = Map::new();
    if let Some(title) = title {
        body.insert("title".into(), json!(title));
    }
    if !properties.is_empty() {
        body.insert("properties".into(), Value::Object(properties));
    }
    if let Some(content) = content {
        body.insert("content".into(), json!(content));
    }
    let updated = client
        .db_row_patch(&db_id, str_field(&target, "id"), &Value::Object(body))
        .await?;
    if json {
        return print_json(&updated);
    }
    out_line(&format!(
        "updated row {} \"{}\"",
        short_id(str_field(&updated, "id")),
        str_field(&updated, "title")
    ));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn query(
    client: &HubClient,
    db: &str,
    wheres: &[String],
    sorts: &[String],
    search: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
    json: bool,
) -> Result<(), CliError> {
    let body = build_query_body(wheres, sorts, search.as_deref(), limit, offset)?;
    let database = resolve_db(client, db, None).await?;
    let response = client.db_rows_query(str_field(&database, "id"), &body).await?;
    if json {
        return print_json(&response);
    }
    let rows = response.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
    let total = response.get("total").and_then(Value::as_u64).unwrap_or(rows.len() as u64);
    if !rows.is_empty() {
        out_line(&rows_table(&database, &rows));
    }
    out_line(&format!("{} of {} rows", rows.len(), total));
    Ok(())
}

pub async fn get(client: &HubClient, db: &str, row: &str, json: bool) -> Result<(), CliError> {
    let database = resolve_db(client, db, None).await?;
    let db_id = str_field(&database, "id").to_string();
    let found = resolve_row(client, &db_id, row).await?;
    let full = client.db_row_get(&db_id, str_field(&found, "id")).await?;
    if json {
        return print_json(&full);
    }
    out_line(&format!("title: {}", str_field(&full, "title")));
    out_line(&format!("id: {}", str_field(&full, "id")));
    for column in columns_of(&database) {
        let value = properties_of(&full).and_then(|p| p.get(str_field(&column, "id")));
        if let Some(value) = value.filter(|v| !v.is_null()) {
            out_line(&format!("{}: {}", str_field(&column, "name"), cell_text(value)));
        }
    }
    let content = str_field(&full, "content");
    if !content.is_empty() {
        out_line("");
        out_line(content);
    }
    Ok(())
}

pub async fn rm(client: &HubClient, db: &str, rows: &[String]) -> Result<(), CliError> {
    let database = resolve_db(client, db, None).await?;
    let db_id = str_field(&database, "id").to_string();
    let mut ids: Vec<String> = Vec::new();
    for row in rows {
        let found = resolve_row(client, &db_id, row).await?;
        let id = str_field(&found, "id").to_string();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if ids.len() == 1 {
        client.db_row_delete(&db_id, &ids[0]).await?;
        out_line("deleted 1 row");
        return Ok(());
    }
    let mut deleted = 0;
    for chunk in ids.chunks(500) {
        let response = client.db_rows_delete(&db_id, chunk).await?;
        deleted += response.get("deleted").and_then(Value::as_u64).unwrap_or(0);
    }
    out_line(&format!("deleted {deleted} rows"));
    Ok(())
}

pub async fn drop_db(client: &HubClient, db: &str, yes: bool) -> Result<(), CliError> {
    if !yes {
        return usage("refusing to delete a database and all its rows without --yes");
    }
    let database = resolve_db(client, db, None).await?;
    client.db_delete(str_field(&database, "id")).await?;
    out_line(&format!(
        "deleted database {} \"{}\"",
        short_id(str_field(&database, "id")),
        str_field(&database, "name")
    ));
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn import(
    client: &HubClient,
    db: &str,
    file: &str,
    title_col: Option<String>,
    create: bool,
    new: bool,
    project: Option<String>,
    json: bool,
) -> Result<(), CliError> {
    let data = if file == "-" {
        read_stdin()?.into_bytes()
    } else {
        std::fs::read(file).map_err(|e| CliError::Usage(format!("failed to read {file}: {e}")))?
    };
    let (headers, records) = parse_csv(&data)?;

    let dbs = client.db_list(None).await?;
    let dbs = dbs.as_array().cloned().unwrap_or_default();
    let group = project.clone().unwrap_or_else(infer_project_group);
    let existing = find_db(&dbs, db, &group)?.cloned();
    let existing_names: Vec<String> = existing
        .as_ref()
        .map(|d| columns_of(d).iter().map(|c| str_field(c, "name").to_string()).collect())
        .unwrap_or_default();
    let plan = plan_csv(&headers, title_col.as_deref(), &existing_names)?;

    let database = match existing {
        Some(database) => {
            if !plan.unknown.is_empty() {
                return usage(format!(
                    "CSV headers with no matching column in '{}': {} (add them with `offdesk db schema --add-col`)",
                    str_field(&database, "name"),
                    plan.unknown.join(", ")
                ));
            }
            database
        }
        None if create => {
            let columns: Vec<Value> = plan
                .unknown
                .iter()
                .map(|name| json!({ "name": name, "type": "text" }))
                .collect();
            let body = json!({ "name": db, "project_group": group, "columns": columns, "if_not_exists": true });
            client.db_create(&body).await?
        }
        None => {
            return usage(format!("no database matching '{db}' (pass --create to create it from the CSV)"));
        }
    };
    let db_id = str_field(&database, "id").to_string();

    let (rows, skipped) = build_import_rows(&records, &plan);
    if skipped > 0 {
        eprintln!("skipped {skipped} rows with an empty title");
    }
    let on_conflict = if new { "create" } else { "update" };
    let total_chunks = rows.len().div_ceil(IMPORT_CHUNK);
    let (mut created, mut updated) = (0u64, 0u64);
    for (i, chunk) in rows.chunks(IMPORT_CHUNK).enumerate() {
        let body = json!({ "rows": chunk, "on_conflict": on_conflict });
        let response = client.db_rows_batch(&db_id, &body).await.map_err(|e| {
            CliError::Protocol(format!(
                "import failed on chunk {}/{} ({created} created, {updated} updated so far): {e}",
                i + 1,
                total_chunks
            ))
        })?;
        created += response.get("created").and_then(Value::as_u64).unwrap_or(0);
        updated += response.get("updated").and_then(Value::as_u64).unwrap_or(0);
        eprintln!("imported {}/{} rows", ((i + 1) * IMPORT_CHUNK).min(rows.len()), rows.len());
    }
    if json {
        return print_json(&json!({
            "database_id": db_id,
            "created": created,
            "updated": updated,
            "skipped": skipped
        }));
    }
    out_line(&format!(
        "imported into \"{}\": {created} created, {updated} updated{}",
        str_field(&database, "name"),
        if skipped > 0 { format!(", {skipped} skipped") } else { String::new() }
    ));
    Ok(())
}

pub async fn export(
    client: &HubClient,
    db: &str,
    wheres: &[String],
    sorts: &[String],
    format: &str,
    output: Option<PathBuf>,
) -> Result<(), CliError> {
    if format != "csv" && format != "json" {
        return usage(format!("unknown --format '{format}': expected csv or json"));
    }
    let database = resolve_db(client, db, None).await?;
    let db_id = str_field(&database, "id").to_string();
    let mut all: Vec<Value> = Vec::new();
    loop {
        let body = build_query_body(wheres, sorts, None, Some(EXPORT_PAGE), Some(all.len()))?;
        let page = client.db_rows_query(&db_id, &body).await?;
        let rows = page.get("rows").and_then(Value::as_array).cloned().unwrap_or_default();
        let total = page.get("total").and_then(Value::as_u64).unwrap_or(0) as usize;
        let empty = rows.is_empty();
        all.extend(rows);
        if empty || all.len() >= total {
            break;
        }
    }
    let text = if format == "json" {
        json_pretty(&Value::Array(all.clone()))?
    } else {
        rows_to_csv(&database, &all)?
    };
    match output {
        Some(path) => {
            std::fs::write(&path, format!("{}\n", text.trim_end_matches('\n')))
                .map_err(|e| CliError::Usage(format!("failed to write {}: {e}", path.display())))?;
            eprintln!("exported {} rows to {}", all.len(), path.display());
        }
        None => out_line(text.trim_end_matches('\n')),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(items: &[&str]) -> Vec<String> {
        items.iter().map(|i| i.to_string()).collect()
    }

    #[test]
    fn col_spec_plain_and_options() {
        assert_eq!(parse_col_spec("Due:date").unwrap(), json!({"name":"Due","type":"date"}));
        assert_eq!(
            parse_col_spec("Status:select=todo, doing,done").unwrap(),
            json!({"name":"Status","type":"select","options":[{"name":"todo"},{"name":"doing"},{"name":"done"}]})
        );
        assert_eq!(
            parse_col_spec("Tags:MULTI_SELECT=a").unwrap()["type"],
            json!("multi_select")
        );
    }

    #[test]
    fn col_spec_errors() {
        assert!(parse_col_spec("nocolon").is_err());
        assert!(parse_col_spec("x:blob").is_err());
        assert!(parse_col_spec(":text").is_err());
        assert!(parse_col_spec("x:text=a,b").is_err());
        assert!(parse_col_spec("title:text").is_err());
    }

    #[test]
    fn where_every_operator() {
        let cases = [
            ("a=b", "eq", Some(json!("b"))),
            ("a!=b", "neq", Some(json!("b"))),
            ("a~b", "contains", Some(json!("b"))),
            ("a!~b", "not_contains", Some(json!("b"))),
            ("a>1", "gt", Some(json!(1))),
            ("a>=1", "gte", Some(json!(1))),
            ("a<1", "lt", Some(json!(1))),
            ("a<=1", "lte", Some(json!(1))),
            ("a:empty", "is_empty", None),
            ("a:not_empty", "is_not_empty", None),
        ];
        for (expr, op, value) in cases {
            let filter = parse_where(expr).unwrap();
            assert_eq!(filter["column"], json!("a"), "{expr}");
            assert_eq!(filter["op"], json!(op), "{expr}");
            match value {
                Some(v) => assert_eq!(filter["value"], v, "{expr}"),
                None => assert!(filter.get("value").is_none(), "{expr}"),
            }
        }
    }

    #[test]
    fn where_tricky_values() {
        let f = parse_where("url=https://a/b?x=1").unwrap();
        assert_eq!((f["column"].as_str(), f["op"].as_str(), f["value"].as_str()), (Some("url"), Some("eq"), Some("https://a/b?x=1")));
        let f = parse_where("name!=a=b").unwrap();
        assert_eq!((f["op"].as_str(), f["value"].as_str()), (Some("neq"), Some("a=b")));
        let f = parse_where("n>=10").unwrap();
        assert_eq!((f["op"].as_str(), f["value"].clone()), (Some("gte"), json!(10)));
        let f = parse_where("Due Date<2026-12-01").unwrap();
        assert_eq!((f["column"].as_str(), f["value"].as_str()), (Some("Due Date"), Some("2026-12-01")));
        assert_eq!(parse_where("done=true").unwrap()["value"], json!(true));
        assert_eq!(parse_where("a=").unwrap()["value"], json!(""));
        assert!(parse_where("novalue").is_err());
        assert!(parse_where("=x").is_err());
        assert!(parse_where(":empty").is_err());
    }

    #[test]
    fn sort_specs() {
        assert_eq!(parse_sort("due").unwrap(), json!({"column":"due","dir":"asc"}));
        assert_eq!(parse_sort("due:desc").unwrap(), json!({"column":"due","dir":"desc"}));
        assert_eq!(parse_sort("a:b").unwrap(), json!({"column":"a:b","dir":"asc"}));
        assert!(parse_sort(":asc").is_err());
    }

    #[test]
    fn set_parsing_and_typing() {
        assert_eq!(parse_set("n=5").unwrap(), ("n".to_string(), json!(5)));
        assert_eq!(parse_set("n=1.5").unwrap().1, json!(1.5));
        assert_eq!(parse_set("code=007").unwrap().1, json!("007"));
        assert_eq!(parse_set("done=false").unwrap().1, json!(false));
        assert_eq!(parse_set("tags=a,b").unwrap().1, json!("a,b"));
        assert_eq!(parse_set("note=a=b").unwrap().1, json!("a=b"));
        assert_eq!(parse_set("due=").unwrap().1, Value::Null);
        assert!(parse_set("novalue").is_err());
        assert!(parse_set("=x").is_err());
        let map = parse_sets(&s(&["a=1", "a=2", "b="])).unwrap();
        assert_eq!(map["a"], json!(2));
        assert!(map["b"].is_null());
    }

    #[test]
    fn query_body_shape() {
        let body = build_query_body(&s(&["s=todo"]), &s(&["due:desc"]), Some("fix"), Some(10), Some(20)).unwrap();
        assert_eq!(
            body,
            json!({"filters":[{"column":"s","op":"eq","value":"todo"}],"sorts":[{"column":"due","dir":"desc"}],"search":"fix","limit":10,"offset":20})
        );
        assert_eq!(build_query_body(&[], &[], None, None, None).unwrap(), json!({}));
    }

    #[test]
    fn csv_title_and_column_mapping() {
        let h = s(&["Status", "Name", "Due"]);
        let plan = plan_csv(&h, None, &s(&["status"])).unwrap();
        assert_eq!(plan.title_idx, 1);
        assert_eq!(plan.mapped, vec![(0, "status".to_string()), (2, "Due".to_string())]);
        assert_eq!(plan.unknown, s(&["Due"]));

        // No title/name header: first column; explicit --title-col wins.
        assert_eq!(plan_csv(&s(&["x", "y"]), None, &[]).unwrap().title_idx, 0);
        assert_eq!(plan_csv(&s(&["x", "y"]), Some("Y"), &[]).unwrap().title_idx, 1);
        assert_eq!(plan_csv(&s(&["name", "title"]), None, &[]).unwrap().title_idx, 1);
        assert!(plan_csv(&s(&["x"]), Some("nope"), &[]).is_err());
        assert!(plan_csv(&s(&["a", "A"]), None, &[]).is_err());
    }

    #[test]
    fn csv_rows_are_built_and_empty_cells_skipped() {
        let (headers, records) = parse_csv("\u{feff}name,status,note\n\"Fix, login\",todo,\nEmpty,,\n,x,y\n".as_bytes()).unwrap();
        assert_eq!(headers[0], "name");
        let plan = plan_csv(&headers, None, &s(&["status", "note"])).unwrap();
        let (rows, skipped) = build_import_rows(&records, &plan);
        assert_eq!(skipped, 1);
        assert_eq!(rows[0], json!({"title":"Fix, login","properties":{"status":"todo"}}));
        assert_eq!(rows[1], json!({"title":"Empty"}));
    }

    #[test]
    fn table_truncates_and_aligns() {
        assert_eq!(truncate_cell("abcdef", 4), "abc…");
        assert_eq!(truncate_cell("ab\ncd", 10), "ab cd");
        let table = render_table(
            &s(&["A", "BB"]),
            &[s(&["longvalue", "x"]), s(&["y", "0123456789"])],
            5,
        );
        let lines: Vec<&str> = table.lines().collect();
        assert_eq!(lines[0], "A      BB");
        assert_eq!(lines[1], "long…  x");
        assert_eq!(lines[2], "y      0123…");
    }

    #[test]
    fn db_lookup_prefers_group_then_name_then_id() {
        let dbs = vec![
            json!({"id":"aaaa1111","name":"Tasks","project_group":"p1"}),
            json!({"id":"bbbb2222","name":"tasks","project_group":"p2"}),
            json!({"id":"cccc3333","name":"Bugs","project_group":"p2"}),
        ];
        assert_eq!(str_field(find_db(&dbs, "tasks", "p2").unwrap().unwrap(), "id"), "bbbb2222");
        assert!(find_db(&dbs, "tasks", "other").is_err());
        assert_eq!(str_field(find_db(&dbs, "bugs", "p1").unwrap().unwrap(), "id"), "cccc3333");
        assert_eq!(str_field(find_db(&dbs, "cccc", "p1").unwrap().unwrap(), "name"), "Bugs");
        assert!(find_db(&dbs, "zzz", "p1").unwrap().is_none());
    }
}
