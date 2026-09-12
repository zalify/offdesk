//! Supervise our connector only. Probe the pinned encrypted endpoint, not a
//! cached provisioning state; restart a living connector that cannot recover.
use std::{future::Future, process::Command, time::Duration};
use tokio::{process::Child, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Health {
    Connected,
    TunnelUnavailable,
    OriginUnavailable,
}

pub struct Policy {
    interval: Duration,
    failures: u32,
    initial_backoff: Duration,
    max_backoff: Duration,
    stable_for: Duration,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            interval: Duration::from_secs(30),
            failures: 3,
            initial_backoff: Duration::from_secs(15),
            max_backoff: Duration::from_secs(600),
            stable_for: Duration::from_secs(300),
        }
    }
}

struct Recovery {
    failures: u32,
    healthy_since: Option<Instant>,
    backoff: Duration,
}
impl Recovery {
    fn new(policy: &Policy) -> Self {
        Self {
            failures: 0,
            healthy_since: None,
            backoff: policy.initial_backoff,
        }
    }
    fn observe(&mut self, health: Health, now: Instant, policy: &Policy) -> bool {
        match health {
            Health::Connected => {
                self.failures = 0;
                let since = self.healthy_since.get_or_insert(now);
                if now.duration_since(*since) >= policy.stable_for {
                    self.backoff = policy.initial_backoff;
                }
            }
            Health::TunnelUnavailable => {
                self.healthy_since = None;
                self.failures += 1;
            }
            Health::OriginUnavailable => {
                self.healthy_since = None;
                self.failures = 0;
            }
        }
        self.failures >= policy.failures
    }
    fn restart_delay(&mut self, policy: &Policy) -> Duration {
        self.failures = 0;
        self.healthy_since = None;
        let delay = self.backoff;
        self.backoff = self.backoff.saturating_mul(2).min(policy.max_backoff);
        delay
    }
}

async fn stop(child: &mut Child) -> Result<(), String> {
    // kill() also waits, preventing overlap between old and new connectors.
    child
        .kill()
        .await
        .map_err(|e| format!("Could not stop managed connector: {e}"))
}

pub async fn supervise<P, F, S>(
    command: Command,
    mut probe: P,
    shutdown: S,
    policy: Policy,
) -> Result<(), String>
where
    P: FnMut() -> F,
    F: Future<Output = Health>,
    S: Future<Output = ()>,
{
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut recovery = Recovery::new(&policy);
    tokio::pin!(shutdown);
    loop {
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start cloudflared: {e}"))?;
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown => {
                    stop(&mut child).await?;
                    return Ok(());
                }
                result = child.wait() => {
                    result.map_err(|e| format!("Could not wait for managed connector: {e}"))?;
                    eprintln!("Managed connector exited; scheduling recovery");
                    break;
                }
                health = async {
                    tokio::time::sleep(policy.interval).await;
                    probe().await
                } => {
                    if recovery.observe(health, Instant::now(), &policy) {
                        eprintln!("Managed connector failed consecutive encrypted checks; restarting to refresh its connection");
                        stop(&mut child).await?;
                        break;
                    }
                }
            }
        }
        let delay = recovery.restart_delay(&policy);
        tokio::select! {
            biased;
            _ = &mut shutdown => return Ok(()),
            _ = tokio::time::sleep(delay) => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    #[test]
    fn outages_require_consecutive_failures_and_back_off_until_stable() {
        let policy = Policy::default();
        let mut recovery = Recovery::new(&policy);
        let now = Instant::now();
        for _ in 0..2 {
            assert!(!recovery.observe(Health::TunnelUnavailable, now, &policy));
        }
        assert!(!recovery.observe(Health::Connected, now, &policy));
        for _ in 0..2 {
            assert!(!recovery.observe(Health::TunnelUnavailable, now, &policy));
        }
        assert!(recovery.observe(Health::TunnelUnavailable, now, &policy));
        assert_eq!(recovery.restart_delay(&policy), Duration::from_secs(15));
        // A briefly successful connection must not cause a restart storm.
        recovery.observe(Health::Connected, now, &policy);
        assert_eq!(recovery.restart_delay(&policy), Duration::from_secs(30));
        for _ in 0..20 {
            recovery.restart_delay(&policy);
        }
        assert_eq!(recovery.restart_delay(&policy), policy.max_backoff);
        recovery.observe(Health::Connected, now, &policy);
        recovery.observe(Health::Connected, now + policy.stable_for, &policy);
        assert_eq!(recovery.restart_delay(&policy), policy.initial_backoff);
    }

    #[test]
    fn stopped_hub_does_not_restart_a_healthy_connector() {
        let policy = Policy::default();
        let mut recovery = Recovery::new(&policy);
        for _ in 0..20 {
            assert!(!recovery.observe(Health::TunnelUnavailable, Instant::now(), &policy));
            assert!(!recovery.observe(Health::OriginUnavailable, Instant::now(), &policy));
        }
    }

    fn fast_policy() -> Policy {
        Policy {
            interval: Duration::from_millis(10),
            initial_backoff: Duration::from_millis(10),
            ..Policy::default()
        }
    }

    // Fake connector records each PID and then lives indefinitely. This tests
    // real process replacement/cleanup without DNS, Cloudflare or credentials.
    fn connector(file: &std::path::Path) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "echo $$ >> \"$1\"; exec /bin/sleep 60", "connector"])
            .arg(file);
        command
    }
    fn pids(file: &std::path::Path) -> Vec<i32> {
        std::fs::read_to_string(file)
            .unwrap_or_default()
            .lines()
            .map(|s| s.parse().unwrap())
            .collect()
    }
    fn gone(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == -1 }
    }

    #[tokio::test]
    async fn replaces_stuck_process_recovers_and_reaps_on_shutdown() {
        let file = std::env::temp_dir().join(format!("offdesk-connector-{}", uuid::Uuid::new_v4()));
        let path = file.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let mut tx = Some(tx);
        let probe = move || {
            let count = count.fetch_add(1, Ordering::SeqCst);
            let tx = if count >= 4 { tx.take() } else { None };
            let path = path.clone();
            async move {
                // Observe readiness instead of assuming the OS has scheduled
                // the shell within the test's 10 ms probe interval.
                let expected = if count < 3 { 1 } else { 2 };
                while pids(&path).len() < expected {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let processes = pids(&path);
                if processes.len() > 1 {
                    assert!(gone(processes[0]));
                }
                if let Some(tx) = tx {
                    let _ = tx.send(());
                }
                if count < 3 {
                    Health::TunnelUnavailable
                } else {
                    Health::Connected
                }
            }
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            supervise(
                connector(&file),
                probe,
                async {
                    let _ = rx.await;
                },
                fast_policy(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let processes = pids(&file);
        assert_eq!(processes.len(), 2);
        assert!(processes.into_iter().all(gone));
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn exited_child_is_replaced_and_shutdown_interrupts_backoff() {
        let file = std::env::temp_dir().join(format!("offdesk-connector-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "echo $$ >> \"$1\"; exit 1", "connector"])
            .arg(&file);
        let path = file.clone();
        let shutdown = async move {
            loop {
                let processes = pids(&path);
                if processes.len() >= 2 && processes.iter().all(|pid| gone(*pid)) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        let policy = Policy {
            initial_backoff: Duration::from_millis(200),
            ..fast_policy()
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            supervise(command, std::future::pending::<Health>, shutdown, policy),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(pids(&file).len(), 2);
        std::fs::remove_file(file).unwrap();
    }

    #[tokio::test]
    async fn shutdown_interrupts_hung_probe_and_cleans_up_child() {
        let file = std::env::temp_dir().join(format!("offdesk-connector-{}", uuid::Uuid::new_v4()));
        let path = file.clone();
        let shutdown = async move {
            while pids(&path).is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            supervise(
                connector(&file),
                std::future::pending::<Health>,
                shutdown,
                fast_policy(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let processes = pids(&file);
        assert_eq!(processes.len(), 1);
        assert!(gone(processes[0]));
        std::fs::remove_file(file).unwrap();
    }
}
