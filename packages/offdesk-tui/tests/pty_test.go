//go:build linux || android

package tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"golang.org/x/sys/unix"
	"io"
	"offdesk-tui/internal/config"
	"offdesk-tui/internal/testhub"
	"offdesk-tui/internal/transport"
	"offdesk-tui/internal/tui"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestTUIChild(t *testing.T) {
	if os.Getenv("OFFDESK_PTY_CHILD") != "1" {
		return
	}
	c, e := config.Load()
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	u := tui.UI{Config: &c}
	if e = u.Run(ctx); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(2)
	}
	os.Exit(0)
}

type capture struct {
	sync.Mutex
	b bytes.Buffer
}

func (c *capture) Write(b []byte) (int, error) { c.Lock(); defer c.Unlock(); return c.b.Write(b) }
func (c *capture) contains(s string) bool {
	c.Lock()
	defer c.Unlock()
	return bytes.Contains(c.b.Bytes(), []byte(s))
}
func (c *capture) count(s string) int {
	c.Lock()
	defer c.Unlock()
	return bytes.Count(c.b.Bytes(), []byte(s))
}
func (c *capture) String() string { c.Lock(); defer c.Unlock(); return c.b.String() }
func await(t *testing.T, desc string, f func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !f() {
		if time.Now().After(deadline) {
			t.Fatal("timeout: " + desc)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestNativePTYInteractionAndReconnect(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, device, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	c.Close()
	cred := h.Cred
	cred.DeviceID = device
	fd, e := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if e != nil {
		t.Fatal("native PTY open:", e)
	}
	master := os.NewFile(uintptr(fd), "master")
	defer master.Close()
	if e = unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); e != nil {
		t.Fatal(e)
	}
	number, e := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if e != nil {
		t.Fatal(e)
	}
	slave, e := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer slave.Close()
	if e = unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: 80, Row: 24}); e != nil {
		t.Fatal(e)
	}
	root := t.TempDir()
	dir := filepath.Join(root, "offdesk-tui")
	if e = os.MkdirAll(dir, 0700); e != nil {
		t.Fatal(e)
	}
	cfg := config.Config{Credentials: cred, Prefix: 0x1d, Tabs: []config.Tab{{Machine: "machine", Terminal: "existing", Label: "Test"}}}
	b, _ := json.Marshal(cfg)
	if e = os.WriteFile(filepath.Join(dir, "config.json"), b, 0600); e != nil {
		t.Fatal(e)
	}
	localHome := t.TempDir()
	cmd := exec.Command(os.Args[0], "-test.run=^TestTUIChild$")
	cmd.Env = append(os.Environ(), "OFFDESK_PTY_CHILD=1", "XDG_CONFIG_HOME="+root, "HOME="+localHome)
	cmd.Stdin = slave
	cmd.Stdout = slave
	cmd.Stderr = slave
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer cmd.Process.Kill()
	var output capture
	go func() { _, _ = io.Copy(&output, master) }()
	await(t, "initial output", func() bool { return output.contains("hello  世界") })
	await(t, "terminal bell forwarded", func() bool { return output.contains("\x1b[0m\x07") })
	if !output.contains("Press Ctrl+] for commands and tabs.") {
		t.Fatal("startup shortcut hint was not shown")
	}
	if _, e = master.Write([]byte{0x1d, 's'}); e != nil {
		t.Fatal(e)
	}
	await(t, "tab list", func() bool { return output.contains("Offdesk · Terminals") })
	if _, e = master.Write([]byte("1\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "terminal after tab selection", func() bool { return output.count("hello  世界") >= 2 })
	if _, e = master.Write([]byte{0x1d}); e != nil {
		t.Fatal(e)
	}
	await(t, "prefix menu", func() bool { return output.contains("Offdesk · Commands") })
	if _, e = master.Write([]byte("c")); e != nil {
		t.Fatal(e)
	}
	await(t, "control menu", func() bool { return output.contains("Terminal control") })
	if _, e = master.Write([]byte("t\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "control acquired", func() bool { return output.contains("This device has control") })
	if _, e = master.Write([]byte("\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "control menu return", func() bool { return output.count("hello  世界") >= 3 })
	if _, e = master.Write([]byte{0x1d}); e != nil {
		t.Fatal(e)
	}
	await(t, "prefix menu again", func() bool { return output.count("Offdesk · Commands") >= 2 })
	if _, e = master.Write([]byte{0x1d}); e != nil {
		t.Fatal(e)
	}
	await(t, "literal prefix forwarded", func() bool {
		inputs, _, _, _, _ := h.Stats()
		return bytes.Contains([]byte(join(inputs)), []byte{0x1d})
	})
	if _, e = master.Write([]byte{0x1d, 'f'}); e != nil {
		t.Fatal(e)
	}
	await(t, "file menu", func() bool { return output.contains("Offdesk · Files") })
	if _, e = master.Write([]byte("\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "open remote folder", func() bool { return output.contains("/home/test/folder") })
	if _, e = master.Write([]byte("hj")); e != nil {
		t.Fatal(e)
	}
	await(t, "select remote file", func() bool { return output.contains(">   note.txt") })
	if _, e = master.Write([]byte("\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "download complete", func() bool { return output.contains("Downloaded to ") })
	dest := filepath.Join(localHome, "note.txt")
	if b, e := os.ReadFile(dest); e != nil || string(b) != "old text\n" {
		t.Fatal("wrong downloaded content")
	}
	if e = os.WriteFile(dest, []byte("changed text\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = master.Write([]byte("u")); e != nil {
		t.Fatal(e)
	}
	await(t, "upload picker", func() bool { return output.contains("Select local file") })
	if _, e = master.Write([]byte("\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "upload confirmation", func() bool { return output.contains("with local text file? Type yes") })
	if _, e = master.Write([]byte("yes\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "verified replacement", func() bool { return output.contains("and verified checksum") })
	helloAfterFiles := output.count("hello  世界")
	if _, e = master.Write([]byte("q")); e != nil {
		t.Fatal(e)
	}
	await(t, "terminal after file menu", func() bool { return output.count("hello  世界") > helloAfterFiles })
	attachment := filepath.Join(localHome, "fixture.bin")
	payload := []byte{0, 1, 2, 255}
	if e = os.WriteFile(attachment, payload, 0600); e != nil {
		t.Fatal(e)
	}
	_, resizeBefore, _, _, _ := h.Stats()
	filesBefore := output.count("Offdesk · Files")
	if _, e = master.Write([]byte{0x1d, 'f'}); e != nil {
		t.Fatal(e)
	}
	await(t, "attachment menu", func() bool { return output.count("Offdesk · Files") > filesBefore })
	if _, e = master.Write([]byte("a")); e != nil {
		t.Fatal(e)
	}
	await(t, "local picker", func() bool { return output.count("Select local file") >= 2 })
	if _, e = master.Write([]byte("\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "attachment confirmation", func() bool { return output.contains("Type yes to attach") })
	if _, e = master.Write([]byte("yes\r")); e != nil {
		t.Fatal(e)
	}
	await(t, "binary attachment", func() bool { return bytes.Equal(h.Attachment(), payload) })
	await(t, "attachment terminal resumed", func() bool { _, n, _, _, _ := h.Stats(); return n > resizeBefore })
	if _, e = master.Write([]byte("a\x1bm\x03\x02c世界")); e != nil {
		t.Fatal(e)
	}
	await(t, "forward all keys", func() bool {
		input, _, _, _, _ := h.Stats()
		return len(input) > 0 && bytes.Contains([]byte(join(input)), []byte("a\x1bm\x03\x02c世界"))
	})
	if e = unix.IoctlSetWinsize(fd, unix.TIOCSWINSZ, &unix.Winsize{Col: 100, Row: 30}); e != nil {
		t.Fatal(e)
	}
	if e = cmd.Process.Signal(syscall.SIGWINCH); e != nil {
		t.Fatal(e)
	}
	await(t, "resize", func() bool { _, n, _, _, _ := h.Stats(); return n >= 3 })
	helloBefore := output.count("hello  世界")
	h.Drop()
	await(t, "disconnect notice", func() bool { return output.contains("Disconnected:") })
	if _, e = master.Write([]byte("zzzz")); e != nil {
		t.Fatal(e)
	}
	await(t, "TUI reconnect", func() bool { _, _, _, _, n := h.Stats(); return n >= 3 })
	await(t, "resume rendering", func() bool { return output.count("hello  世界") > helloBefore })
	inputs, _, _, _, _ := h.Stats()
	if bytes.Contains([]byte(join(inputs)), []byte("zzzz")) {
		t.Fatal("offline input replayed")
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 1 {
		t.Fatal("reconnect killed remote terminal")
	}
	h.DelayExitRemoval()
	if _, e = master.Write([]byte{0x04}); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case e = <-done:
		if e != nil {
			t.Fatalf("TUI exit %v: %q", e, output.String())
		}
	case <-time.After(6 * time.Second):
		t.Fatalf("TUI exit timeout: %q", output.String())
	}
	_, _, _, remaining, _ = h.Stats()
	if remaining != 1 {
		t.Fatal("mock did not retain delayed discovery entry")
	}
	if output.contains("This terminal is no longer listed") {
		t.Fatal("Ctrl+D unexpectedly prompted for tab removal")
	}
	b, e = os.ReadFile(filepath.Join(dir, "config.json"))
	if e != nil {
		t.Fatal(e)
	}
	cfg = config.Config{}
	if e = json.Unmarshal(b, &cfg); e != nil {
		t.Fatal(e)
	}
	if len(cfg.Tabs) != 0 {
		t.Fatal("confirmed exited tab not removed")
	}
	if len(cfg.RecentExits) != 1 || cfg.RecentExits[0].Terminal != "existing" {
		t.Fatal("closed terminal was not marked for delayed discovery")
	}
}
func join(v []string) string {
	var b bytes.Buffer
	for _, s := range v {
		b.WriteString(s)
	}
	return b.String()
}
