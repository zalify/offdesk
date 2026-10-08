use std::collections::HashMap;
use std::time::Duration;

use futures::StreamExt;
use serde_json::{json, Value};
use offdesk_protocol::{MachineInfo, TerminalInfo};

use super::read::ReadOptions;
use crate::attach;
use crate::client::{ForegroundProcessInfo, HubClient};
use crate::config::ResolvedConfig;
use crate::resolve::{resolve_prefix, short_id};
use crate::CliError;

/// What a successful capture knows about one terminal.
#[derive(Debug)]
struct Capture {
    /// Screen contents, sanitized and blank-trimmed.
    screen: String,
    /// "active" / "quiet" / "idle", observed during the capture window only.
    activity: &'static str,
    /// Milliseconds between the last received byte and capture end.
    idle_ms: Option<u64>,
    /// Foreground process info; `None` when the lookup failed (never fatal).
    foreground_process: Option<ForegroundProcessInfo>,
}

/// What happened to one terminal in the batch.
#[derive(Debug)]
enum Outcome {
    /// Screen captured and trimmed.
    Screen(Capture),
    /// Reachable but the capture failed (WS close, hub error frame).
    Error(String),
    /// Machine offline — never attached.
    Unreachable,
}

/// One row of the batch result: the listing entry plus its outcome.
/// `group` is the workspace group name as derived by `ls` (None when the
/// terminal is not grouped).
struct BatchEntry {
    terminal: TerminalInfo,
    group: Option<String>,
    outcome: Outcome,
}

/// Capture every terminal (optionally filtered to one machine) and print all
/// screens in REST listing order. Per-terminal failures are data, not errors:
/// only systemic failures (auth, REST down) make the batch itself fail.
pub async fn run(
    client: &HubClient,
    config: &ResolvedConfig,
    options: ReadOptions,
) -> Result<(), CliError> {
    let mut terminals = client.terminals().await?;
    if let Some(query) = &options.machine {
        let machines = client.machines().await?;
        retain_machine(&mut terminals, &machines, query)?;
    }
    let group_names = super::fetch_group_names(client, &terminals).await?;

    let quiet = Duration::from_millis(options.quiet_ms);
    let timeout = (options.timeout_secs > 0).then(|| Duration::from_secs(options.timeout_secs));
    let concurrency = options.concurrency.max(1);

    // Attach to reachable terminals with bounded concurrency; results come
    // back unordered, so index them and re-emit in listing order. The
    // foreground-process lookup rides along in the same stage.
    let mut captures: HashMap<usize, Outcome> = futures::stream::iter(
        terminals
            .iter()
            .enumerate()
            .filter(|(_, terminal)| terminal.reachable),
    )
    .map(|(index, terminal)| async move {
        let outcome = match capture_screen(config, client, terminal, quiet, timeout).await {
            Ok(capture) => Outcome::Screen(capture),
            Err(error) => Outcome::Error(error.to_string()),
        };
        (index, outcome)
    })
    .buffer_unordered(concurrency)
    .collect()
    .await;

    let entries: Vec<BatchEntry> = terminals
        .into_iter()
        .enumerate()
        .map(|(index, terminal)| {
            let group = super::group_label(&terminal, &group_names);
            BatchEntry {
                // Only reachable terminals were attached; a missing capture
                // outcome means the terminal was skipped as unreachable.
                outcome: captures.remove(&index).unwrap_or(Outcome::Unreachable),
                terminal,
                group,
            }
        })
        .collect();
    let skipped = entries
        .iter()
        .filter(|entry| matches!(entry.outcome, Outcome::Unreachable))
        .count();

    if options.json {
        let output = json_output(
            &entries,
            options.lines,
            options.include_unreachable,
            skipped,
        );
        super::out_line(&super::json_pretty(&output)?);
    } else {
        let text = render_text(&entries, options.lines);
        if !text.is_empty() {
            super::out_line(&text);
        }
    }
    if skipped > 0 {
        eprintln!("skipped {skipped} unreachable terminals");
    }
    Ok(())
}

/// Keep only terminals on the machine resolved from `query` (id or prefix).
fn retain_machine(
    terminals: &mut Vec<TerminalInfo>,
    machines: &[MachineInfo],
    query: &str,
) -> Result<(), CliError> {
    let resolved = resolve_prefix(query, machines, |machine| machine.id.as_str())?;
    terminals.retain(|terminal| terminal.machine_id == resolved.id);
    Ok(())
}

/// Capture one reachable terminal's screen — sanitized, blank-trimmed, and
/// annotated with activity data — plus its foreground process (best-effort:
/// a failed lookup yields `None`, it never fails the batch).
async fn capture_screen(
    config: &ResolvedConfig,
    client: &HubClient,
    terminal: &TerminalInfo,
    quiet: Duration,
    timeout: Option<Duration>,
) -> Result<Capture, CliError> {
    let (cols, rows) = super::terminal_dimensions(terminal);
    let target = attach::Target {
        config,
        machine_id: &terminal.machine_id,
        terminal_id: &terminal.id,
        device_id: format!("cli-read-{}-{}", std::process::id(), short_id(&terminal.id)),
        cols,
        rows,
    };
    let report = attach::capture(&target, quiet, timeout).await?;
    let foreground_process = client
        .foreground_process(&terminal.machine_id, &terminal.id)
        .await
        .ok();
    let sanitized = attach::sanitize_screen(&report.screen.contents());
    Ok(Capture {
        screen: attach::trim_trailing_blank_lines(&sanitized),
        activity: attach::classify_activity(report.end_reason, report.last_byte_age_ms, quiet),
        idle_ms: report.last_byte_age_ms,
        foreground_process,
    })
}

/// `shortid · [group · ] cwd` — the shared label for text-mode rows.
fn label(entry: &BatchEntry) -> String {
    let mut parts = vec![short_id(&entry.terminal.id).to_string()];
    if let Some(group) = &entry.group {
        parts.push(group.clone());
    }
    parts.push(entry.terminal.cwd.clone());
    parts.join(" · ")
}

/// Text mode: one `== header ==` section per captured terminal and one-line
/// `-- row --` for skipped/failed ones, sections separated by a blank line.
fn render_text(entries: &[BatchEntry], lines: Option<usize>) -> String {
    let mut sections = Vec::new();
    for entry in entries {
        let section = match &entry.outcome {
            Outcome::Screen(capture) => {
                let (cols, rows) = super::terminal_dimensions(&entry.terminal);
                let body = match lines {
                    Some(count) => attach::last_n_lines(&capture.screen, count),
                    None => capture.screen.clone(),
                };
                format!("== {} · {cols}x{rows} ==\n{body}", label(entry))
            }
            Outcome::Error(message) => {
                format!(
                    "-- {} · error: {} --",
                    label(entry),
                    message.replace('\n', " ")
                )
            }
            Outcome::Unreachable => format!("-- {} · skipped (unreachable) --", label(entry)),
        };
        sections.push(section);
    }
    sections.join("\n\n")
}

/// Top-level JSON: reachable entries only by default (unreachable ones are
/// reported as `skipped_unreachable_count`); `--include-unreachable` puts
/// their `{"error":"unreachable"}` entries back.
fn json_output(
    entries: &[BatchEntry],
    lines: Option<usize>,
    include_unreachable: bool,
    skipped_unreachable: usize,
) -> Value {
    let terminals: Vec<Value> = entries
        .iter()
        .filter(|entry| include_unreachable || !matches!(entry.outcome, Outcome::Unreachable))
        .map(|entry| entry_json(entry, lines))
        .collect();
    json!({
        "terminals": terminals,
        "skipped_unreachable_count": skipped_unreachable,
    })
}

/// JSON entry: full screen data plus activity fields on success, an `error`
/// field otherwise. All strings from terminal content or machine data are
/// sanitized.
fn entry_json(entry: &BatchEntry, lines: Option<usize>) -> Value {
    let terminal = &entry.terminal;
    // `pane_title` is the stored title from the listing (rich OSC/task title
    // when the machine reports it, else the legacy one) — no extra calls.
    let title = attach::sanitize_screen(&terminal.title);
    let mut value = json!({
        "id": terminal.id,
        "short_id": short_id(&terminal.id),
        "machine_id": terminal.machine_id,
        "title": title,
        "pane_title": title,
        "title_source": terminal.title_source,
        "group": entry.group.as_deref().map(attach::sanitize_screen),
        "cwd": attach::sanitize_screen(&terminal.cwd),
    });
    match &entry.outcome {
        Outcome::Screen(capture) => {
            let (cols, rows) = super::terminal_dimensions(terminal);
            let (screen, lines_total, truncated) = attach::apply_lines(&capture.screen, lines);
            value["cols"] = json!(cols);
            value["rows"] = json!(rows);
            value["screen"] = json!(screen);
            value["lines_total"] = json!(lines_total);
            value["truncated"] = json!(truncated);
            value["activity"] = json!(capture.activity);
            value["idle_ms"] = json!(capture.idle_ms);
            value["foreground_process"] = match &capture.foreground_process {
                Some(foreground) => json!({
                    "has_foreground_process": foreground.has_foreground_process,
                    "process_name": foreground.process_name.as_deref().map(attach::sanitize_screen),
                }),
                None => Value::Null,
            };
        }
        Outcome::Error(message) => value["error"] = json!(message),
        Outcome::Unreachable => value["error"] = json!("unreachable"),
    }
    value
}

#[cfg(test)]
mod tests {
    use super::{
        entry_json, json_output, render_text, retain_machine, BatchEntry, Capture, Outcome,
    };
    use serde_json::json;
    use offdesk_protocol::{MachineInfo, TerminalInfo, TerminalTitleSource};

    fn terminal(id: &str, machine_id: &str, cwd: &str) -> TerminalInfo {
        TerminalInfo {
            id: id.to_string(),
            machine_id: machine_id.to_string(),
            title: format!("title-{id}"),
            cwd: cwd.to_string(),
            title_source: Default::default(),
            workspace_group_id: None,
            cols: 107,
            rows: 59,
            attention: None,
            reachable: true,
        }
    }

    fn capture(screen: &str) -> Capture {
        Capture {
            screen: screen.to_string(),
            activity: "quiet",
            idle_ms: Some(500),
            foreground_process: None,
        }
    }

    fn entry(id: &str, group: Option<&str>, outcome: Outcome) -> BatchEntry {
        BatchEntry {
            terminal: terminal(&format!("{id}-rest-of-id"), "machine-1", "/home/user"),
            group: group.map(str::to_string),
            outcome,
        }
    }

    #[test]
    fn text_renders_captured_grouped_and_skipped_rows() {
        let entries = vec![
            entry(
                "54eb98a5",
                Some("tab 3"),
                Outcome::Screen(capture("screen one")),
            ),
            entry("3c361a41", None, Outcome::Screen(capture("screen two"))),
            entry("2bf50be0", None, Outcome::Unreachable),
        ];
        let text = render_text(&entries, None);
        assert_eq!(
            text,
            "== 54eb98a5 · tab 3 · /home/user · 107x59 ==\nscreen one\n\n\
             == 3c361a41 · /home/user · 107x59 ==\nscreen two\n\n\
             -- 2bf50be0 · /home/user · skipped (unreachable) --"
        );
    }

    #[test]
    fn text_renders_mid_capture_errors_as_one_line_rows() {
        let entries = vec![entry(
            "54eb98a5",
            None,
            Outcome::Error("websocket closed\nmid-capture".to_string()),
        )];
        let text = render_text(&entries, None);
        assert_eq!(
            text,
            "-- 54eb98a5 · /home/user · error: websocket closed mid-capture --"
        );
    }

    #[test]
    fn text_lines_slices_each_screen_after_trimming() {
        let entries = vec![
            entry("54eb98a5", None, Outcome::Screen(capture("a\nb\nc"))),
            entry("3c361a41", None, Outcome::Unreachable),
        ];
        let text = render_text(&entries, Some(2));
        assert_eq!(
            text,
            "== 54eb98a5 · /home/user · 107x59 ==\nb\nc\n\n\
             -- 3c361a41 · /home/user · skipped (unreachable) --"
        );
    }

    #[test]
    fn json_entries_carry_screen_activity_and_foreground_fields() {
        let captured = entry_json(
            &entry("54eb98a5", Some("tab 3"), Outcome::Screen(capture("hello"))),
            None,
        );
        assert_eq!(
            captured,
            json!({
                "id": "54eb98a5-rest-of-id",
                "short_id": "54eb98a5",
                "machine_id": "machine-1",
                "title": "title-54eb98a5-rest-of-id",
                "pane_title": "title-54eb98a5-rest-of-id",
                "title_source": "none",
                "group": "tab 3",
                "cwd": "/home/user",
                "cols": 107,
                "rows": 59,
                "screen": "hello",
                "lines_total": 1,
                "truncated": false,
                "activity": "quiet",
                "idle_ms": 500,
                "foreground_process": null,
            })
        );

        let skipped = entry_json(&entry("2bf50be0", None, Outcome::Unreachable), None);
        assert_eq!(skipped["error"], json!("unreachable"));
        assert!(skipped.get("screen").is_none());
        assert!(skipped.get("cols").is_none());
        assert!(skipped.get("activity").is_none());
        assert_eq!(skipped["group"], json!(null));

        let failed = entry_json(
            &entry("3c361a41", None, Outcome::Error("boom".to_string())),
            None,
        );
        assert_eq!(failed["error"], json!("boom"));
        assert!(failed.get("screen").is_none());
    }

    #[test]
    fn json_entries_carry_the_title_source_from_the_listing() {
        let mut osc_terminal = terminal("54eb98a5-rest-of-id", "machine-1", "/home/user");
        osc_terminal.title_source = TerminalTitleSource::Osc;
        let entry = BatchEntry {
            terminal: osc_terminal,
            group: None,
            outcome: Outcome::Unreachable,
        };
        assert_eq!(entry_json(&entry, None)["title_source"], json!("osc"));

        let mut process_terminal = terminal("3c361a41-rest-of-id", "machine-1", "/home/user");
        process_terminal.title_source = TerminalTitleSource::Process;
        let entry = BatchEntry {
            terminal: process_terminal,
            group: None,
            outcome: Outcome::Unreachable,
        };
        assert_eq!(entry_json(&entry, None)["title_source"], json!("process"));
    }

    #[test]
    fn json_lines_slices_the_screen_and_reports_totals() {
        let sliced = entry_json(
            &entry("54eb98a5", None, Outcome::Screen(capture("a\nb\nc"))),
            Some(2),
        );
        assert_eq!(sliced["screen"], json!("b\nc"));
        assert_eq!(sliced["lines_total"], json!(3));
        assert_eq!(sliced["truncated"], json!(true));

        let full = entry_json(
            &entry("54eb98a5", None, Outcome::Screen(capture("a\nb"))),
            Some(5),
        );
        assert_eq!(full["screen"], json!("a\nb"));
        assert_eq!(full["truncated"], json!(false));
    }

    #[test]
    fn json_entries_sanitize_machine_supplied_strings() {
        let mut dirty = terminal("54eb98a5-rest-of-id", "machine-1", "/home/u\0ser");
        dirty.title = "t\x1b]0;it\x07le".to_string();
        let entry = BatchEntry {
            terminal: dirty,
            group: Some("ta\x07b".to_string()),
            outcome: Outcome::Screen(capture("hi\0")),
        };
        let value = entry_json(&entry, None);
        assert_eq!(value["title"], json!("t]0;itle"));
        assert_eq!(value["pane_title"], json!("t]0;itle"));
        assert_eq!(value["group"], json!("tab"));
        assert_eq!(value["cwd"], json!("/home/user"));
    }

    #[test]
    fn json_output_defaults_to_reachable_only_with_a_skip_count() {
        let entries = vec![
            entry("54eb98a5", None, Outcome::Screen(capture("hello"))),
            entry("3c361a41", None, Outcome::Error("boom".to_string())),
            entry("2bf50be0", None, Outcome::Unreachable),
            entry("9aaaaaaa", None, Outcome::Unreachable),
        ];
        // Reachable errors stay; only unreachable entries are filtered out.
        let output = json_output(&entries, None, false, 2);
        assert_eq!(output["skipped_unreachable_count"], json!(2));
        let terminals = output["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 2);
        assert_eq!(terminals[0]["id"], json!("54eb98a5-rest-of-id"));
        assert_eq!(terminals[1]["error"], json!("boom"));

        // --include-unreachable restores the error entries.
        let output = json_output(&entries, None, true, 2);
        let terminals = output["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 4);
        assert_eq!(terminals[2]["error"], json!("unreachable"));
        assert_eq!(terminals[3]["error"], json!("unreachable"));
    }

    fn machine(id: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_string(),
            name: id.to_string(),
            os: "linux".to_string(),
            home_dir: "/home/user".to_string(),
            production: false,
        }
    }

    #[test]
    fn machine_filter_keeps_only_the_resolved_machine() {
        let machines = vec![machine("aaaa1111-machine"), machine("bbbb2222-machine")];
        let mut terminals = vec![
            terminal("t-1", "aaaa1111-machine", "/a"),
            terminal("t-2", "bbbb2222-machine", "/b"),
            terminal("t-3", "aaaa1111-machine", "/c"),
        ];
        retain_machine(&mut terminals, &machines, "aaaa").unwrap();
        let ids: Vec<&str> = terminals.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["t-1", "t-3"]);
    }

    #[test]
    fn machine_filter_rejects_unknown_and_ambiguous_prefixes() {
        let machines = vec![machine("aaaa1111-machine"), machine("aaaa2222-machine")];
        let mut terminals = vec![terminal("t-1", "aaaa1111-machine", "/a")];
        assert!(retain_machine(&mut terminals, &machines, "zzzz").is_err());
        assert!(retain_machine(&mut terminals, &machines, "aaaa").is_err());
        // Failed filters leave the listing untouched.
        assert_eq!(terminals.len(), 1);
    }
}
