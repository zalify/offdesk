use crate::client::{CreateTerminalRequest, HubClient};
use crate::resolve::resolve_machine;
use crate::CliError;

/// Options for the `open` command, mirroring the clap flags.
pub struct OpenOptions {
    pub cwd: String,
    pub cmd: Option<String>,
    pub group: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub label: Option<String>,
    pub json: bool,
}

/// Open a new terminal on a machine, optionally in an existing workspace group.
pub async fn run(
    client: &HubClient,
    machine_query: &str,
    options: OpenOptions,
) -> Result<(), CliError> {
    let machines = client.machines().await?;
    let machine = resolve_machine(machine_query, &machines)?;

    // Creating a terminal is gated on the control lease; claim it first.
    client.claim_control(&machine.id).await?;

    let request = CreateTerminalRequest {
        cwd: &options.cwd,
        startup_command: options.cmd.as_deref(),
        cols: options.cols,
        rows: options.rows,
        device_id: Some(client.device_id()),
        opened_by_label: options.label.as_deref(),
    };
    let mut terminal = client.create_terminal(&machine.id, &request).await?;

    if let Some(group_name) = &options.group {
        let groups = client.workspace_groups(&machine.id).await?;
        let group_id = groups
            .iter()
            .find(|g| &g.name == group_name)
            .ok_or_else(|| {
                CliError::Usage(format!(
                    "no workspace group named '{group_name}' on machine '{}' \
                     (groups are not auto-created)",
                    machine.name
                ))
            })?;
        terminal = client
            .assign_workspace_group(&machine.id, &terminal.id, Some(&group_id.id))
            .await?;
    }

    if options.json {
        super::out_line(&super::json_pretty(&terminal)?);
    } else {
        super::out_line(&terminal.id);
    }
    Ok(())
}
