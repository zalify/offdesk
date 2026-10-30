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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	u.input <- []byte("11\r")
	if err := u.tabMenu(); err != nil {
		t.Fatal(err)
	}
	if cfg.Active != 10 || !strings.Contains(out.String(), "11  Tab 11") {
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfg := config.Config{Tabs: []config.Tab{{Machine: "machine", Terminal: "another", Label: "Saved"}}}
	var out bytes.Buffer
	u := UI{Config: &cfg, API: api.API{C: c, Device: id}, ctx: ctx, output: &out, input: make(chan []byte, 2), readErr: make(chan error, 1)}
	u.input <- []byte("2\r")
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
	u.input <- []byte("2\r")
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
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
