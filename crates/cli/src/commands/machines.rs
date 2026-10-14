use std::collections::{HashMap, HashSet};
use std::io::{IsTerminal, Write};

use offdesk_protocol::MachineInfo;

use crate::client::HubClient;
use crate::resolve::{resolve_machine, short_id};
use crate::CliError;

/// List machines. Default is online-only (the hub's /api/machines).
/// `--all` includes offline registered hosts.
pub async fn run(client: &HubClient, json: bool, all: bool) -> Result<(), CliError> {
    let machines = if all {
        client.machines_including_offline().await?
    } else {
        client.machines().await?
    };
    if json {
        super::out_line(&super::json_pretty(&machines)?);
        return Ok(());
    }

    let online_ids: HashSet<String> = if all {
        client
            .machines()
            .await?
            .into_iter()
            .map(|machine| machine.id)
            .collect()
    } else {
        machines.iter().map(|machine| machine.id.clone()).collect()
    };

    // Optional: a hub before 0.23 has no versions to give.
    let versions = client.machine_versions().await.ok().flatten();
    let terminals = client.terminals().await?;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for terminal in &terminals {
        *counts.entry(terminal.machine_id.as_str()).or_default() += 1;
    }

    if machines.is_empty() {
        super::out_line(if all {
            "(no machines registered)"
        } else {
            "(no machines online)"
        });
        return Ok(());
    }
    super::out_line(&format!(
        "{:<10} {:<24} {:>5} {:<8} {}",
        "ID", "NAME", "TERMS", "STATUS", "NODE"
    ));
    for machine in &machines {
        let count = counts.get(machine.id.as_str()).copied().unwrap_or(0);
        let status = if online_ids.contains(&machine.id) {
            "online"
        } else {
            "offline"
        };
        super::out_line(&format!(
            "{:<10} {:<24} {:>5} {:<8} {}",
            short_id(&machine.id),
            machine.name,
            count,
            status,
            super::version::node_label(versions.as_deref(), &machine.id)
        ));
    }
    Ok(())
}

/// Forget a machine. Resolves id, unique id prefix, or unique name.
pub async fn rm(client: &HubClient, query: &str, yes: bool) -> Result<(), CliError> {
    let machines = client.machines_including_offline().await?;
    let machine = resolve_machine(query, &machines)?;

    if !yes && std::io::stdin().is_terminal() && !confirm(machine)? {
        super::out_line("aborted");
        return Ok(());
    }

    client.delete_machine(&machine.id).await?;
    super::out_line(&format!("removed {}", machine.id));
    Ok(())
}

fn confirm(machine: &MachineInfo) -> Result<bool, CliError> {
    eprint!(
        "Remove machine {} ({})? [y/N] ",
        short_id(&machine.id),
        machine.name
    );
    std::io::stderr()
        .flush()
        .map_err(|error| CliError::Usage(format!("failed to prompt: {error}")))?;
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|error| CliError::Usage(format!("failed to read confirmation: {error}")))?;
    let answer = answer.trim().to_lowercase();
    Ok(answer == "y" || answer == "yes")
}

#[cfg(test)]
mod tests {
    use crate::resolve::resolve_machine;
    use offdesk_protocol::MachineInfo;

    fn machine(id: &str, name: &str) -> MachineInfo {
        MachineInfo {
            id: id.to_string(),
            name: name.to_string(),
            os: "linux".to_string(),
            home_dir: "/tmp".to_string(),
            production: false,
        }
    }

    #[test]
    fn unique_name_resolves_when_id_does_not_match() {
        let machines = vec![
            machine("aaaa1111-rest", "nas"),
            machine("bbbb2222-rest", "localhost.localdomain"),
        ];
        assert_eq!(
            resolve_machine("nas", &machines).unwrap().id,
            "aaaa1111-rest"
        );
        assert_eq!(
            resolve_machine("LOCALHOST.LOCALDOMAIN", &machines)
                .unwrap()
                .id,
            "bbbb2222-rest"
        );
    }

    #[test]
    fn duplicate_names_require_an_id() {
        let machines = vec![
            machine("aaaa1111-rest", "localhost.localdomain"),
            machine("bbbb2222-rest", "localhost.localdomain"),
        ];
        let error = resolve_machine("localhost.localdomain", &machines).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("ambiguous"), "{message}");
        assert!(message.contains("aaaa1111-rest"), "{message}");
        assert_eq!(
            resolve_machine("aaaa1111", &machines).unwrap().id,
            "aaaa1111-rest"
        );
    }

    #[test]
    fn missing_query_is_an_error() {
        let machines = vec![machine("aaaa1111-rest", "nas")];
        let error = resolve_machine("nope", &machines).unwrap_err();
        assert!(error.to_string().contains("no machine matching 'nope'"));
    }
}
