//! Conservative screen adapter, not an agent lifecycle signal. Never infer
//! completion from silence or copy terminal contents into the status protocol.
use offdesk_protocol::TerminalAttention;

/// Shared by the capture gate and screen adapter. Claude's native build can
/// report `claude.exe` as pane_current_command even on macOS.
pub fn supports_command(command: Option<&str>) -> bool {
    matches!(command, Some("claude" | "claude.exe" | "codex" | "node"))
}

/// A menu line without its highlight marker ("❯ No, exit" → "No, exit").
fn option_text(line: &str) -> &str {
    line.trim().trim_start_matches(['❯', '›']).trim_start()
}

fn highlighted(line: &str) -> bool {
    let line = line.trim();
    line.starts_with('❯') || line.starts_with('›')
}

/// Claude Code's prompt before it works in a folder it hasn't opened: its two
/// unnumbered options with one highlighted, and its keyboard footer at the bottom.
fn folder_trust(lines: &[&str]) -> bool {
    // Its footer is the last line while it's live
    let footer = lines.last().is_some_and(|line| {
        let line = line.to_ascii_lowercase();
        line.contains("enter to confirm") && line.contains("esc to cancel")
    });
    let yes = lines.iter().position(|line| option_text(line) == offdesk_protocol::FOLDER_TRUST_YES);
    let no = lines.iter().position(|line| option_text(line) == "No, exit");
    let options_highlighted = [yes, no].iter().flatten().any(|&i| highlighted(lines[i]));
    footer && yes.zip(no).is_some_and(|(y, n)| y.abs_diff(n) == 1) && options_highlighted
}

/// How many lines down (positive) or up the highlight must move to reach the option
/// reading `label`, on this screen; None when the option or the highlight isn't there.
/// The highlight nearest to the option counts (a prompt line can also start with ❯).
pub fn choose_moves(screen: &str, label: &str) -> Option<i32> {
    let lines: Vec<_> = screen.lines().filter(|line| !line.trim().is_empty()).collect();
    let target = lines.iter().rposition(|line| option_text(line) == label.trim())?;
    let current = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| highlighted(line))
        .min_by_key(|(i, _)| i.abs_diff(target))?
        .0;
    // A menu is a few adjacent lines; anything further is something else on the screen
    (current.abs_diff(target) <= 9).then(|| target as i32 - current as i32)
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
    if folder_trust(&lines) {
        return Some(TerminalAttention::FolderTrust);
    }
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

    // Claude Code 2.1's folder trust prompt, as captured by tmux in a new folder
    const TRUST: &str = " Accessing workspace:\n /private/tmp/work\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team). If not, take a moment to review what's in this folder first.\n Claude Code'll be able to read, edit, and execute files here.\n Security guide\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n";

    #[test]
    fn recognizes_claude_folder_trust_apart_from_confirmations() {
        assert_eq!(detect(Some("claude.exe"), TRUST), Some(TerminalAttention::FolderTrust));
        let moved = TRUST.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust", "❯ Yes, I trust");
        assert_eq!(detect(Some("claude"), &moved), Some(TerminalAttention::FolderTrust));
        // Not while something else is on top, not without its footer, not in a shell
        assert_eq!(detect(Some("claude"), &format!("{TRUST}Working…\n")), None);
        assert_eq!(detect(Some("claude"), &TRUST.replace("Enter to confirm · Esc to cancel", "")), None);
        assert_eq!(detect(Some("claude"), &TRUST.replace('❯', " ")), None);
        assert_eq!(detect(Some("zsh"), TRUST), None);
        // A confirmation is still one
        assert_eq!(detect(Some("claude"), CLAUDE), Some(TerminalAttention::Confirmation));
    }

    #[test]
    fn choosing_moves_the_highlight_from_wherever_it_is() {
        assert_eq!(choose_moves(TRUST, "Yes, I trust this folder"), Some(1));
        assert_eq!(choose_moves(TRUST, "No, exit"), Some(0));
        let moved = TRUST.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust", "❯ Yes, I trust");
        assert_eq!(choose_moves(&moved, "Yes, I trust this folder"), Some(0));
        assert_eq!(choose_moves(&moved, "No, exit"), Some(-1));
        assert_eq!(choose_moves(TRUST, "Yes, proceed"), None, "not on the screen");
        assert_eq!(choose_moves(&TRUST.replace('❯', " "), "No, exit"), None, "no highlight");
    }

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
