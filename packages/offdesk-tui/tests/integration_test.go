package tests

import (
	"bytes"
	"context"
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/files"
	"offdesk-tui/internal/testhub"
	"offdesk-tui/internal/transport"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestEncryptedApplicationLifecycle(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, device, e := transport.Connect(ctx, h.Cred, "test-code")
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	a := api.API{C: c, Device: device}
	if e = a.Me(ctx); e != nil {
		t.Fatal(e)
	}
	ms, e := a.Machines(ctx)
	if e != nil || len(ms) != 1 {
		t.Fatalf("machines %v %v", ms, e)
	}
	ts, e := a.Terminals(ctx)
	if e != nil || len(ts) != 1 || ts[0].ID != "existing" {
		t.Fatalf("terminals %v %v", ts, e)
	}
	id, ch, e := c.Open(ctx, transport.TerminalPath("machine", "existing", device))
	if e != nil {
		t.Fatal(e)
	}
	select {
	case m := <-ch:
		if !bytes.Contains(m.Binary, []byte(" 世界")) {
			t.Fatalf("output %q", m.Binary)
		}
	case <-ctx.Done():
		t.Fatal("output timeout")
	}
	for _, s := range []string{"a", "\x1bm", "\x03", "\x02", "\x1b[A", "世界"} {
		if e = c.Text(ctx, id, map[string]string{"type": "input", "data": s}); e != nil {
			t.Fatal(e)
		}
		select {
		case m := <-ch:
			if string(m.Binary) != s {
				t.Fatalf("key %q != %q", m.Binary, s)
			}
		case <-ctx.Done():
			t.Fatal("input timeout")
		}
	}
	if e = c.Text(ctx, id, map[string]any{"type": "resize", "cols": 100, "rows": 40}); e != nil {
		t.Fatal(e)
	}
	if e = a.Control(ctx, "machine", true); e != nil {
		t.Fatal(e)
	}
	if e = c.CloseSocket(ctx, id); e != nil {
		t.Fatal(e)
	}
	ts, e = a.Terminals(ctx)
	if e != nil || len(ts) != 1 {
		t.Fatal("detach killed terminal")
	}
	v, e := a.Create(ctx, "machine", "/home/test", 80, 24)
	if e != nil || v.ID != "new" {
		t.Fatalf("create %v %v", v, e)
	}
	if e = a.Destroy(ctx, "machine", "new"); e != nil {
		t.Fatal(e)
	}
	dir := t.TempDir()
	local := filepath.Join(dir, "download")
	if e = files.Download(ctx, a, "machine", "/note.txt", local, false, nil); e != nil {
		t.Fatal(e)
	}
	if e = files.Download(ctx, a, "machine", "/note.txt", local, false, nil); e == nil {
		t.Fatal("overwrote without confirmation")
	}
	if e = os.WriteFile(local, []byte("new text 世界\n"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = files.Replace(ctx, a, "machine", local, "/note.txt", true, nil); e != nil {
		t.Fatal(e)
	}
	if e = files.Download(ctx, a, "machine", "/note.txt", local, true, nil); e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(local)
	if e != nil || string(b) != "new text 世界\n" {
		t.Fatalf("file %q %v", b, e)
	}
	h.Drop()
	select {
	case <-c.Done():
	case <-ctx.Done():
		t.Fatal("disconnect detection")
	}
	cred := h.Cred
	cred.DeviceID = device
	c2, _, e := transport.Connect(ctx, cred, "")
	if e != nil {
		t.Fatal(e)
	}
	defer c2.Close()
	a.C = c2
	ts, e = a.Terminals(ctx)
	if e != nil || len(ts) != 1 || ts[0].ID != "existing" {
		t.Fatal("reconnect lost terminal")
	}
	id, ch, e = c2.Open(ctx, transport.TerminalPath("machine", "existing", device))
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-ch:
	case <-ctx.Done():
		t.Fatal("reattach timeout")
	}
	inputs, resizes, closes, remaining, connections := h.Stats()
	if len(inputs) != 6 || inputs[0] != "a" || inputs[1] != "\x1bm" || inputs[2] != "\x03" || resizes != 1 || closes != 1 || remaining != 1 || connections != 2 {
		t.Fatalf("stats %q %d %d %d %d", inputs, resizes, closes, remaining, connections)
	}
}
func TestRejectWrongPinnedKeyAndAuthentication(t *testing.T) {
	h := testhub.Start(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	bad := h.Cred
	bad.PublicKey = make([]byte, 32)
	if c, _, e := transport.Connect(ctx, bad, "test-code"); e == nil {
		c.Close()
		t.Fatal("wrong key accepted")
	}
	if c, _, e := transport.Connect(ctx, h.Cred, "wrong-code"); e == nil {
		c.Close()
		t.Fatal("wrong auth accepted")
	}
}
