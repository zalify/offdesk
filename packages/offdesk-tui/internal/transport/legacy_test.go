package transport

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestLegacyLiveStreamAndDetach(t *testing.T) {
	const token = "fake-token"
	seen := make(chan string, 8)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/auth/me", "/api/terminals":
			if r.Header.Get("Authorization") != "Bearer "+token {
				w.WriteHeader(401)
				return
			}
			if r.URL.Path == "/api/terminals" {
				_, _ = w.Write([]byte(`[{"id":"existing"}]`))
			} else {
				_, _ = w.Write([]byte(`{"id":"owner"}`))
			}
		case "/ws/terminal/m/existing":
			if r.URL.Query().Get("token") != token || r.URL.Query().Get("device_id") != "device" {
				w.WriteHeader(401)
				return
			}
			ws, e := websocket.Accept(w, r, nil)
			if e != nil {
				return
			}
			defer ws.CloseNow()
			ctx := r.Context()
			if ws.Write(ctx, websocket.MessageBinary, []byte("hello ")) != nil {
				return
			}
			for {
				typ, b, e := ws.Read(ctx)
				if e != nil {
					return
				}
				if typ == websocket.MessageText {
					var m map[string]any
					if json.Unmarshal(b, &m) != nil {
						return
					}
					if m["type"] == "input" {
						s, _ := m["data"].(string)
						seen <- s
					}
					if ws.Write(ctx, websocket.MessageBinary, b) != nil {
						return
					}
				}
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cred := Credentials{Hub: server.URL, Token: token, DeviceID: "device"}
	c, _, e := connectLegacy(ctx, cred, server.Client())
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	m, e := c.Request(ctx, "GET", "/api/terminals", nil)
	if e != nil || m.Body == nil {
		t.Fatal("discovery failed", e)
	}
	id, ch, e := c.Open(ctx, TerminalPath("m", "existing", "device"))
	if e != nil {
		t.Fatal(e)
	}
	select {
	case m := <-ch:
		if m.Type != "binary" || string(m.Binary) != "hello " {
			t.Fatal("bad output")
		}
	case <-ctx.Done():
		t.Fatal("output timeout")
	}
	if e = c.Text(ctx, id, map[string]string{"type": "input", "data": "\x1bm\x03"}); e != nil {
		t.Fatal(e)
	}
	select {
	case v := <-seen:
		if v != "\x1bm\x03" {
			t.Fatal("bad input")
		}
	case <-ctx.Done():
		t.Fatal("input timeout")
	}
	if e = c.CloseSocket(ctx, id); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Request(ctx, "GET", "/api/terminals", nil); e != nil {
		t.Fatal("detach broke session", e)
	}
}
