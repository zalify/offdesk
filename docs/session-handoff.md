# Hand off between Claude and Codex

Click **Hand off to Codex** or **Hand off to Claude** above the terminal, enter
what the other agent should do next, then choose **Prepare handoff**.

Offdesk checks the live foreground process instead of relying on the terminal
title. It recognizes Claude/Codex executable names, including their `.exe`
forms. When the source is identified, only the other agent's button is shown.

The destination must be reachable, on the same machine, and in the same working
directory. Offdesk prefers a previously used destination if it still runs the
right agent; otherwise it chooses the only matching agent. With several
matches it asks which session to use. With no matching agent it offers to open
a new terminal when you prepare the handoff. A failed process check requires a
destination choice rather than silently creating a duplicate.

The compact form only asks for the next step. **Context and destination** lets
you review or change the agent, terminal, original goal, recent terminal text,
and artifact paths. The original goal and artifact paths come from the previous
handoff; the first handoff uses your next step as its goal. Context uses a
bounded excerpt from the mounted terminal buffer (last 200 lines, at most
4,000 UTF-16 code units), falling back to the previous context or a factual
source-terminal reference. It is a potentially incomplete excerpt, not an
AI-written summary or native agent transcript. No terminal text is saved until
you prepare the handoff.

After saving, **Copy & open** copies the instructions and switches to the target.
Wait until the source has finished and the destination agent is ready, then
paste and submit. If copying fails, the dialog retains and selects the saved
instructions for manual copying. New terminals launch the named CLI in the
source directory; finish any sign-in/setup before pasting.

The app does not automatically type or submit instructions, infer that an agent
is idle, or resume native session IDs. Generic `node` processes and unrecognized
commands remain uncertain; correct them in details if necessary. An explicit
terminal selection can override the automatic match.

Prepared instructions are saved on the Hub for your other devices. Saving and
confirming require machine control. History contains the most recent 25 handoffs
involving the terminal. Saving retries use the same request ID and frozen
content. **I've submitted it to the agent** records your confirmation, not an
agent execution receipt.

Image/file paths are references only: Offdesk does not upload, generate, or
verify their contents. The target agent must have access to those paths and the
tools needed to perform the next step.
