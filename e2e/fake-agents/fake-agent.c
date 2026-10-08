/*
 * Fake Claude Code / Codex CLI for the container E2E suite.
 *
 * Built as a native binary named `claude` or `codex` so it looks like the
 * real CLIs to tmux (pane_current_command reads argv[0]; a shell script
 * would show up as `bash`) and to the Node's process scan. It prints any
 * first-message prompt verbatim, then stays alive.
 */
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#ifdef SESSION_FILES
/*
 * With FAKE_TASKS set, write the files real Claude Code keeps for a live
 * session: ~/.claude/sessions/<pid>.json (naming this tmux pane) and a
 * finished two-item task list under ~/.claude/tasks/<session>/. The work is
 * done by a child shell, so this process keeps the name `claude`.
 */
static void write_session_files(void) {
    if (!getenv("FAKE_TASKS")) return;
    char command[2048];
    snprintf(command, sizeof command,
        "sid=$(cat /proc/sys/kernel/random/uuid); "
        "dir=\"$HOME/.claude\"; mkdir -p \"$dir/sessions\" \"$dir/tasks/$sid\"; "
        "pane=$(tmux display-message -p '#S:#{window_id}.#{pane_id}'); "
        "printf '{\"pid\":%d,\"sessionId\":\"%%s\",\"tmux\":\"%%s\",\"status\":\"idle\"}' \"$sid\" \"$pane\" > \"$dir/sessions/%d.json\"; "
        "printf '{\"id\":\"1\",\"subject\":\"Find the cause\",\"description\":\"\",\"status\":\"completed\",\"blocks\":[],\"blockedBy\":[]}' > \"$dir/tasks/$sid/1.json\"; "
        "printf '{\"id\":\"2\",\"subject\":\"Backfill orders\",\"description\":\"\",\"status\":\"completed\",\"blocks\":[],\"blockedBy\":[]}' > \"$dir/tasks/$sid/2.json\"",
        (int)getpid(), (int)getpid());
    if (system(command) != 0) fprintf(stderr, "fake agent: could not write session files\n");
}
#endif

#ifndef AGENT
#define AGENT "CLAUDE"
#endif

int main(int argc, char **argv) {
    printf("FAKE-%s ready\n", AGENT);
    if (argc > 1) printf("PROMPT-BEGIN\n%s\nPROMPT-END\n", argv[1]);
    fflush(stdout);
#ifdef SESSION_FILES
    write_session_files();
#endif
    for (;;) sleep(1);
}
