//! Running an offdesk binary as a user service — a systemd user unit on Linux,
//! a launchd agent on macOS, a logon task in Task Scheduler on Windows.
//!
//! The agent has always had this; the hub needed it too, and there is nothing
//! node-specific in "write a unit, enable it, start it". Each binary says who
//! it is through a [`ServiceSpec`] and gets the same four verbs.

use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// What a binary needs to say about itself to be run as a service.
/// The locale a service runs with. launchd and systemd start a service with
/// no LANG at all, and everything under it — tmux above all — then treats
/// the terminal as unable to show non-ASCII. The installing shell's LANG,
/// when it has one that is UTF-8; otherwise a UTF-8 default.
pub fn lang_env() -> String {
    std::env::var("LANG")
        .ok()
        .filter(|lang| lang.to_ascii_lowercase().contains("utf-8") || lang.to_ascii_lowercase().contains("utf8"))
        .unwrap_or_else(|| "en_US.UTF-8".to_string())
}

#[derive(Debug, Clone)]
pub struct ServiceSpec {
    /// The systemd unit name, e.g. `offdesk-node`.
    pub name: &'static str,
    /// The launchd label, e.g. `dev.offdesk.node`.
    pub label: &'static str,
    /// Shown in `systemctl status`.
    pub description: String,
    /// Arguments after the executable, e.g. `["start"]`. The executable is
    /// whatever is running `install`, so a service always points at the binary
    /// that installed it.
    pub args: Vec<String>,
}

// ── Shared helpers ─────────────────────────────────────────────────

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn xml_text(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(any(target_os = "linux", test))]
fn unit_value(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%")
        .replace('\n', "\\n").replace('\r', "\\r").replace('\t', "\\t"))
}

#[cfg(any(target_os = "linux", test))]
fn unit_argument(value: &str) -> String {
    unit_value(value).replace('$', "$$")
}

fn run_command(cmd: &str, args: &[&str]) -> Result<(), String> {
    let status = Command::new(cmd)
        .args(args)
        .status()
        .map_err(|e| format!("failed to execute {cmd}: {e}"))?;

    if !status.success() {
        return Err(format!("{cmd} exited with status {status}"));
    }
    Ok(())
}

pub fn home() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "cannot determine home directory".to_string())
}

fn current_exe() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("failed to determine current executable path: {e}"))
}

fn not_installed(spec: &ServiceSpec) -> String {
    format!(
        "service is not installed. Run \"{} service install\" first.",
        spec.name
    )
}

// ── Linux (systemd) ───────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn whoami() -> Option<String> {
        let output = Command::new("whoami").output().ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn render_unit(spec: &ServiceSpec, home_dir: &str, exe_path: &str, path_env: &str) -> String {
        let exec = std::iter::once(exe_path.to_string())
            .chain(spec.args.iter().cloned())
            .map(|value| unit_argument(&value))
            .collect::<Vec<_>>()
            .join(" ");
        format!(
            r#"[Unit]
Description={description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={exec}
Restart=always
RestartSec=10
KillMode=process
Environment={home_env}
Environment={path_env}
Environment={lang_env}
WorkingDirectory={working_directory}

[Install]
WantedBy=default.target
"#,
            description = spec.description,
            home_env = unit_value(&format!("HOME={home_dir}")),
            path_env = unit_value(&format!("PATH={path_env}")),
            lang_env = unit_value(&format!("LANG={}", lang_env())),
            working_directory = unit_value(home_dir),
        )
    }

    fn systemctl(args: &[&str]) -> Result<(), String> {
        run_command("systemctl", args)
    }

    pub fn service_file_path(spec: &ServiceSpec, home_dir: &str) -> String {
        PathBuf::from(home_dir)
            .join(".config")
            .join("systemd")
            .join("user")
            .join(format!("{}.service", spec.name))
            .to_string_lossy()
            .to_string()
    }

    pub fn install(spec: &ServiceSpec) -> Result<(), String> {
        let home_dir = home()?;
        let exe_path = current_exe()?;
        let path_env = std::env::var("PATH").unwrap_or_default();
        let unit = render_unit(spec, &home_dir, &exe_path, &path_env);

        let unit_path = service_file_path(spec, &home_dir);
        let unit_dir = PathBuf::from(&unit_path)
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "cannot determine service directory".to_string())?;
        fs::create_dir_all(&unit_dir)
            .map_err(|e| format!("failed to create service directory: {e}"))?;
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&unit_dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("failed to set directory permissions: {e}"))?;
        }
        fs::write(&unit_path, &unit).map_err(|e| format!("failed to write service unit: {e}"))?;

        systemctl(&["--user", "daemon-reload"])?;
        systemctl(&["--user", "enable", spec.name])?;
        systemctl(&["--user", "restart", spec.name])?;

        // Without lingering, a user's services stop when the user logs out —
        // which on a headless box means "when the SSH session ends".
        if let Some(username) = whoami() {
            let _ = run_command("loginctl", &["enable-linger", &username]);
        }
        Ok(())
    }

    pub fn uninstall(spec: &ServiceSpec) -> Result<(), String> {
        let unit_path = service_file_path(spec, &home()?);
        let _ = systemctl(&["--user", "stop", spec.name]);
        let _ = systemctl(&["--user", "disable", spec.name]);
        if PathBuf::from(&unit_path).exists() {
            fs::remove_file(&unit_path)
                .map_err(|e| format!("failed to remove service file: {e}"))?;
        }
        let _ = systemctl(&["--user", "daemon-reload"]);
        Ok(())
    }

    pub fn restart(spec: &ServiceSpec) -> Result<(), String> {
        let unit_path = service_file_path(spec, &home()?);
        if !PathBuf::from(&unit_path).exists() {
            return Err(not_installed(spec));
        }
        systemctl(&["--user", "restart", spec.name])
    }

    pub fn status(spec: &ServiceSpec) {
        let _ = Command::new("systemctl")
            .args(["--user", "status", spec.name])
            .status();
    }

    pub fn is_active(spec: &ServiceSpec) -> Option<String> {
        let output = Command::new("systemctl")
            .args(["--user", "is-active", spec.name])
            .output()
            .ok()?;
        let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (output.status.success() || !status.is_empty()).then_some(status)
    }
}

// ── macOS (launchd) ───────────────────────────────────────────────

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    fn render_plist(spec: &ServiceSpec, home_dir: &str, exe_path: &str, path_env: &str) -> String {
        let log_dir = xml_text(&format!("{home_dir}/Library/Logs/offdesk"));
        let lang_env = xml_text(&lang_env());
        let args = std::iter::once(exe_path.to_string())
            .chain(spec.args.iter().cloned())
            .map(|a| format!("        <string>{}</string>", xml_text(&a)))
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>{home_dir}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>{home_dir}</string>
        <key>PATH</key>
        <string>{path_env}</string>
        <key>LANG</key>
        <string>{lang_env}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{log_dir}/{name}.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>{log_dir}/{name}.stderr.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
"#,
            label = spec.label,
            name = spec.name,
            home_dir = xml_text(home_dir),
            path_env = xml_text(path_env),
        )
    }

    fn plist_path(spec: &ServiceSpec, home_dir: &str) -> PathBuf {
        PathBuf::from(home_dir)
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", spec.label))
    }

    pub fn service_file_path(spec: &ServiceSpec, home_dir: &str) -> String {
        plist_path(spec, home_dir).to_string_lossy().to_string()
    }

    pub fn install(spec: &ServiceSpec) -> Result<(), String> {
        let home_dir = home()?;
        let exe_path = current_exe()?;
        let path_env = std::env::var("PATH").unwrap_or_default();
        let plist = render_plist(spec, &home_dir, &exe_path, &path_env);

        let log_dir = PathBuf::from(&home_dir)
            .join("Library")
            .join("Logs")
            .join("offdesk");
        fs::create_dir_all(&log_dir).map_err(|e| format!("failed to create log directory: {e}"))?;

        let plist_file = plist_path(spec, &home_dir);
        let plist_dir = plist_file
            .parent()
            .ok_or_else(|| "cannot determine LaunchAgents directory".to_string())?;
        fs::create_dir_all(plist_dir)
            .map_err(|e| format!("failed to create LaunchAgents directory: {e}"))?;

        if plist_file.exists() {
            let _ = run_command("launchctl", &["unload", &plist_file.to_string_lossy()]);
        }
        fs::write(&plist_file, &plist).map_err(|e| format!("failed to write plist: {e}"))?;
        run_command("launchctl", &["load", "-w", &plist_file.to_string_lossy()])
    }

    pub fn uninstall(spec: &ServiceSpec) -> Result<(), String> {
        let plist_file = plist_path(spec, &home()?);
        if plist_file.exists() {
            let _ = run_command("launchctl", &["unload", &plist_file.to_string_lossy()]);
            fs::remove_file(&plist_file).map_err(|e| format!("failed to remove plist: {e}"))?;
        }
        Ok(())
    }

    fn current_uid() -> Result<String, String> {
        let output = Command::new("id")
            .arg("-u")
            .output()
            .map_err(|e| format!("failed to execute id: {e}"))?;
        if !output.status.success() {
            return Err(format!("id exited with status {}", output.status));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub fn restart(spec: &ServiceSpec) -> Result<(), String> {
        let plist_file = plist_path(spec, &home()?);
        if !plist_file.exists() {
            return Err(not_installed(spec));
        }
        let target = format!("gui/{}/{}", current_uid()?, spec.label);
        // kickstart needs macOS 10.10+; older systems get unload/load.
        if run_command("launchctl", &["kickstart", "-k", &target]).is_err() {
            let plist = plist_file.to_string_lossy().to_string();
            run_command("launchctl", &["unload", &plist])?;
            run_command("launchctl", &["load", "-w", &plist])?;
        }
        Ok(())
    }

    pub fn status(spec: &ServiceSpec) {
        let _ = Command::new("launchctl").args(["list", spec.label]).status();
    }

    pub fn is_active(spec: &ServiceSpec) -> Option<String> {
        let output = Command::new("launchctl")
            .args(["list", spec.label])
            .output()
            .ok()?;
        output.status.success().then(|| "active".to_string())
    }
}

// ── Windows (Task Scheduler) ──────────────────────────────────────

#[cfg(any(target_os = "windows", test))]
fn windows_argument(value: &str) -> String {
    // CommandLineToArgvW rules: backslashes are literal unless they precede a quote
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for c in value.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.push_str(&"\\".repeat(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.push_str(&"\\".repeat(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    fn task_name(spec: &ServiceSpec) -> String {
        format!("Offdesk\\{}", spec.label)
    }

    fn render_task(spec: &ServiceSpec, home_dir: &str, exe_path: &str) -> String {
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(domain), Ok(name)) => format!("{domain}\\{name}"),
            (_, Ok(name)) => name,
            _ => String::new(),
        };
        let args = spec
            .args
            .iter()
            .map(|a| windows_argument(a))
            .collect::<Vec<_>>()
            .join(" ");
        // Starts at logon and restarts after a failure, as KeepAlive and Restart=always do
        format!(
            r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{description}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>{args}</Arguments>
      <WorkingDirectory>{home_dir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"#,
            description = xml_text(&spec.description),
            user = xml_text(&user),
            exe = xml_text(exe_path),
            args = xml_text(&args),
            home_dir = xml_text(home_dir),
        )
    }

    fn task_path(spec: &ServiceSpec, home_dir: &str) -> PathBuf {
        PathBuf::from(home_dir)
            .join("AppData")
            .join("Local")
            .join("offdesk")
            .join("services")
            .join(format!("{}.xml", spec.label))
    }

    pub fn service_file_path(spec: &ServiceSpec, home_dir: &str) -> String {
        task_path(spec, home_dir).to_string_lossy().to_string()
    }

    pub fn install(spec: &ServiceSpec) -> Result<(), String> {
        let home_dir = home()?;
        let exe_path = current_exe()?;
        let task = render_task(spec, &home_dir, &exe_path);
        let task_file = task_path(spec, &home_dir);
        let task_dir = task_file
            .parent()
            .ok_or_else(|| "cannot determine the services directory".to_string())?;
        fs::create_dir_all(task_dir)
            .map_err(|e| format!("failed to create the services directory: {e}"))?;
        // schtasks reads the declared UTF-16 only with a byte order mark
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(task.encode_utf16().flat_map(u16::to_le_bytes));
        fs::write(&task_file, bytes).map_err(|e| format!("failed to write the task: {e}"))?;
        let name = task_name(spec);
        let _ = run_command("schtasks", &["/End", "/TN", &name]);
        run_command(
            "schtasks",
            &["/Create", "/TN", &name, "/XML", &task_file.to_string_lossy(), "/F"],
        )?;
        run_command("schtasks", &["/Run", "/TN", &name])
    }

    pub fn uninstall(spec: &ServiceSpec) -> Result<(), String> {
        let task_file = task_path(spec, &home()?);
        if task_file.exists() {
            let name = task_name(spec);
            let _ = run_command("schtasks", &["/End", "/TN", &name]);
            let _ = run_command("schtasks", &["/Delete", "/TN", &name, "/F"]);
            fs::remove_file(&task_file).map_err(|e| format!("failed to remove the task: {e}"))?;
        }
        Ok(())
    }

    pub fn restart(spec: &ServiceSpec) -> Result<(), String> {
        if !task_path(spec, &home()?).exists() {
            return Err(not_installed(spec));
        }
        let name = task_name(spec);
        let _ = run_command("schtasks", &["/End", "/TN", &name]);
        run_command("schtasks", &["/Run", "/TN", &name])
    }

    pub fn status(spec: &ServiceSpec) {
        let _ = Command::new("schtasks")
            .args(["/Query", "/TN", &task_name(spec), "/V", "/FO", "LIST"])
            .status();
    }

    pub fn is_active(spec: &ServiceSpec) -> Option<String> {
        let output = Command::new("schtasks")
            .args(["/Query", "/TN", &task_name(spec)])
            .output()
            .ok()?;
        output.status.success().then(|| "active".to_string())
    }
}

// ── Anything else ─────────────────────────────────────────────────

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;

    fn unsupported() -> String {
        "services are supported on Linux (systemd --user) and macOS (launchd) only".to_string()
    }

    pub fn service_file_path(_spec: &ServiceSpec, _home_dir: &str) -> String {
        String::new()
    }
    pub fn install(_spec: &ServiceSpec) -> Result<(), String> {
        Err(unsupported())
    }
    pub fn uninstall(_spec: &ServiceSpec) -> Result<(), String> {
        Err(unsupported())
    }
    pub fn restart(_spec: &ServiceSpec) -> Result<(), String> {
        Err(unsupported())
    }
    pub fn status(_spec: &ServiceSpec) {
        eprintln!("{}", unsupported());
    }
    pub fn is_active(_spec: &ServiceSpec) -> Option<String> {
        None
    }
}

pub fn install(spec: &ServiceSpec) -> Result<(), String> {
    platform::install(spec)
}
pub fn uninstall(spec: &ServiceSpec) -> Result<(), String> {
    platform::uninstall(spec)
}
pub fn restart(spec: &ServiceSpec) -> Result<(), String> {
    platform::restart(spec)
}
pub fn status(spec: &ServiceSpec) {
    platform::status(spec)
}
pub fn is_active(spec: &ServiceSpec) -> Option<String> {
    platform::is_active(spec)
}
pub fn service_file_path(spec: &ServiceSpec, home_dir: &str) -> String {
    platform::service_file_path(spec, home_dir)
}

#[cfg(test)]
mod quoting_tests {
    use super::*;
    #[test]
    fn managed_connector_database_paths_remain_single_literal_arguments() {
        assert_eq!(unit_argument("/home/A B/$user%/hub.db"), "\"/home/A B/$$user%%/hub.db\"");
        assert_eq!(unit_argument("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(xml_text("/Users/A & B/<hub>.db"), "/Users/A &amp; B/&lt;hub&gt;.db");
        assert_eq!(windows_argument(r"C:\Users\A B\hub.db"), r#""C:\Users\A B\hub.db""#);
        assert_eq!(windows_argument(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(windows_argument(r#"a\"b"#), r#""a\\\"b""#);
    }
}
