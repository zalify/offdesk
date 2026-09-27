# Hand off between Claude and Codex

Use **Hand off to Codex** or **Hand off to Claude** above the active terminal
on desktop or mobile. The button presets the direction. This version prepares a manual handoff: you review and paste the instructions into
the destination agent yourself.

1. Wait for the source agent and any background work to finish.
2. Check the preset source agent and choose the existing destination terminal.
   Only reachable terminals on the same machine and working directory are
   offered. Check the terminal yourself; Offdesk does not identify its agent
   from the title or assume that sharing a directory means sharing a session.
3. If needed, choose **Open new Codex terminal** or **Open new Claude terminal**.
   This opens a new tab in the source directory and runs the named CLI. The CLI
   must already be installed and signed in on that machine. No handoff prompt
   is automatically sent. Complete any setup shown in the new terminal first.
4. Enter the original goal, the next step, and progress/context. Include relevant
   decisions, constraints, files, checks and unfinished work. Preview the exact
   instructions, then choose **Prepare handoff**.
5. Choose **Copy & open Codex** (or **Copy & open Claude**), then paste into
   the idle agent prompt. The button copies the saved instructions and switches
   terminals; it does not submit them. If clipboard access is unavailable, the
   dialog stays open so you can copy from the selectable instructions field,
   then use **Open Codex terminal** or **Open Claude terminal**. You can also
   use **Copy instructions** without switching. Do not paste into a shell or an
   approval dialog.
6. Reopen **Handoff ready to paste** and choose **I’ve submitted it to the agent**
   after you have submitted it. That status records your confirmation; it does
   not verify that the agent accepted or completed the task.

To hand back, choose the highlighted **Hand back to Claude** or **Hand back to
Codex** button in the destination terminal. The previous source terminal is
suggested and the original goal is retained. Add the new progress
and next step, then prepare the return handoff. Keeping the original terminal
open keeps its existing agent process available. If that process has exited,
restore the correct native session yourself before pasting; this release does
not automatically resume native session IDs.

## Images and other artifacts

Enter actual shared file paths and their purposes in **Artifact paths**, for
example `assets/hero.png — landing-page illustration`. Reference images must
also be accessible to the target agent. The field does not upload, generate,
inspect, or verify a file.

An image-generation request can be the next step when the target agent supports
it. Ask the agent to save the output into the shared project, then include those
paths in the return handoff. Offdesk does not supply an image-generation service
or infer access from a subscription. The local capability probe may report the
Codex `image_generation` feature flag, but that flag alone does not demonstrate
successful generation or access on another machine.

## Saved records and recovery

Prepared instructions are stored on the Hub, scoped to the signed-in user and
machine. **Handoff history** shows the most recent 25 records involving the
current terminal. Reloading the page or opening that terminal from another
device loads the same records. The list refreshes when entering a terminal or
refocusing the app; it is not a live delivery feed.

Saving and confirming require control of the machine. Other devices can view
the records. Repeating a failed save uses the same request ID and exact content;
the Hub returns the existing record instead of overwriting it. An ID reused
with different instructions is rejected. Clipboard failure does not discard
the saved packet. A closed destination terminal does not delete the record.

Only the text entered in the form is saved. Offdesk does not copy full terminal
history, generate a summary, inspect Git changes, stop agents, lock files, or
automatically type into a terminal during this flow. Keep changes in the same
worktree and include any important pre-existing edits in the handoff context.
