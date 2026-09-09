//! Conservative screen adapter, not an agent lifecycle signal. Never infer
//! completion from silence or copy terminal contents into the status protocol.
use offdesk_protocol::TerminalAttention;

/// Shared by the capture gate and screen adapter. Claude's native build can
/// report `claude.exe` as pane_current_command even on macOS.
pub fn supports_command(command: Option<&str>) -> bool {
    matches!(command, Some("claude" | "claude.exe" | "codex" | "node"))
}

pub fn detect(command: Option<&str>, screen: &str) -> Option<TerminalAttention> {
    if !supports_command(command) {
        return None;
    }
    let lines: Vec<_> = screen
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    // Both TUIs put a keyboard instruction below their live choice selector.
    // Requiring it at the bottom avoids retaining a prompt in scrollback after
    // the command has resumed. Unknown versions/localizations fail quietly.
    let footer = lines.iter().rev().take(2).any(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("esc to cancel") || line.contains("esc to reject")
    });
    let question = lines.iter().any(|line| {
        matches!(
            *line,
            "Do you want to proceed?"
                | "Would you like to run the following command?"
                | "Would you like to make the following edits?"
        ) || (line.starts_with("Do you want to ") && line.ends_with('?'))
    });
    let selected = lines.iter().any(|line| {
        line.strip_prefix('❯')
            .or_else(|| line.strip_prefix('›'))
            .is_some_and(|s| matches!(s.trim_start().as_bytes().first(), Some(b'1'..=b'3')))
    });
    let yes = lines.iter().any(|line| {
        line.trim_start_matches(['❯', '›', ' '])
            .starts_with("1. Yes")
    });
    let reject = lines.iter().any(|line| {
        let line = line.trim_start_matches(['❯', '›', ' ']);
        line.starts_with("2. No") || line.starts_with("3. No")
    });
    (footer && question && selected && yes && reject).then_some(TerminalAttention::Confirmation)
}

#[cfg(test)]
mod tests {
    use super::*;
    const CLAUDE: &str = "Bash command\n  npm test\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No\nEsc to cancel · Tab to amend";
    // Native Claude's two-choice read-permission prompt, as captured by tmux.
    const CLAUDE_NATIVE: &str = "Bash command\n  sed -n '40,95p' component.tsx\nRead component source\n\n │ A command the shell parser cannot analyze asks the person\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel · Tab to amend\n";
    const CODEX: &str = "Would you like to run the following command?\n$ cargo test\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\nPress enter to confirm or esc to cancel";

    #[test]
    fn recognizes_live_claude_and_codex_confirmations() {
        for (command, screen) in [("claude", CLAUDE), ("codex", CODEX), ("node", CODEX)] {
            assert_eq!(
                detect(Some(command), screen),
                Some(TerminalAttention::Confirmation)
            );
        }
    }
    #[test]
    fn native_claude_is_captured_and_detected() {
        assert!(supports_command(Some("claude.exe")));
        assert_eq!(
            detect(Some("claude.exe"), CLAUDE_NATIVE),
            Some(TerminalAttention::Confirmation)
        );
        let moved = CLAUDE_NATIVE
            .replace("❯ 1.", "  1.")
            .replace("  2.", "❯ 2.");
        assert_eq!(
            detect(Some("claude.exe"), &moved),
            Some(TerminalAttention::Confirmation)
        );
        assert_eq!(detect(Some("claude.exe"), "❯ \nReady for input"), None);
        assert_eq!(
            detect(
                Some("claude.exe"),
                &format!("{CLAUDE_NATIVE}Running\nResult\nReady")
            ),
            None
        );
    }

    #[test]
    fn native_alias_keeps_the_capture_gate_and_prompt_checks_conservative() {
        for command in [
            None,
            Some("zsh"),
            Some("bash"),
            Some("my-claude.exe"),
            Some("claude.exe.bak"),
        ] {
            assert!(!supports_command(command));
            assert_eq!(detect(command, CLAUDE_NATIVE), None);
        }
        for incomplete in [
            CLAUDE_NATIVE.replace('❯', ""),
            CLAUDE_NATIVE.replace("Do you want to proceed?", ""),
            CLAUDE_NATIVE.replace("Esc to cancel · Tab to amend", ""),
            CLAUDE_NATIVE.replace("2. No", ""),
        ] {
            assert_eq!(detect(Some("claude.exe"), &incomplete), None);
        }
    }

    #[test]
    fn moving_the_selection_does_not_clear_attention() {
        let moved = CODEX.replace("› 1.", "  1.").replace("  2.", "› 2.");
        assert_eq!(
            detect(Some("codex"), &moved),
            Some(TerminalAttention::Confirmation)
        );
    }
    #[test]
    fn ignores_shells_logs_incomplete_prompts_and_resolved_history() {
        assert_eq!(detect(Some("zsh"), CLAUDE), None);
        assert_eq!(detect(None, CODEX), None);
        assert_eq!(detect(Some("codex"), "Finished. Waiting for input"), None);
        assert_eq!(
            detect(
                Some("codex"),
                "Would you like to run the following command?"
            ),
            None
        );
        assert_eq!(detect(Some("codex"), &CODEX.replace('›', "")), None);
        assert_eq!(
            detect(Some("codex"), &format!("{CODEX}\nRunning\nResult\nReady")),
            None
        );
        assert_eq!(detect(Some("claude"), ""), None);
    }
}
