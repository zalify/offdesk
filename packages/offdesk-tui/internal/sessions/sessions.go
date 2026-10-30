// Package sessions manages persistent local tabs, never remote process lifetime.
package sessions

import (
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/config"
	"time"
)

func Add(c *config.Config, t config.Tab) {
	for i, old := range c.DetachedTabs {
		if old.Machine == t.Machine && old.Terminal == t.Terminal {
			if t.Socket == "" {
				t.Socket = old.Socket
			}
			if t.TmuxServer == "" {
				t.TmuxServer = old.TmuxServer
			}
			if old.Label != "" {
				t.Label = old.Label
			}
			c.DetachedTabs = append(c.DetachedTabs[:i], c.DetachedTabs[i+1:]...)
			break
		}
	}
	for i, v := range c.Tabs {
		if v.Machine == t.Machine && v.Terminal == t.Terminal {
			c.Active = i
			return
		}
	}
	c.Tabs = append(c.Tabs, t)
	c.Active = len(c.Tabs) - 1
}

// Detach remembers only enough local metadata to identify a still-running
// Offdesk terminal and distinguish it from terminals opened elsewhere.
func Detach(c *config.Config) {
	if c.Active < 0 || c.Active >= len(c.Tabs) {
		return
	}
	t := c.Tabs[c.Active]
	for i, old := range c.DetachedTabs {
		if old.Machine == t.Machine && old.Terminal == t.Terminal {
			c.DetachedTabs[i] = t
			Remove(c)
			return
		}
	}
	c.DetachedTabs = append(c.DetachedTabs, t)
	Remove(c)
}

// RememberExit suppresses a recently closed attachment from automatic startup
// selection while the node's asynchronous session watcher catches up.
func RememberExit(c *config.Config, tab config.Tab, now time.Time) {
	kept := c.RecentExits[:0]
	for _, v := range c.RecentExits {
		if v.Until > now.Unix() && (v.Machine != tab.Machine || v.Terminal != tab.Terminal) {
			kept = append(kept, v)
		}
	}
	c.RecentExits = append(kept, config.RecentExit{Machine: tab.Machine, Terminal: tab.Terminal, Until: now.Add(30 * time.Second).Unix()})
}

// VisibleAtStartup expires notices and keeps all non-matching terminals visible.
// The explicit open menu still lists every terminal regardless of this hint.
func VisibleAtStartup(c *config.Config, terminals []api.Terminal, now time.Time) ([]api.Terminal, bool) {
	kept := c.RecentExits[:0]
	for _, v := range c.RecentExits {
		if v.Until <= now.Unix() {
			continue
		}
		found := false
		for _, t := range terminals {
			if t.Machine == v.Machine && t.ID == v.Terminal {
				found = true
				break
			}
		}
		if found {
			kept = append(kept, v)
		}
	}
	changed := len(kept) != len(c.RecentExits)
	c.RecentExits = kept
	visible := make([]api.Terminal, 0, len(terminals))
	for _, t := range terminals {
		suppressed := false
		for _, v := range kept {
			if v.Machine == t.Machine && v.Terminal == t.ID {
				suppressed = true
				break
			}
		}
		if !suppressed {
			visible = append(visible, t)
		}
	}
	return visible, changed
}
func Switch(c *config.Config, delta int) {
	if len(c.Tabs) > 0 {
		c.Active = (c.Active + delta + len(c.Tabs)) % len(c.Tabs)
	}
}
func Remove(c *config.Config) {
	if c.Active < 0 || c.Active >= len(c.Tabs) {
		return
	}
	c.Tabs = append(c.Tabs[:c.Active], c.Tabs[c.Active+1:]...)
	if c.Active >= len(c.Tabs) {
		c.Active = max(0, len(c.Tabs)-1)
	}
}

// RememberDetached preserves the address of an explicitly detached inner tmux
// server, separately from the Offdesk terminal tab which has closed.
func RememberDetached(c *config.Config, tab config.Tab) {
	if tab.Machine == "" || tab.TmuxServer == "" {
		return
	}
	for _, d := range c.DetachedTmux {
		if d.Machine == tab.Machine && d.Server == tab.TmuxServer {
			return
		}
	}
	c.DetachedTmux = append(c.DetachedTmux, config.DetachedTmux{Machine: tab.Machine, Server: tab.TmuxServer})
}

// Prune removes only tabs absent from a successful discovery snapshot for an
// online machine. Tabs belonging to offline machines must survive outages.
func Prune(c *config.Config, machines []api.Machine, terminals []api.Terminal) int {
	online := make(map[string]bool, len(machines))
	for _, m := range machines {
		online[m.ID] = true
	}
	type key struct{ machine, terminal string }
	live := make(map[key]bool, len(terminals))
	for _, t := range terminals {
		live[key{t.Machine, t.ID}] = true
	}
	oldActive := c.Active
	var active key
	hasActive := oldActive >= 0 && oldActive < len(c.Tabs)
	if hasActive {
		t := c.Tabs[oldActive]
		active = key{t.Machine, t.Terminal}
	}
	kept := make([]config.Tab, 0, len(c.Tabs))
	newActive := -1
	for _, t := range c.Tabs {
		k := key{t.Machine, t.Terminal}
		if online[t.Machine] && !live[k] {
			continue
		}
		if hasActive && k == active {
			newActive = len(kept)
		}
		kept = append(kept, t)
	}
	removed := len(c.Tabs) - len(kept)
	if removed == 0 {
		return 0
	}
	c.Tabs = kept
	if newActive >= 0 {
		c.Active = newActive
	} else if len(kept) > 0 {
		c.Active = min(max(oldActive, 0), len(kept)-1)
	} else {
		c.Active = 0
	}
	return removed
}
