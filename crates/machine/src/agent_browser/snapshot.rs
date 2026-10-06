//! Accessibility tree (`Accessibility.getFullAXTree`) -> agent-facing text.
//!
//! The output is modelled on Playwright's aria snapshot: one line per
//! meaningful node, indented by depth, with `[ref=eN]` on interactive nodes.

use serde_json::Value;
use std::collections::HashMap;

pub const MAX_SNAPSHOT_BYTES: usize = 60 * 1024;

const INTERACTIVE_ROLES: &[&str] = &[
    "link",
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "tab",
    "slider",
    "spinbutton",
    "listbox",
];

/// Roles that carry a live `value` worth showing.
const VALUE_ROLES: &[&str] = &["textbox", "searchbox", "combobox", "slider", "spinbutton"];

pub struct SnapshotResult {
    pub text: String,
    /// `eN` -> backendDOMNodeId, in assignment order.
    pub refs: Vec<(String, i64)>,
}

struct Ctx<'a> {
    by_id: HashMap<&'a str, &'a Value>,
    lines: Vec<String>,
    size: usize,
    refs: Vec<(String, i64)>,
    truncated: bool,
}

fn str_of<'a>(node: &'a Value, field: &str) -> &'a str {
    node.get(field)
        .and_then(|v| v.get("value"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn role_of(node: &Value) -> &str {
    str_of(node, "role")
}

fn is_ignored(node: &Value) -> bool {
    node.get("ignored")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn prop<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("properties")?
        .as_array()?
        .iter()
        .find(|p| p.get("name").and_then(Value::as_str) == Some(name))
        .and_then(|p| p.get("value"))
        .and_then(|v| v.get("value"))
}

fn prop_text(node: &Value, name: &str) -> Option<String> {
    match prop(node, name)? {
        Value::Bool(b) => Some(b.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn prop_true(node: &Value, name: &str) -> bool {
    prop_text(node, name).as_deref() == Some("true")
}

/// A node that only wraps its children and adds nothing of its own.
fn is_transparent(node: &Value) -> bool {
    if is_ignored(node) {
        return true;
    }
    let role = role_of(node);
    matches!(
        role,
        "generic"
            | "none"
            | "presentation"
            | "GenericContainer"
            | "RootWebArea"
            | "WebArea"
            | "InlineTextBox"
            | "ListMarker"
            | "LineBreak"
    ) && (role == "RootWebArea"
        || role == "WebArea"
        || role == "InlineTextBox"
        || role == "ListMarker"
        || role == "LineBreak"
        || norm(str_of(node, "name")).is_empty())
}

enum Item<'a> {
    Text(String),
    Node(&'a Value),
}

impl<'a> Ctx<'a> {
    fn children(&self, node: &Value) -> Vec<&'a Value> {
        node.get("childIds")
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str())
                    .filter_map(|id| self.by_id.get(id).copied())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Expand transparent wrappers and merge consecutive static text runs.
    fn items(&self, node: &Value) -> Vec<Item<'a>> {
        let mut flat: Vec<&'a Value> = Vec::new();
        self.flatten(node, &mut flat);
        let mut out: Vec<Item<'a>> = Vec::new();
        for n in flat {
            if role_of(n) == "StaticText" {
                let t = norm(str_of(n, "name"));
                if t.is_empty() {
                    continue;
                }
                if let Some(Item::Text(prev)) = out.last_mut() {
                    // Chrome splits text at line boxes; adjacent runs are
                    // already whitespace-separated in practice.
                    if !prev.ends_with(' ') {
                        prev.push(' ');
                    }
                    prev.push_str(&t);
                } else {
                    out.push(Item::Text(t));
                }
            } else {
                out.push(Item::Node(n));
            }
        }
        out
    }

    fn flatten(&self, node: &Value, out: &mut Vec<&'a Value>) {
        for child in self.children(node) {
            if role_of(child) == "StaticText" && !is_ignored(child) {
                out.push(child);
            } else if is_transparent(child) {
                self.flatten(child, out);
            } else {
                out.push(child);
            }
        }
    }

    fn push(&mut self, depth: usize, line: String) {
        if self.truncated {
            return;
        }
        let line = format!("{}{}", "  ".repeat(depth), line);
        if self.size + line.len() + 1 > MAX_SNAPSHOT_BYTES {
            self.truncated = true;
            return;
        }
        self.size += line.len() + 1;
        self.lines.push(line);
    }

    fn render_items(&mut self, items: Vec<Item<'a>>, depth: usize, parent_name: &str) {
        let parent_name = norm(parent_name);
        for item in items {
            match item {
                Item::Text(t) => {
                    // Text already folded into the parent's accessible name.
                    if !parent_name.is_empty() && parent_name.contains(&t) {
                        continue;
                    }
                    self.push(depth, format!("- text: {t}"));
                }
                Item::Node(n) => self.render_node(n, depth),
            }
        }
    }

    fn render_node(&mut self, node: &'a Value, depth: usize) {
        if self.truncated {
            return;
        }
        let role = role_of(node).to_string();
        let name = norm(str_of(node, "name"));
        let items = self.items(node);

        let mut line = format!("- {role}");
        if !name.is_empty() {
            line.push_str(&format!(" \"{}\"", name.replace('"', "\\\"")));
        }
        if let Some(level) = prop_text(node, "level") {
            line.push_str(&format!(" [level={level}]"));
        }
        if INTERACTIVE_ROLES.contains(&role.as_str()) {
            if let Some(backend) = node.get("backendDOMNodeId").and_then(Value::as_i64) {
                let r = format!("e{}", self.refs.len() + 1);
                line.push_str(&format!(" [ref={r}]"));
                self.refs.push((r, backend));
            }
        }
        match prop_text(node, "checked").as_deref() {
            Some("true") => line.push_str(" [checked]"),
            Some("mixed") => line.push_str(" [checked=mixed]"),
            _ => {}
        }
        if prop_true(node, "disabled") {
            line.push_str(" [disabled]");
        }
        match prop_text(node, "expanded").as_deref() {
            Some("true") => line.push_str(" [expanded]"),
            Some("false") => line.push_str(" [expanded=false]"),
            _ => {}
        }
        if prop_true(node, "selected") {
            line.push_str(" [selected]");
        }
        if prop_true(node, "pressed") {
            line.push_str(" [pressed]");
        }
        if VALUE_ROLES.contains(&role.as_str()) {
            let value = str_of(node, "value");
            if !value.is_empty() {
                line.push_str(&format!(" value=\"{}\"", value.replace('"', "\\\"")));
            }
        }

        // A lone text child of an unnamed node reads best inline.
        if name.is_empty() && items.len() == 1 && matches!(items[0], Item::Text(_)) {
            if let Some(Item::Text(t)) = items.into_iter().next() {
                line.push_str(&format!(": {t}"));
                self.push(depth, line);
            }
            return;
        }
        self.push(depth, line);
        self.render_items(items, depth + 1, &name);
    }
}

/// Convert the `nodes` array of `Accessibility.getFullAXTree` to text.
pub fn ax_tree_to_text(nodes: &[Value]) -> SnapshotResult {
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for n in nodes {
        if let Some(id) = n.get("nodeId").and_then(Value::as_str) {
            by_id.insert(id, n);
        }
    }
    let mut ctx = Ctx {
        by_id,
        lines: Vec::new(),
        size: 0,
        refs: Vec::new(),
        truncated: false,
    };
    let root = nodes
        .iter()
        .find(|n| n.get("parentId").is_none())
        .or_else(|| nodes.first());
    if let Some(root) = root {
        // The root is itself transparent (RootWebArea); render its content.
        let items = ctx.items(root);
        ctx.render_items(items, 0, "");
    }
    let mut text = ctx.lines.join("\n");
    if ctx.truncated {
        text.push_str("\n… (truncated)");
    }
    SnapshotResult {
        text,
        refs: ctx.refs,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn val(t: &str, v: Value) -> Value {
        json!({"type": t, "value": v})
    }

    fn node(
        id: &str,
        parent: Option<&str>,
        role: &str,
        name: &str,
        children: &[&str],
        backend: i64,
    ) -> Value {
        let mut n = json!({
            "nodeId": id,
            "ignored": false,
            "role": val("role", json!(role)),
            "name": val("computedString", json!(name)),
            "childIds": children,
            "backendDOMNodeId": backend,
        });
        if let Some(p) = parent {
            n["parentId"] = json!(p);
        }
        n
    }

    fn fixture() -> Vec<Value> {
        let mut heading = node("3", Some("2"), "heading", "Example Domain", &["4"], 13);
        heading["properties"] = json!([{"name": "level", "value": val("integer", json!(1))}]);
        let mut textbox = node("9", Some("2"), "textbox", "Search", &[], 20);
        textbox["value"] = val("string", json!("foo"));
        let mut checkbox = node("10", Some("2"), "checkbox", "Remember me", &[], 21);
        checkbox["properties"] = json!([
            {"name": "checked", "value": val("tristate", json!("true"))},
            {"name": "disabled", "value": val("boolean", json!(true))}
        ]);
        let mut ignored = node("11", Some("2"), "none", "", &["12"], 22);
        ignored["ignored"] = json!(true);
        vec![
            node("1", None, "RootWebArea", "Page", &["2"], 1),
            node(
                "2",
                Some("1"),
                "generic",
                "",
                &["3", "5", "7", "9", "10", "11"],
                2,
            ),
            heading,
            node("4", Some("3"), "StaticText", "Example Domain", &["x"], 14),
            node("5", Some("2"), "paragraph", "", &["6"], 15),
            node(
                "6",
                Some("5"),
                "StaticText",
                "This domain is for use in examples.",
                &[],
                16,
            ),
            node("7", Some("2"), "link", "More information...", &["8"], 17),
            node("8", Some("7"), "StaticText", "More information...", &[], 18),
            textbox,
            checkbox,
            ignored,
            node("12", Some("11"), "button", "Go", &[], 23),
            // A text node that is not reachable must not show up.
            node("x", Some("4"), "InlineTextBox", "Example Domain", &[], 99),
        ]
    }

    #[test]
    fn converts_fixture() {
        let res = ax_tree_to_text(&fixture());
        let expected = [
            "- heading \"Example Domain\" [level=1]",
            "- paragraph: This domain is for use in examples.",
            "- link \"More information...\" [ref=e1]",
            "- textbox \"Search\" [ref=e2] value=\"foo\"",
            "- checkbox \"Remember me\" [ref=e3] [checked] [disabled]",
            "- button \"Go\" [ref=e4]",
        ]
        .join("\n");
        assert_eq!(res.text, expected);
        assert_eq!(
            res.refs,
            vec![
                ("e1".to_string(), 17),
                ("e2".to_string(), 20),
                ("e3".to_string(), 21),
                ("e4".to_string(), 23)
            ]
        );
    }

    #[test]
    fn nested_children_are_indented() {
        let nodes = vec![
            node("1", None, "RootWebArea", "", &["2"], 1),
            node("2", Some("1"), "list", "", &["3"], 2),
            node("3", Some("2"), "listitem", "", &["4", "5"], 3),
            node("4", Some("3"), "StaticText", "See", &[], 4),
            node("5", Some("3"), "link", "docs", &[], 5),
        ];
        let res = ax_tree_to_text(&nodes);
        assert_eq!(
            res.text,
            "- list\n  - listitem\n    - text: See\n    - link \"docs\" [ref=e1]"
        );
    }

    #[test]
    fn truncates_large_output() {
        let mut nodes = vec![node("0", None, "RootWebArea", "", &[], 1)];
        let mut ids = Vec::new();
        for i in 1..=5000 {
            ids.push(i.to_string());
            nodes.push(node(
                &i.to_string(),
                Some("0"),
                "paragraph",
                &format!("para number {i} {}", "x".repeat(40)),
                &[],
                100 + i,
            ));
        }
        nodes[0]["childIds"] = json!(ids);
        let res = ax_tree_to_text(&nodes);
        assert!(res.text.ends_with("… (truncated)"));
        assert!(res.text.len() <= MAX_SNAPSHOT_BYTES + 32);
    }

    #[test]
    fn empty_tree_is_empty() {
        assert_eq!(ax_tree_to_text(&[]).text, "");
    }
}
