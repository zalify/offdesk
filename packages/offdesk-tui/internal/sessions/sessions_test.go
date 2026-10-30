package sessions

import (
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/config"
	"testing"
	"time"
)

func TestTabs(t *testing.T) {
	c := config.Config{}
	Add(&c, config.Tab{Machine: "m", Terminal: "a"})
	Add(&c, config.Tab{Machine: "m", Terminal: "b"})
	Switch(&c, 1)
	if c.Active != 0 {
		t.Fatal("wrap")
	}
	Add(&c, config.Tab{Machine: "m", Terminal: "b"})
	if len(c.Tabs) != 2 || c.Active != 1 {
		t.Fatal("dedup")
	}
	Remove(&c)
	if len(c.Tabs) != 1 || c.Active != 0 {
		t.Fatal("remove")
	}
}

func TestPruneOnlyMissingOnlineTabs(t *testing.T) {
	c := config.Config{Active: 2, Tabs: []config.Tab{{Machine: "online", Terminal: "old"}, {Machine: "offline", Terminal: "keep"}, {Machine: "online", Terminal: "live"}}}
	removed := Prune(&c, []api.Machine{{ID: "online"}}, []api.Terminal{{Machine: "online", ID: "live"}})
	if removed != 1 || len(c.Tabs) != 2 || c.Tabs[0].Terminal != "keep" || c.Tabs[1].Terminal != "live" || c.Active != 1 {
		t.Fatalf("incorrect pruning: %+v", c)
	}
}
func TestPrunePreservesWhenMachineOffline(t *testing.T) {
	c := config.Config{Tabs: []config.Tab{{Machine: "offline", Terminal: "running"}}}
	if Prune(&c, nil, nil) != 0 || len(c.Tabs) != 1 {
		t.Fatal("discarded an offline tab")
	}
}
func TestRememberDetachedKeepsServerNotTab(t *testing.T) {
	c := config.Config{}
	tab := config.Tab{Machine: "m", TmuxServer: "offdesk-tui-test"}
	RememberDetached(&c, tab)
	RememberDetached(&c, tab)
	if len(c.DetachedTmux) != 1 || len(c.Tabs) != 0 {
		t.Fatal("detached server was not kept separately")
	}
}

func TestRecentExitSuppressesOnlyMatchingTerminalTemporarily(t *testing.T) {
	now := time.Unix(1000, 0)
	cfg := config.Config{}
	RememberExit(&cfg, config.Tab{Machine: "m", Terminal: "exited"}, now)
	ts := []api.Terminal{{Machine: "m", ID: "exited"}, {Machine: "m", ID: "live"}, {Machine: "other", ID: "exited"}}
	visible, changed := VisibleAtStartup(&cfg, ts, now.Add(time.Second))
	if changed || len(visible) != 2 || visible[0].ID != "live" || visible[1].Machine != "other" {
		t.Fatalf("wrong startup terminals: %+v", visible)
	}
	visible, changed = VisibleAtStartup(&cfg, ts, now.Add(31*time.Second))
	if !changed || len(visible) != 3 || len(cfg.RecentExits) != 0 {
		t.Fatal("suppression did not expire")
	}
	RememberExit(&cfg, config.Tab{Machine: "m", Terminal: "exited"}, now)
	_, changed = VisibleAtStartup(&cfg, ts[1:], now)
	if !changed || len(cfg.RecentExits) != 0 {
		t.Fatal("notice not cleared when terminal vanished")
	}
}
