use std::collections::HashSet;

use offdesk_protocol::{
    MachineInfo, TerminalInfo, WorkspaceGroupInfo, WorkspaceLayoutInfo, WorkspaceLayoutNode,
    WorkspaceSplitDirection,
};

use crate::client::HubClient;
use crate::resolve::{resolve_machine, resolve_prefix};
use crate::CliError;

#[derive(Clone, Copy)]
pub enum Op {
    Equalize,
    Rotate,
}

impl Op {
    fn verb(self) -> &'static str {
        match self {
            Op::Equalize => "equalize",
            Op::Rotate => "rotate",
        }
    }

    fn apply(self, root: &WorkspaceLayoutNode) -> WorkspaceLayoutNode {
        match self {
            Op::Equalize => equalize(root),
            Op::Rotate => rotate(root),
        }
    }
}

/// Rewrite a group's layout through the hub, which publishes the change to
/// every open web client. Operates on the layout the web client renders (the
/// saved tree reconciled with the group's live terminals), not the raw row.
pub async fn run(
    client: &HubClient,
    op: Op,
    machine: Option<String>,
    group: &str,
    json: bool,
) -> Result<(), CliError> {
    let machine = resolve_layout_machine(client, machine.as_deref()).await?;

    let mut retried = false;
    loop {
        let groups = client.workspace_groups(&machine.id).await?;
        let group_key = resolve_group_key(&groups, group)?;
        let terminals = client.terminals().await?;
        let ids = group_terminal_ids(&terminals, &groups, &machine.id, &group_key);
        let layouts = client.workspace_layouts(&machine.id).await?;
        let saved = layouts.iter().find(|layout| layout.group_key == group_key);

        let root = effective_root(&ids, saved.and_then(|layout| layout.root.as_ref()))
            .ok_or_else(|| CliError::Usage(format!("group '{group}' has no terminals")))?;
        let next = op.apply(&root);
        if matches!(root, WorkspaceLayoutNode::Leaf { .. }) || next == root {
            let layout = WorkspaceLayoutInfo {
                machine_id: machine.id.clone(),
                group_key,
                root: Some(root),
                updated_at: saved.map_or(-1, |layout| layout.updated_at),
            };
            return report(json, false, op, group, &layout);
        }

        // The hub requires -1 as the base revision when no row exists yet.
        let base_updated_at = saved.map_or(-1, |layout| layout.updated_at);
        match client
            .save_workspace_layout(&machine.id, &group_key, &next, base_updated_at)
            .await?
        {
            Some(saved) => return report(json, true, op, group, &saved),
            None if !retried => retried = true,
            None => {
                return Err(CliError::Protocol(
                    "layout kept changing while saving; try again".to_string(),
                ))
            }
        }
    }
}

fn report(
    json: bool,
    changed: bool,
    op: Op,
    group: &str,
    layout: &WorkspaceLayoutInfo,
) -> Result<(), CliError> {
    if json {
        let value = serde_json::json!({ "changed": changed, "layout": layout });
        super::out_line(&super::json_pretty(&value)?);
    } else if changed {
        super::out_line(&format!("{}d layout of '{group}'", op.verb()));
    } else {
        super::out_line(&format!(
            "layout of '{group}' unchanged; nothing to {}",
            op.verb()
        ));
    }
    Ok(())
}

/// The explicit machine, or the only machine that has terminals.
async fn resolve_layout_machine(
    client: &HubClient,
    query: Option<&str>,
) -> Result<MachineInfo, CliError> {
    let machines = client.machines().await?;
    if let Some(query) = query {
        return resolve_machine(query, &machines).cloned();
    }
    let terminals = client.terminals().await?;
    let with_terminals: Vec<&MachineInfo> = machines
        .iter()
        .filter(|machine| terminals.iter().any(|t| t.machine_id == machine.id))
        .collect();
    match with_terminals.as_slice() {
        [only] => Ok((*only).clone()),
        [] => Err(CliError::Usage("no machine has terminals".to_string())),
        many => {
            let candidates = many
                .iter()
                .map(|machine| format!("  {}  {}", machine.id, machine.name))
                .collect::<Vec<_>>()
                .join("\n");
            Err(CliError::Usage(format!(
                "more than one machine has terminals; pass --machine:\n{candidates}"
            )))
        }
    }
}

/// `cwd:<path>` is already a layout key; anything else is a group name, or a
/// group id / unique id prefix. Tab names are not unique (every terminal
/// opened without a group gets its own auto tab named after its cwd), so a
/// name shared by several tabs is an error that lists their ids.
fn resolve_group_key(groups: &[WorkspaceGroupInfo], group: &str) -> Result<String, CliError> {
    if group.starts_with("cwd:") {
        return Ok(group.to_string());
    }
    let named: Vec<&WorkspaceGroupInfo> = groups
        .iter()
        .filter(|candidate| candidate.name == group)
        .collect();
    match named.as_slice() {
        [only] => Ok(only.id.clone()),
        [] => resolve_prefix(group, groups, |candidate| candidate.id.as_str())
            .map(|candidate| candidate.id.clone())
            .map_err(|_| CliError::Usage(format!("no workspace group named '{group}'"))),
        many => {
            let candidates = many
                .iter()
                .map(|candidate| format!("  {}", candidate.id))
                .collect::<Vec<_>>()
                .join("\n");
            Err(CliError::Usage(format!(
                "more than one workspace group is named '{group}'; pass its id:\n{candidates}"
            )))
        }
    }
}

/// Terminals of a group in hub list order, as the web client groups them: a
/// group id claims its terminals; a `cwd:<path>` key takes the terminals
/// whose cwd matches and that no known group claims.
fn group_terminal_ids(
    terminals: &[TerminalInfo],
    groups: &[WorkspaceGroupInfo],
    machine_id: &str,
    group_key: &str,
) -> Vec<String> {
    let cwd = group_key.strip_prefix("cwd:");
    terminals
        .iter()
        .filter(|terminal| terminal.machine_id == machine_id)
        .filter(|terminal| match cwd {
            Some(cwd) => {
                terminal.cwd == cwd
                    && !terminal
                        .workspace_group_id
                        .as_deref()
                        .is_some_and(|id| groups.iter().any(|group| group.id == id))
            }
            None => terminal.workspace_group_id.as_deref() == Some(group_key),
        })
        .map(|terminal| terminal.id.clone())
        .collect()
}

/// The layout the web client renders for a group: the saved tree stripped of
/// dead and duplicate panes, every other terminal appended, or an even tiling
/// when nothing usable was saved (`restorePaneLayout`).
pub fn effective_root(
    terminal_ids: &[String],
    saved: Option<&WorkspaceLayoutNode>,
) -> Option<WorkspaceLayoutNode> {
    let available: HashSet<&str> = terminal_ids.iter().map(String::as_str).collect();
    let mut consumed = HashSet::new();
    let Some(mut root) = saved.and_then(|node| sanitize(node, &available, &mut consumed, 0)) else {
        return tile(terminal_ids);
    };
    for id in terminal_ids {
        if consumed.insert(id.as_str()) {
            root = append(root, leaf(id));
        }
    }
    Some(root)
}

fn leaf(id: &str) -> WorkspaceLayoutNode {
    WorkspaceLayoutNode::Leaf {
        terminal_id: id.to_string(),
    }
}

fn sanitize<'a>(
    node: &'a WorkspaceLayoutNode,
    available: &HashSet<&str>,
    consumed: &mut HashSet<&'a str>,
    depth: usize,
) -> Option<WorkspaceLayoutNode> {
    if depth > 64 {
        return None;
    }
    match node {
        WorkspaceLayoutNode::Leaf { terminal_id } => {
            if !available.contains(terminal_id.as_str()) || !consumed.insert(terminal_id) {
                return None;
            }
            Some(leaf(terminal_id))
        }
        WorkspaceLayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => {
            let first = sanitize(first, available, consumed, depth + 1);
            let second = sanitize(second, available, consumed, depth + 1);
            match (first, second) {
                (Some(first), Some(second)) => Some(WorkspaceLayoutNode::Split {
                    direction: direction.clone(),
                    ratio: normalize_split_ratio(*ratio),
                    first: Box::new(first),
                    second: Box::new(second),
                }),
                (first, second) => first.or(second),
            }
        }
    }
}

/// Add a pane as a new rightmost column; the existing columns scale down
/// uniformly so appending one by one converges on even columns.
fn append(root: WorkspaceLayoutNode, inserted: WorkspaceLayoutNode) -> WorkspaceLayoutNode {
    let columns = column_count(&root) as f64;
    WorkspaceLayoutNode::Split {
        direction: WorkspaceSplitDirection::Horizontal,
        ratio: normalize_split_ratio(columns / (columns + 1.0)),
        first: Box::new(root),
        second: Box::new(inserted),
    }
}

/// Horizontal chain where every pane gets width 1/n.
fn tile(ids: &[String]) -> Option<WorkspaceLayoutNode> {
    match ids {
        [] => None,
        [only] => Some(leaf(only)),
        [first, rest @ ..] => Some(WorkspaceLayoutNode::Split {
            direction: WorkspaceSplitDirection::Horizontal,
            ratio: normalize_split_ratio(1.0 / ids.len() as f64),
            first: Box::new(leaf(first)),
            second: Box::new(tile(rest)?),
        }),
    }
}

/// Rebalance every split so sibling subtrees take space in proportion to
/// their column/row counts (tmux `select-layout -E`). Structure, pane order
/// and directions are preserved; only ratios move.
pub fn equalize(node: &WorkspaceLayoutNode) -> WorkspaceLayoutNode {
    let WorkspaceLayoutNode::Split {
        direction,
        first,
        second,
        ..
    } = node
    else {
        return node.clone();
    };
    let first = equalize(first);
    let second = equalize(second);
    let ratio = match direction {
        WorkspaceSplitDirection::Horizontal => {
            column_count(&first) as f64 / (column_count(&first) + column_count(&second)) as f64
        }
        WorkspaceSplitDirection::Vertical => {
            row_count(&first) as f64 / (row_count(&first) + row_count(&second)) as f64
        }
    };
    WorkspaceLayoutNode::Split {
        direction: direction.clone(),
        ratio: normalize_split_ratio(ratio),
        first: Box::new(first),
        second: Box::new(second),
    }
}

/// Flip every split between side-by-side and stacked, keeping pane order and
/// ratios.
pub fn rotate(node: &WorkspaceLayoutNode) -> WorkspaceLayoutNode {
    match node {
        WorkspaceLayoutNode::Leaf { .. } => node.clone(),
        WorkspaceLayoutNode::Split {
            direction,
            ratio,
            first,
            second,
        } => WorkspaceLayoutNode::Split {
            direction: match direction {
                WorkspaceSplitDirection::Horizontal => WorkspaceSplitDirection::Vertical,
                WorkspaceSplitDirection::Vertical => WorkspaceSplitDirection::Horizontal,
            },
            ratio: *ratio,
            first: Box::new(rotate(first)),
            second: Box::new(rotate(second)),
        },
    }
}

fn normalize_split_ratio(ratio: f64) -> f64 {
    if !ratio.is_finite() {
        return 0.5;
    }
    ratio.clamp(0.05, 0.95)
}

/// Side-by-side columns a subtree occupies: a horizontal split stacks its
/// children's columns; anything else is a single column.
fn column_count(node: &WorkspaceLayoutNode) -> usize {
    match node {
        WorkspaceLayoutNode::Split {
            direction: WorkspaceSplitDirection::Horizontal,
            first,
            second,
            ..
        } => column_count(first) + column_count(second),
        _ => 1,
    }
}

/// Symmetric to `column_count` for stacked rows.
fn row_count(node: &WorkspaceLayoutNode) -> usize {
    match node {
        WorkspaceLayoutNode::Split {
            direction: WorkspaceSplitDirection::Vertical,
            first,
            second,
            ..
        } => row_count(first) + row_count(second),
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WorkspaceSplitDirection::{Horizontal, Vertical};

    fn group(id: &str, name: &str) -> WorkspaceGroupInfo {
        WorkspaceGroupInfo {
            id: id.to_string(),
            machine_id: "m".to_string(),
            name: name.to_string(),
            sort_order: 0,
        }
    }

    #[test]
    fn group_key_resolves_names_ids_and_rejects_shared_names() {
        let groups = [
            group("aaa-1", "repo"),
            group("bbb-1", "var"),
            group("bbb-2", "var"),
        ];
        assert_eq!(resolve_group_key(&groups, "repo").unwrap(), "aaa-1");
        assert_eq!(resolve_group_key(&groups, "bbb-2").unwrap(), "bbb-2");
        assert_eq!(resolve_group_key(&groups, "aaa").unwrap(), "aaa-1");
        assert_eq!(resolve_group_key(&groups, "cwd:/x").unwrap(), "cwd:/x");
        let shared = resolve_group_key(&groups, "var").unwrap_err().to_string();
        assert!(
            shared.contains("bbb-1") && shared.contains("bbb-2"),
            "{shared}"
        );
        assert!(resolve_group_key(&groups, "nope").is_err());
    }

    fn leaf(id: &str) -> WorkspaceLayoutNode {
        WorkspaceLayoutNode::Leaf {
            terminal_id: id.to_string(),
        }
    }

    fn split(
        direction: WorkspaceSplitDirection,
        ratio: f64,
        first: WorkspaceLayoutNode,
        second: WorkspaceLayoutNode,
    ) -> WorkspaceLayoutNode {
        WorkspaceLayoutNode::Split {
            direction,
            ratio,
            first: Box::new(first),
            second: Box::new(second),
        }
    }

    /// Fraction of the total width each leaf gets (horizontal splits only).
    fn leaf_widths(node: &WorkspaceLayoutNode, share: f64, out: &mut Vec<(String, f64)>) {
        match node {
            WorkspaceLayoutNode::Leaf { terminal_id } => out.push((terminal_id.clone(), share)),
            WorkspaceLayoutNode::Split {
                ratio,
                first,
                second,
                ..
            } => {
                leaf_widths(first, share * ratio, out);
                leaf_widths(second, share * (1.0 - ratio), out);
            }
        }
    }

    #[test]
    fn equalizes_a_degenerate_append_chain_back_to_even_columns() {
        // ((A|B)|C)|D with every split 0.5 gives 1/8,1/8,1/4,1/2.
        let chain = split(
            Horizontal,
            0.5,
            split(
                Horizontal,
                0.5,
                split(Horizontal, 0.5, leaf("a"), leaf("b")),
                leaf("c"),
            ),
            leaf("d"),
        );

        let root = equalize(&chain);

        let mut widths = Vec::new();
        leaf_widths(&root, 1.0, &mut widths);
        let ids: Vec<&str> = widths.iter().map(|(id, _)| id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d"]);
        for (_, width) in &widths {
            assert!((width - 0.25).abs() < 1e-9, "{widths:?}");
        }
        // Structure and direction are preserved: ratios 1/2, 2/3, 3/4 inside-out.
        let expected = split(
            Horizontal,
            0.75,
            split(
                Horizontal,
                2.0 / 3.0,
                split(Horizontal, 0.5, leaf("a"), leaf("b")),
                leaf("c"),
            ),
            leaf("d"),
        );
        assert_eq!(root, expected);
    }

    #[test]
    fn equalizes_a_mixed_tree_without_changing_its_structure() {
        let tree = split(
            Horizontal,
            0.8,
            leaf("a"),
            split(Vertical, 0.3, leaf("b"), leaf("c")),
        );
        let expected = split(
            Horizontal,
            0.5,
            leaf("a"),
            split(Vertical, 0.5, leaf("b"), leaf("c")),
        );
        assert_eq!(equalize(&tree), expected);
    }

    #[test]
    fn equalizes_rows_when_the_outer_split_is_vertical() {
        let tree = split(
            Vertical,
            0.9,
            split(Horizontal, 0.1, leaf("a"), leaf("b")),
            leaf("c"),
        );
        let expected = split(
            Vertical,
            0.5,
            split(Horizontal, 0.5, leaf("a"), leaf("b")),
            leaf("c"),
        );
        assert_eq!(equalize(&tree), expected);
    }

    #[test]
    fn equalize_leaves_a_single_pane_untouched() {
        assert_eq!(equalize(&leaf("a")), leaf("a"));
    }

    #[test]
    fn equalize_is_idempotent() {
        let tree = split(
            Horizontal,
            0.2,
            split(Horizontal, 0.9, leaf("a"), leaf("b")),
            leaf("c"),
        );
        let once = equalize(&tree);
        assert_eq!(equalize(&once), once);
    }

    #[test]
    fn rotates_a_two_pane_stacked_layout_to_side_by_side() {
        let stacked = split(Vertical, 0.5, leaf("a"), leaf("b"));
        assert_eq!(
            rotate(&stacked),
            split(Horizontal, 0.5, leaf("a"), leaf("b"))
        );
    }

    #[test]
    fn rotate_flips_every_direction_preserving_order_and_ratios() {
        let tree = split(
            Vertical,
            0.3,
            split(Horizontal, 0.7, leaf("a"), leaf("c")),
            leaf("b"),
        );
        let expected = split(
            Horizontal,
            0.3,
            split(Vertical, 0.7, leaf("a"), leaf("c")),
            leaf("b"),
        );
        assert_eq!(rotate(&tree), expected);
    }

    #[test]
    fn rotate_is_a_no_op_for_a_single_pane() {
        assert_eq!(rotate(&leaf("a")), leaf("a"));
    }

    fn ids(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn effective_root_tiles_when_nothing_is_saved() {
        let root = effective_root(&ids(&["a", "b", "c"]), None).unwrap();
        let expected = split(
            Horizontal,
            1.0 / 3.0,
            leaf("a"),
            split(Horizontal, 0.5, leaf("b"), leaf("c")),
        );
        assert_eq!(root, expected);
        assert_eq!(effective_root(&ids(&["a"]), None), Some(leaf("a")));
        assert_eq!(effective_root(&[], None), None);
    }

    #[test]
    fn effective_root_drops_dead_leaves_and_collapses_the_split() {
        let saved = split(
            Horizontal,
            0.3,
            leaf("a"),
            split(Vertical, 0.9, leaf("dead"), leaf("c")),
        );
        let root = effective_root(&ids(&["a", "c"]), Some(&saved)).unwrap();
        assert_eq!(root, split(Horizontal, 0.3, leaf("a"), leaf("c")));
    }

    #[test]
    fn effective_root_appends_new_terminals_with_even_column_ratio() {
        let saved = split(Horizontal, 0.5, leaf("a"), leaf("b"));
        let root = effective_root(&ids(&["a", "b", "c"]), Some(&saved)).unwrap();
        assert_eq!(
            root,
            split(
                Horizontal,
                2.0 / 3.0,
                split(Horizontal, 0.5, leaf("a"), leaf("b")),
                leaf("c")
            )
        );
    }

    #[test]
    fn effective_root_drops_duplicate_leaves() {
        let saved = split(Horizontal, 0.5, leaf("a"), leaf("a"));
        assert_eq!(effective_root(&ids(&["a"]), Some(&saved)), Some(leaf("a")));
    }

    #[test]
    fn effective_root_clamps_ratios_and_retiles_when_all_leaves_are_dead() {
        let saved = split(Horizontal, 2.0, leaf("a"), leaf("b"));
        let root = effective_root(&ids(&["a", "b"]), Some(&saved)).unwrap();
        assert_eq!(root, split(Horizontal, 0.95, leaf("a"), leaf("b")));

        let stale = split(Horizontal, 0.5, leaf("x"), leaf("y"));
        let root = effective_root(&ids(&["a", "b"]), Some(&stale)).unwrap();
        assert_eq!(root, split(Horizontal, 0.5, leaf("a"), leaf("b")));
    }
}
