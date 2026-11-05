// Package config stores credentials and local tabs in the user's config directory.
package config

import (
	"encoding/json"
	"errors"
	"offdesk-tui/internal/transport"
	"os"
	"path/filepath"
)

type Tab struct {
	Machine    string `json:"machine"`
	Terminal   string `json:"terminal"`
	Label      string `json:"label"`
	TmuxServer string `json:"tmux_server,omitempty"`
	Socket     string `json:"socket,omitempty"`
}
type DetachedTmux struct {
	Machine string `json:"machine"`
	Server  string `json:"server"`
}
type RecentExit struct {
	Machine  string `json:"machine"`
	Terminal string `json:"terminal"`
	Until    int64  `json:"until"`
}
type Config struct {
	Credentials  transport.Credentials `json:"credentials"`
	Prefix       byte                  `json:"prefix"`
	Compact      bool                  `json:"compact"`
	Tabs         []Tab                 `json:"tabs,omitempty"`
	DetachedTabs []Tab                 `json:"detached_tabs,omitempty"`
	DetachedTmux []DetachedTmux        `json:"detached_tmux,omitempty"`
	RecentExits  []RecentExit          `json:"recent_exits,omitempty"`
	Active       int                   `json:"active"`
}

func Path() (string, error) {
	d, e := os.UserConfigDir()
	if e != nil {
		return "", e
	}
	return filepath.Join(d, "offdesk-tui", "config.json"), nil
}
func Load() (Config, error) {
	var c Config
	p, e := Path()
	if e != nil {
		return c, e
	}
	info, e := os.Lstat(p)
	if e != nil {
		return c, e
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return c, errors.New("configuration must be a regular private file (chmod 600)")
	}
	b, e := os.ReadFile(p)
	if e != nil {
		return c, e
	}
	e = json.Unmarshal(b, &c)
	if c.Prefix == 0 {
		c.Prefix = 0x1d
	}
	return c, e
}
func Save(c Config) error {
	p, e := Path()
	if e != nil {
		return e
	}
	d := filepath.Dir(p)
	if e = os.MkdirAll(d, 0700); e != nil {
		return e
	}
	if e = os.Chmod(d, 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(d, ".config-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	b, e := json.MarshalIndent(c, "", "  ")
	if e == nil {
		_, e = f.Write(b)
	}
	if e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), p)
}
