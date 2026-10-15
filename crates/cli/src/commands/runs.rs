use std::collections::HashMap;

use offdesk_protocol::{AgentRunInfo, AgentRunStatus, MachineInfo};

use crate::client::HubClient;
use crate::resolve::{resolve_machine, short_id};
use crate::CliError;

/// List agent runs: the coding agents in your terminals and what they're doing.
/// Open runs by default; `all` adds those that ended in the last day.
pub async fn run(
    client: &HubClient,
    machine: Option<String>,
    all: bool,
    waiting: bool,
    json: bool,
) -> Result<(), CliError> {
    let machines = client.machines_including_offline().await?;
    let machine_id = match &machine {
        Some(query) => Some(resolve_machine(query, &machines)?.id.clone()),
        None => None,
    };
    let mut query = vec![];
    if !all {
        query.push("active=true".to_string());
    }
    if let Some(id) = &machine_id {
        query.push(format!("machine={id}"));
    }
    let path = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query.join("&"))
    };
    let Some(mut runs) = client.agent_runs(&path).await? else {
        return Err(CliError::Protocol(
            "this hub doesn't track agent runs yet; update the hub".to_string(),
        ));
    };
    if waiting {
        runs.retain(|run| run.status == AgentRunStatus::Waiting);
    }

    if json {
        super::out_line(&super::json_pretty(&runs)?);
        return Ok(());
    }
    for line in table(&runs, &machines, now_ms()) {
        super::out_line(&line);
    }
    Ok(())
}

/// An open run by id or unique id prefix.
pub async fn find_open_run(client: &HubClient, run_query: &str) -> Result<AgentRunInfo, CliError> {
    let Some(runs) = client.agent_runs("?active=true").await? else {
        return Err(CliError::Protocol(
            "this hub doesn't track agent runs yet; update the hub".to_string(),
        ));
    };
    let matches: Vec<&AgentRunInfo> = runs
        .iter()
        .filter(|run| run.id.starts_with(run_query))
        .collect();
    match matches.as_slice() {
        [run] => Ok((*run).clone()),
        [] => Err(CliError::Usage(format!(
            "no open agent run {run_query}; see `offdesk runs`"
        ))),
        _ => Err(CliError::Usage(format!(
            "{run_query} matches several runs; use more of its id"
        ))),
    }
}

/// Answers a run's open request (taking control of its machine first, as typing into a
/// terminal does); returns the run as the hub has it after sending the answer.
pub async fn answer_run(
    client: &HubClient,
    run: &AgentRunInfo,
    approve: Option<bool>,
    option: Option<String>,
    text: Option<String>,
) -> Result<AgentRunInfo, CliError> {
    let Some(request) = &run.request else {
        return Err(CliError::Usage(format!(
            "{} isn't waiting on anyone",
            short_id(&run.id)
        )));
    };
    client.claim_control(&run.machine_id).await?;
    client
        .answer_agent_run(
            &run.id,
            &offdesk_protocol::AgentAnswer {
                request_id: request.id.clone(),
                approve,
                option_id: option,
                text,
                device_id: Some(client.device_id().to_string()),
            },
        )
        .await
}

/// Answer a run's open request: approve or decline, pick an option, or say it in words.
/// Takes control of the machine first, as typing into a terminal does.
pub async fn answer(
    client: &HubClient,
    run_query: &str,
    approve: Option<bool>,
    option: Option<String>,
    text: Option<String>,
) -> Result<(), CliError> {
    let run = find_open_run(client, run_query).await?;
    let answered = answer_run(client, &run, approve, option, text).await?;
    super::out_line(&format!(
        "Sent to {} in {}; it carries on once the agent takes it ({}).",
        answered.agent.as_str(),
        answered
            .terminal_id
            .as_deref()
            .map(short_id)
            .unwrap_or("its terminal"),
        "`offdesk runs` shows when it does"
    ));
    Ok(())
}

/// Starts an agent on a machine (id, prefix or name), taking control of it first as
/// opening a terminal does; returns the run, its terminal and the machine.
pub async fn start_run(
    client: &HubClient,
    machine_query: &str,
    mut start: offdesk_protocol::StartAgentRun,
) -> Result<(offdesk_protocol::StartedAgentRun, MachineInfo), CliError> {
    let machines = client.machines().await?;
    let machine = resolve_machine(machine_query, &machines)?.clone();
    start.machine_id = machine.id.clone();
    start.device_id = Some(client.device_id().to_string());
    client.claim_control(&machine.id).await?;
    let Some(started) = client.start_agent_run(&start).await? else {
        return Err(CliError::Protocol(
            "this hub can't start agents yet; update the hub".to_string(),
        ));
    };
    Ok((started, machine))
}

/// Start an agent in a new terminal on a machine. Takes control of the machine first,
/// as opening a terminal does.
pub async fn start(
    client: &HubClient,
    machine_query: &str,
    start: offdesk_protocol::StartAgentRun,
    json: bool,
) -> Result<(), CliError> {
    let (started, machine) = start_run(client, machine_query, start).await?;
    if json {
        super::out_line(&super::json_pretty(&started)?);
        return Ok(());
    }
    super::out_line(&format!(
        "Started {} in {} on {} (run {}). `offdesk runs` follows it; if it asks something, `offdesk answer {}`.",
        started.run.agent.as_str(),
        short_id(&started.terminal.id),
        machine.name,
        short_id(&started.run.id),
        short_id(&started.run.id),
    ));
    Ok(())
}

/// A prompt from a file, or from stdin for `-`.
pub fn read_prompt_file(path: &str) -> Result<String, CliError> {
    use std::io::Read;
    let mut text = String::new();
    let result = if path == "-" {
        std::io::stdin().read_to_string(&mut text).map(|_| ())
    } else {
        std::fs::File::open(path).and_then(|mut file| file.read_to_string(&mut text).map(|_| ()))
    };
    result.map_err(|error| CliError::Usage(format!("can't read the prompt from {path}: {error}")))?;
    Ok(text)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "45s", "12m", "3h", "2d"
fn age(ms: i64) -> String {
    let seconds = (ms / 1000).max(0);
    match seconds {
        s if s < 60 => format!("{s}s"),
        s if s < 3600 => format!("{}m", s / 60),
        s if s < 86_400 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86_400),
    }
}

fn table(runs: &[AgentRunInfo], machines: &[MachineInfo], now: i64) -> Vec<String> {
    let names: HashMap<&str, &str> = machines
        .iter()
        .map(|m| (m.id.as_str(), m.name.as_str()))
        .collect();
    let mut lines = vec![format!(
        "{:<10} {:<7} {:<8} {:<16} {:<10} {:>6} {}",
        "ID", "AGENT", "STATUS", "MACHINE", "TERMINAL", "FOR", "CWD"
    )];
    for run in runs {
        // How long it has been running, or ran
        let length = age(run.ended_at_ms.unwrap_or(now) - run.started_at_ms);
        let status = match (&run.request, run.status) {
            (Some(_), AgentRunStatus::Waiting) => "waiting".to_string(),
            (_, status) => status.as_str().to_string(),
        };
        lines.push(format!(
            "{:<10} {:<7} {:<8} {:<16} {:<10} {:>6} {}",
            short_id(&run.id),
            run.agent.as_str(),
            status,
            names
                .get(run.machine_id.as_str())
                .copied()
                .unwrap_or(short_id(&run.machine_id)),
            run.terminal_id.as_deref().map(short_id).unwrap_or("-"),
            length,
            run.cwd,
        ));
        // What it waits for, and how to answer from here
        if let (Some(request), None) = (&run.request, run.ended_at_ms) {
            let how = match request.kind {
                offdesk_protocol::AgentRequestKind::Approval => "--approve | --decline".to_string(),
                offdesk_protocol::AgentRequestKind::Question if !request.options.is_empty() => {
                    let options: Vec<String> = request
                        .options
                        .iter()
                        .map(|o| format!("{}={}", o.id, o.label))
                        .collect();
                    format!("--option {} | --text ...", options.join(" "))
                }
                _ => "--text ...".to_string(),
            };
            let sent = if request.answer_sent_at_ms.is_some() {
                " (answer sent)"
            } else {
                ""
            };
            lines.push(format!(
                "{:<10} ↳ {}: {}{}  offdesk answer {} {}",
                "",
                request.kind.as_str(),
                request.prompt.as_deref().unwrap_or("(see its terminal)"),
                sent,
                short_id(&run.id),
                how
            ));
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use offdesk_protocol::RunAgent;

    #[test]
    fn runs_print_as_a_table_with_how_long_they_ran() {
        let machines = vec![MachineInfo {
            id: "machine-1234".into(),
            name: "studio".into(),
            os: "macos".into(),
            home_dir: "/Users/a".into(),
            production: false,
        }];
        let run = |id: &str, status, started: i64, ended: Option<i64>| AgentRunInfo {
            id: id.into(),
            machine_id: "machine-1234".into(),
            terminal_id: Some("terminal-abcdef".into()),
            agent: RunAgent::Claude,
            cwd: "~/work/shop".into(),
            status,
            request: None,
            progress: None,
            report: None,
            label: None,
            external_ref: None,
            started_at_ms: started,
            updated_at_ms: started,
            ended_at_ms: ended,
        };
        let lines = table(
            &[
                run("run-aaaaaaaaa", AgentRunStatus::Working, 0, None),
                run("run-bbbbbbbbb", AgentRunStatus::Done, 0, Some(90_000)),
            ],
            &machines,
            7_200_000,
        );
        assert!(lines[0].starts_with("ID "));
        assert_eq!(
            lines[1],
            format!(
                "{:<10} {:<7} {:<8} {:<16} {:<10} {:>6} {}",
                "run-aaaa", "claude", "working", "studio", "terminal", "2h", "~/work/shop"
            )
        );
        assert!(lines[2].contains(" done ") && lines[2].contains(" 1m "));
        let mut waiting = run("run-ccccccccc", AgentRunStatus::Waiting, 0, None);
        waiting.request = Some(offdesk_protocol::AgentRunRequest {
            id: "q".into(),
            kind: offdesk_protocol::AgentRequestKind::Approval,
            prompt: Some("Bash: npm test".into()),
            options: vec![],
            source: "hooks".into(),
            created_at_ms: 0,
            answer_sent_at_ms: None,
        });
        let lines = table(&[waiting], &machines, 1000);
        assert!(
            lines[2].trim_start().starts_with(
                "↳ approval: Bash: npm test  offdesk answer run-cccc --approve | --decline"
            ),
            "{}",
            lines[2]
        );
        assert_eq!(age(59_000), "59s");
        assert_eq!(age(3 * 86_400_000), "3d");
    }
}
