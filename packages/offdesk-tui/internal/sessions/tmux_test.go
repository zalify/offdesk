package sessions

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestTmuxStartupAttachesOrCreatesDefaultSession(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, status, want string }{{"existing", "0", "attach-session"}, {"empty", "1", "new-session"}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			log := filepath.Join(dir, "calls")
			script := "#!" + sh + "\nprintf '%s TMUX=%s\\n' \"$*\" \"${TMUX-unset}\" >> \"$OFFDESK_TEST_LOG\"\nif [ \"$3\" = has-session ]; then exit \"$OFFDESK_TEST_STATUS\"; fi\n"
			if err := os.WriteFile(filepath.Join(dir, "tmux"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			cmd, server, err := TmuxStartup()
			if err != nil || server != "" {
				t.Fatalf("startup: %q %v", server, err)
			}
			child := exec.Command(sh, "-c", cmd)
			child.Env = append(os.Environ(), "PATH="+dir+string(os.PathListSeparator)+os.Getenv("PATH"), "TMUX=outer", "OFFDESK_TEST_LOG="+log, "OFFDESK_TEST_STATUS="+tc.status)
			if out, err := child.CombinedOutput(); err != nil {
				t.Fatalf("startup: %v %s", err, out)
			}
			data, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			want := "-L default has-session TMUX=unset\n-L default " + tc.want + " TMUX=unset\n"
			if strings.TrimSpace(string(data)) != strings.TrimSpace(want) {
				t.Fatalf("calls %q, want %q", data, want)
			}
		})
	}
}
