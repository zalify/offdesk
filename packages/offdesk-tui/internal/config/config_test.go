package config

import (
	"offdesk-tui/internal/transport"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateAtomicConfig(t *testing.T) {
	root := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", root)
	c := Config{Prefix: 29, Credentials: transport.Credentials{Hub: "https://example.test", PrivateKey: []byte("fixture")}, Tabs: []Tab{{Machine: "m", Terminal: "t"}}}
	if e := Save(c); e != nil {
		t.Fatal(e)
	}
	path, e := Path()
	if e != nil {
		t.Fatal(e)
	}
	fi, e := os.Stat(path)
	if e != nil {
		t.Fatal(e)
	}
	if fi.Mode().Perm() != 0600 {
		t.Fatal("configuration not private")
	}
	di, e := os.Stat(filepath.Dir(path))
	if e != nil || di.Mode().Perm() != 0700 {
		t.Fatal("directory not private")
	}
	got, e := Load()
	if e != nil || got.Credentials.Hub != c.Credentials.Hub || len(got.Tabs) != 1 {
		t.Fatalf("load failed: %v", e)
	}
	if e = os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = Load(); e == nil {
		t.Fatal("accepted public credential file")
	}
}
