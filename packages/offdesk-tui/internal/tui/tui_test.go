package tui

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/config"
	"offdesk-tui/internal/sessions"
	"offdesk-tui/internal/testhub"
	"offdesk-tui/internal/transport"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testConfigHome(t *testing.T) {
	t.Helper()
	root := t.TempDir()
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", root)
}

func TestStartWithoutTerminalsCreatesDirectly(t *testing.T) {
	h := testhub.Start(t)
	h.ClearTerminals()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	testConfigHome(t)
	var out bytes.Buffer
	cfg := config.Config{Prefix: 29}
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("\r")
	if e = u.choose(true); e != nil {
		t.Fatal(e)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "new" || cfg.Tabs[0].TmuxServer != "" || !strings.Contains(h.Startup(), "tmux -L default attach-session") {
		t.Fatal("expected automatic tmux terminal")
	}
	if strings.Contains(out.String(), "Terminal number") {
		t.Fatal("unexpected prompt")
	}
}
func TestControlMenuTakeAndReturn(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	var out bytes.Buffer
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "existing"}}}
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("t\r")
	u.input <- []byte("\r")
	if e = u.controlMenu(); e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(out.String(), "This device has control") {
		t.Fatal("control not reflected")
	}
}
func TestChooseMachineBeforeAutomaticCreate(t *testing.T) {
	h := testhub.Start(t)
	h.ClearTerminals()
	h.AddSecondMachine()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	testConfigHome(t)
	var out bytes.Buffer
	cfg := config.Config{Prefix: 29}
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("2\r")
	u.input <- []byte("2\r")
	if e = u.choose(true); e != nil {
		t.Fatal(e)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Machine != "machine-b" {
		t.Fatal("created on wrong machine")
	}
	if !strings.Contains(out.String(), "Select a machine") {
		t.Fatal("machine choice was not shown")
	}
	if h.Startup() != "" {
		t.Fatal("Offdesk shell should not start nested tmux")
	}
}

func TestReconcileRemovesOnlyConfirmedClosedTabs(t *testing.T) {
	h := testhub.Start(t)
	h.ClearTerminals()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "closed"}, {Machine: "offline", Terminal: "unknown"}}}
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx}
	if e = u.reconcileTabs(); e != nil {
		t.Fatal(e)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "unknown" {
		t.Fatal("closed or offline tabs handled incorrectly")
	}
	saved, e := config.Load()
	if e != nil || len(saved.Tabs) != 1 || saved.Tabs[0].Terminal != "unknown" {
		t.Fatal("pruning was not persisted")
	}
}
func TestReconcileKeepsTabsWhenDiscoveryFails(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	c.Close()
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "unknown"}}}
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx}
	if e = u.reconcileTabs(); e == nil {
		t.Fatal("expected discovery failure")
	}
	if len(cfg.Tabs) != 1 {
		t.Fatal("pruned during outage")
	}
}
func TestDetectSplitTmuxDetach(t *testing.T) {
	u := UI{}
	u.observeTmuxInput([]byte{2})
	u.observeTmuxInput([]byte{'d'})
	if u.lastTmuxDetach.IsZero() {
		t.Fatal("missed detach")
	}
}

func TestLocalPickerNavigatesDirectoriesWithArrowKeys(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.Mkdir(filepath.Join(home, "folder"), 0700); err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(home, "folder", "file.txt")
	if err := os.WriteFile(want, []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	u := UI{ctx: ctx, output: &bytes.Buffer{}, input: make(chan []byte, 4), readErr: make(chan error, 1)}
	u.input <- []byte("\x1b")
	u.input <- []byte("[C")
	u.input <- []byte("\r")
	got, err := u.localPicker()
	if err != nil || got != want {
		t.Fatalf("picker got %q, %v", got, err)
	}
}

func TestBrowserRejectsUnsafeRemoteNames(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../secret", "a/b", "bad\x00name"} {
		if validEntryName(name) {
			t.Fatalf("accepted %q", name)
		}
	}
	if !validEntryName("سلام.txt") {
		t.Fatal("rejected valid name")
	}
}

func TestStartupIgnoresRecentlyExitedTerminalStillInHub(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	sessions.RememberExit(&cfg, config.Tab{Machine: "machine", Terminal: "existing"}, time.Now())
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("\r")
	if e = u.choose(true); e != nil {
		t.Fatal(e)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "new" {
		t.Fatal("did not create a new terminal")
	}
	if strings.Contains(out.String(), "Terminal number") {
		t.Fatal("showed stale terminal prompt")
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 2 {
		t.Fatal("existing terminal was removed")
	}
}

func TestSocketChoiceCancelDoesNotCreateTerminal(t *testing.T) {
	h := testhub.Start(t)
	h.ClearTerminals()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("bad\r")
	u.input <- []byte("q\r")
	if err = u.choose(true); !errors.Is(err, io.EOF) {
		t.Fatalf("expected cancel, got %v", err)
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 0 || len(cfg.Tabs) != 0 {
		t.Fatal("created a terminal after cancellation")
	}
	if !strings.Contains(out.String(), "Choose 1 or 2.") {
		t.Fatal("invalid choice was not handled")
	}
}

func TestTabMenuSelectsAnySavedTab(t *testing.T) {
	h := testhub.Start(t)
	testConfigHome(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	cfg := config.Config{}
	for i := 0; i < 12; i++ {
		cfg.Tabs = append(cfg.Tabs, config.Tab{Machine: "machine", Terminal: fmt.Sprint(i), Label: fmt.Sprintf("Tab %d", i+1)})
	}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("12\r")
	if err := u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if cfg.Active != 10 || !strings.Contains(out.String(), "12  Tab 11") {
		t.Fatal("tab selection failed")
	}
	saved, err := config.Load()
	if err != nil || saved.Active != 10 {
		t.Fatal("selection was not saved")
	}
}

func TestTerminalListAddsDiscoveredTerminalOnce(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "another", Label: "Saved"}}}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("3\r")
	if err = u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 2 || cfg.Tabs[1].Terminal != "existing" || cfg.Active != 1 {
		t.Fatal("discovered terminal was not opened")
	}
	if !strings.Contains(out.String(), "Other / unknown:") {
		t.Fatal("missing discovery section")
	}
	if !strings.Contains(out.String(), "Test · codex") {
		t.Fatal("foreground process was not displayed")
	}
	out.Reset()
	u.input <- []byte("3\r")
	if err = u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 2 || strings.Count(out.String(), "Test · codex") != 1 {
		t.Fatal("duplicate terminal listed")
	}
}

func TestStartupCommandDoesNotBecomeTerminalLabel(t *testing.T) {
	for _, tc := range []struct{ title, want string }{
		{"~: exec env -u TMUX tmux -L offdesk-tui-123 -f /dev/null", "Isolated tmux"},
		{"exec env -u TMUX sh -c 'tmux -L default attach-session'", "Default tmux"},
		{"", "Shell"}, {"Codex", "Codex"},
	} {
		if got := terminalLabel(tc.title); got != tc.want {
			t.Fatalf("label %q: got %q", tc.title, got)
		}
	}
}

func TestNewTerminalCreatesDistinctTabsWithoutExistingPicker(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "existing", Label: "Original"}}}
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("2\r")
	u.input <- []byte("2\r")
	for i := 0; i < 2; i++ {
		if quit, err := u.local('n'); quit || err != nil {
			t.Fatalf("new terminal: %v", err)
		}
	}
	if len(cfg.Tabs) != 3 || cfg.Tabs[1].Terminal == cfg.Tabs[2].Terminal || cfg.Tabs[1].Label == cfg.Tabs[2].Label {
		t.Fatalf("tabs were not distinct: %+v", cfg.Tabs)
	}
	if cfg.Active != 2 || strings.Contains(out.String(), "Terminal number, n=new") {
		t.Fatal("new command opened the existing-terminal picker")
	}
	_, _, _, total, _ := h.Stats()
	if total != 3 {
		t.Fatalf("expected 3 remote terminals, got %d", total)
	}
	saved, err := config.Load()
	if err != nil || len(saved.Tabs) != 3 {
		t.Fatal("tabs were not persisted")
	}
}

func TestSocketGroupUsesKnownMetadataWithoutGuessing(t *testing.T) {
	if socketGroup(config.Tab{Socket: "default"}, "") != "Default tmux" {
		t.Fatal("default socket not grouped")
	}
	if socketGroup(config.Tab{Socket: "offdesk"}, "") != "Offdesk shell" {
		t.Fatal("offdesk socket not grouped")
	}
	if socketGroup(config.Tab{}, "tmux") != "Other / unknown" {
		t.Fatal("guessed socket from process name")
	}
	if socketGroup(config.Tab{}, "exec tmux -L default attach-session") != "Default tmux" {
		t.Fatal("known startup command not recognized")
	}
}

func TestTerminateRequiresYesAndTargetsSelectedTerminal(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "new", Label: "Disposable"}}}
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &bytes.Buffer{}, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("\r")
	if _, err = u.local('x'); !errors.Is(err, errCancelled) || len(cfg.Tabs) != 1 {
		t.Fatal("cancel did not preserve tab")
	}
	u.input <- []byte("yes\r")
	if quit, err := u.local('x'); err != nil || !quit || len(cfg.Tabs) != 0 {
		t.Fatalf("confirmed terminate failed: %v", err)
	}
}

func TestDetachedTerminalShowsStatusAndPreservesSocketOnReopen(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "existing", Label: "Work", Socket: "default"}}}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	quit, err := u.local('d')
	if err != nil || !quit || len(cfg.Tabs) != 0 || len(cfg.DetachedTabs) != 1 {
		t.Fatal("detach did not preserve metadata")
	}
	u.input <- []byte("1\r")
	if err = u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Default tmux:") || !strings.Contains(out.String(), "detached here") {
		t.Fatal("detached state or socket not displayed")
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Socket != "default" || cfg.Tabs[0].Label != "Work" || len(cfg.DetachedTabs) != 0 {
		t.Fatal("reattach did not restore tab metadata")
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 1 {
		t.Fatal("detach changed remote terminal")
	}
}

func TestChooseTerminateAllTerminatesAndPromptsNew(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 4), readErr: make(chan error, 1)}
	u.input <- []byte("x all\r")
	u.input <- []byte("yes\r")
	u.input <- []byte("\r") // for the auto-create socket prompt
	if err = u.choose(true); err != nil {
		t.Fatal(err)
	}
	_, _, _, remaining, _ := h.Stats()
	// "existing" was deleted, "new" was created
	if remaining != 1 || len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "new" {
		t.Fatalf("expected 1 remaining auto-created terminal, got %d, tabs: %+v", remaining, cfg.Tabs)
	}
}

func TestChooseTerminateSingleTerminal(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 4), readErr: make(chan error, 1)}
	u.input <- []byte("x 2\r")
	u.input <- []byte("yes\r")
	u.input <- []byte("q\r")
	if err = u.choose(false); !errors.Is(err, io.EOF) {
		t.Fatalf("expected EOF after q, got %v", err)
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 0 {
		t.Fatalf("expected 0 remaining terminals, got %d", remaining)
	}
}

func TestParseCommandAndIndices(t *testing.T) {
	cmd, arg := parseCommand("x all")
	if cmd != "x" || arg != "all" {
		t.Fatalf("expected x all, got %q %q", cmd, arg)
	}
	cmd, arg = parseCommand("x all -y")
	if cmd != "x" || arg != "all -y" {
		t.Fatalf("expected x all -y, got %q %q", cmd, arg)
	}
	cmd, arg = parseCommand("x 1,2,3")
	if cmd != "x" || arg != "1,2,3" {
		t.Fatalf("expected x 1,2,3, got %q %q", cmd, arg)
	}
	cmd, arg = parseCommand("d 1, 2")
	if cmd != "d" || arg != "1, 2" {
		t.Fatalf("expected d 1, 2, got %q %q", cmd, arg)
	}
	cmd, arg = parseCommand("a 3-5")
	if cmd != "a" || arg != "3-5" {
		t.Fatalf("expected a 3-5, got %q %q", cmd, arg)
	}
	cmd, arg = parseCommand("1,2")
	if cmd != "" || arg != "1,2" {
		t.Fatalf("expected '' 1,2, got %q %q", cmd, arg)
	}

	indices := parseIndices("1,2,3", 5)
	if len(indices) != 3 || indices[0] != 1 || indices[1] != 2 || indices[2] != 3 {
		t.Fatalf("expected [1 2 3], got %v", indices)
	}
	indices = parseIndices("1, 3, 2, 1", 5)
	if len(indices) != 3 || indices[0] != 1 || indices[1] != 3 || indices[2] != 2 {
		t.Fatalf("expected [1 3 2] deduplicated, got %v", indices)
	}
	indices = parseIndices("2-4", 5)
	if len(indices) != 3 || indices[0] != 2 || indices[1] != 3 || indices[2] != 4 {
		t.Fatalf("expected [2 3 4] from range, got %v", indices)
	}
	indices = parseIndices("0, 6, -1", 5)
	if len(indices) != 0 {
		t.Fatalf("expected empty for out-of-range, got %v", indices)
	}
}

func TestTabMenuAttachAndDetachCommaSeparated(t *testing.T) {
	h := testhub.Start(t)
	h.SetTerminals("tab1", "tab2")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{
		Tabs: []config.Tab{
			{Machine: "machine", Terminal: "tab1", Label: "Tab 1"},
			{Machine: "machine", Terminal: "tab2", Label: "Tab 2"},
		},
	}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 5), readErr: make(chan error, 1)}

	// 1. Detach tabs 1 and 2 using comma separated selection "d 1,2"
	u.input <- []byte("d 2,3\r")
	// 2. Attach tab 1 using "a 1"
	u.input <- []byte("a 2\r")
	// 3. Exit menu by hitting Enter (empty input)
	u.input <- []byte("\r")

	if err = u.tabMenu(); err != nil {
		t.Fatal(err)
	}

	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "tab1" {
		t.Fatalf("expected tab1 attached, got tabs: %+v", cfg.Tabs)
	}
	if len(cfg.DetachedTabs) != 1 || cfg.DetachedTabs[0].Terminal != "tab2" {
		t.Fatalf("expected tab2 detached, got detached: %+v", cfg.DetachedTabs)
	}
}

func TestChooseAttachMultipleCommaSeparated(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, Client: c, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	// Attach via "a 1" (testhub has 1 existing terminal)
	u.input <- []byte("a 2\r")
	if err = u.choose(false); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "existing" {
		t.Fatalf("expected 'existing' terminal attached, got %+v", cfg.Tabs)
	}
}

func TestTabMenuTerminateCommaSeparated(t *testing.T) {
	h := testhub.Start(t)
	h.SetTerminals("t1", "t2", "t3")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{
		Tabs: []config.Tab{
			{Machine: "machine", Terminal: "t1", Label: "T1"},
			{Machine: "machine", Terminal: "t2", Label: "T2"},
			{Machine: "machine", Terminal: "t3", Label: "T3"},
		},
	}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 5), readErr: make(chan error, 1)}

	// Terminate terminals 1 and 2 with comma separation "x 1,2"
	u.input <- []byte("x 2,3\r")
	u.input <- []byte("yes\r")
	// Exit menu
	u.input <- []byte("q\r")

	if err = u.tabMenu(); err != nil {
		t.Fatal(err)
	}

	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Terminal != "t3" {
		t.Fatalf("expected only t3 remaining, got %+v", cfg.Tabs)
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 1 {
		t.Fatalf("expected 1 remaining terminal on hub, got %d", remaining)
	}
}

func TestTerminalListAttachesExternalDefaultSocket(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("1\r")
	if err := u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Socket != "default" || cfg.Tabs[0].Terminal == "existing" || !strings.Contains(h.Startup(), "tmux -L default attach-session") {
		t.Fatalf("default socket was not opened: %+v", cfg.Tabs)
	}
	if !strings.Contains(out.String(), "t1  Default tmux") {
		t.Fatal("external default socket entry missing")
	}
}

func TestStartupPickerOffersDefaultSocketWithExistingShells(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("1\r")
	if err := u.choose(true); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[0].Socket != "default" || cfg.Tabs[0].Terminal == "existing" || !strings.Contains(h.Startup(), "tmux -L default attach-session") {
		t.Fatalf("unexpected startup tabs: %+v", cfg.Tabs)
	}
	if !strings.Contains(out.String(), "t1  Default tmux") || !strings.Contains(out.String(), "not open here") {
		t.Fatal(out.String())
	}
}

func TestStartupKeepsKnownDefaultAttachmentFirstAndReusesIt(t *testing.T) {
	h := testhub.Start(t)
	h.SetTerminals("existing", "zz-default")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "zz-default", Label: "Work", Socket: "default"}}}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 1), readErr: make(chan error, 1)}
	u.input <- []byte("1\r")
	if err := u.choose(true); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 1 || cfg.Tabs[cfg.Active].Terminal != "zz-default" || h.Startup() != "" {
		t.Fatalf("did not reuse default attachment: %+v", cfg.Tabs)
	}
	if !strings.Contains(out.String(), "1  Default tmux") {
		t.Fatal(out.String())
	}
}

func TestSocketChoiceDetachNeverSavesEmptyTerminalID(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, id, err := transport.Connect(ctx, h.Cred, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	testConfigHome(t)
	cfg := config.Config{}
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &bytes.Buffer{}, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("d 1\r")
	u.input <- []byte("q\r")
	if err := u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Tabs) != 0 || len(cfg.DetachedTabs) != 0 {
		t.Fatalf("saved synthetic socket as terminal: %+v", cfg)
	}
	_, _, _, remaining, _ := h.Stats()
	if remaining != 1 {
		t.Fatal("socket detach modified running terminals")
	}
}
