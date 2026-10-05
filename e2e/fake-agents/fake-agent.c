/*
 * Fake Claude Code / Codex CLI for the container E2E suite.
 *
 * Built as a native binary named `claude` or `codex` so it looks like the
 * real CLIs to tmux (pane_current_command reads argv[0]; a shell script
 * would show up as `bash`) and to the Node's process scan. It prints any
 * first-message prompt verbatim, optionally shows Claude's usage-limit
 * notice, then stays alive.
 */
#include <stdio.h>
#include <unistd.h>

#ifndef AGENT
#define AGENT "CLAUDE"
#endif

int main(int argc, char **argv) {
    printf("FAKE-%s ready\n", AGENT);
    if (argc > 1) printf("PROMPT-BEGIN\n%s\nPROMPT-END\n", argv[1]);
#ifdef USAGE_LIMIT
    printf("\n\xe2\x9c\xbb Usage limit reached \xc2\xb7 resets 3pm\n");
#endif
    fflush(stdout);
    for (;;) sleep(1);
}
