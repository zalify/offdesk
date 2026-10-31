// Package testhub is an isolated protocol fixture. It never contacts real nodes.
package testhub

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"github.com/flynn/noise"
	"net/http"
	"net/http/httptest"
	"offdesk-tui/internal/transport"
	"sort"
	"strings"
	"sync"
	"testing"
)

type Hub struct {
	Server           *httptest.Server
	Cred             transport.Credentials
	mu               sync.Mutex
	paired           bool
	terminals        map[string]bool
	content          []byte
	inputs           []string
	resizes          int
	closes           int
	connections      int
	controller       string
	startup          string
	attachment       []byte
	secondMachine    bool
	created          int
	delayExitRemoval bool
	streams          map[*websocket.Conn]bool
}

func (h *Hub) ClearTerminals()   { h.mu.Lock(); defer h.mu.Unlock(); h.terminals = map[string]bool{} }
func (h *Hub) SetTerminals(ids ...string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.terminals = make(map[string]bool)
	for _, id := range ids {
		h.terminals[id] = true
	}
}
func (h *Hub) Startup() string   { h.mu.Lock(); defer h.mu.Unlock(); return h.startup }
func (h *Hub) AddSecondMachine() { h.mu.Lock(); defer h.mu.Unlock(); h.secondMachine = true }
func (h *Hub) DelayExitRemoval() { h.mu.Lock(); defer h.mu.Unlock(); h.delayExitRemoval = true }
func (h *Hub) Attachment() []byte {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]byte(nil), h.attachment...)
}

func Start(t *testing.T) *Hub {
	t.Helper()
	hubKey, e := noise.DH25519.GenerateKeypair(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	clientKey, e := noise.DH25519.GenerateKeypair(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	h := &Hub{terminals: map[string]bool{"existing": true}, content: []byte("old text\n"), streams: map[*websocket.Conn]bool{}}
	h.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/secure" {
			http.NotFound(w, r)
			return
		}
		h.serve(w, r, hubKey)
	}))
	h.Cred = transport.Credentials{Hub: h.Server.URL, PublicKey: hubKey.Public, PrivateKey: clientKey.Private}
	t.Cleanup(func() { h.Drop(); h.Server.Close() })
	return h
}
func (h *Hub) Drop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.streams {
		c.CloseNow()
	}
}
func (h *Hub) Stats() ([]string, int, int, int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.inputs...), h.resizes, h.closes, len(h.terminals), h.connections
}

// fixtureCodec is deliberately separate from the client's implementation.
type fixtureCodec struct {
	send, recv *noise.CipherState
	next       uint64
	assembly   []byte
	id         uint64
	total      int
}

func (c *fixtureCodec) write(ctx context.Context, ws *websocket.Conn, b []byte) error {
	c.next++
	for off := 0; off < len(b); {
		end := min(off+16384, len(b))
		p := make([]byte, 16)
		binary.BigEndian.PutUint64(p, c.next)
		binary.BigEndian.PutUint32(p[8:], uint32(len(b)))
		binary.BigEndian.PutUint32(p[12:], uint32(off))
		p = append(p, b[off:end]...)
		r, e := c.send.Encrypt(nil, nil, p)
		if e != nil {
			return e
		}
		if e = ws.Write(ctx, websocket.MessageBinary, r); e != nil {
			return e
		}
		off = end
	}
	return nil
}
func (c *fixtureCodec) read(ctx context.Context, ws *websocket.Conn) ([]byte, error) {
	for {
		typ, b, e := ws.Read(ctx)
		if e != nil {
			return nil, e
		}
		if typ != websocket.MessageBinary {
			return nil, errors.New("expected binary")
		}
		b, e = c.recv.Decrypt(nil, nil, b)
		if e != nil || len(b) < 17 {
			return nil, errors.New("bad encrypted record")
		}
		id := binary.BigEndian.Uint64(b)
		total := int(binary.BigEndian.Uint32(b[8:]))
		off := int(binary.BigEndian.Uint32(b[12:]))
		if total > 32*1024*1024 {
			return nil, errors.New("oversize")
		}
		if off == 0 {
			c.id = id
			c.total = total
			c.assembly = nil
		}
		if id != c.id || total != c.total || off != len(c.assembly) {
			return nil, errors.New("bad fragment")
		}
		c.assembly = append(c.assembly, b[16:]...)
		if len(c.assembly) == total {
			return c.assembly, nil
		}
	}
}
func (c *fixtureCodec) json(ctx context.Context, ws *websocket.Conn, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return c.write(ctx, ws, append([]byte{0}, b...))
}
func (h *Hub) serve(w http.ResponseWriter, r *http.Request, key noise.DHKey) {
	ws, e := websocket.Accept(w, r, nil)
	if e != nil {
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(65535)
	ctx := r.Context()
	hs, e := noise.NewHandshakeState(noise.Config{CipherSuite: noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256), Pattern: noise.HandshakeIK, StaticKeypair: key, Prologue: []byte("offdesk-secure-v2")})
	if e != nil {
		return
	}
	_, b, e := ws.Read(ctx)
	if e != nil {
		return
	}
	if _, _, _, e = hs.ReadMessage(nil, b); e != nil {
		return
	}
	hello, recv, send, e := hs.WriteMessage(nil, nil)
	if e != nil {
		return
	}
	if e = ws.Write(ctx, websocket.MessageBinary, hello); e != nil {
		return
	}
	codec := fixtureCodec{send: send, recv: recv}
	b, e = codec.read(ctx, ws)
	if e != nil {
		return
	}
	var auth map[string]string
	if json.Unmarshal(b, &auth) != nil {
		return
	}
	h.mu.Lock()
	ready := h.paired && auth["type"] == "resume"
	if auth["type"] == "pair" && auth["code"] == "test-code" {
		h.paired = true
		ready = true
	}
	h.mu.Unlock()
	if !ready {
		b, _ = json.Marshal(map[string]string{"type": "rejected", "message": "no"})
		_ = codec.write(ctx, ws, b)
		return
	}
	b, _ = json.Marshal(map[string]string{"type": "ready", "device_id": "test-device"})
	if codec.write(ctx, ws, b) != nil {
		return
	}
	h.mu.Lock()
	h.streams[ws] = true
	h.connections++
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.streams, ws); h.mu.Unlock() }()
	for {
		b, e = codec.read(ctx, ws)
		if e != nil {
			return
		}
		if len(b) == 0 || b[0] != 0 {
			return
		}
		var m transport.Message
		if json.Unmarshal(b[1:], &m) != nil {
			return
		}
		switch m.Type {
		case "ping":
			if codec.json(ctx, ws, map[string]string{"type": "pong", "id": m.ID}) != nil {
				return
			}
		case "http":
			status, body := h.request(m)
			reply := map[string]any{"type": "http", "id": m.ID, "status": status, "body": body}
			if codec.json(ctx, ws, reply) != nil {
				return
			}
		case "open":
			if codec.json(ctx, ws, map[string]string{"type": "opened", "id": m.ID}) != nil {
				return
			}
			output := []byte("\x1b[38;2;1;2;3mhello  世界\x1b[0m\x07")
			if codec.write(ctx, ws, append(append([]byte{1, byte(len(m.ID))}, m.ID...), output...)) != nil {
				return
			}
		case "text":
			var v struct {
				Type string `json:"type"`
				Data string `json:"data"`
			}
			if json.Unmarshal([]byte(m.Data), &v) != nil {
				return
			}
			h.mu.Lock()
			if v.Type == "input" {
				h.inputs = append(h.inputs, v.Data)
				if v.Data == "\x04" && !h.delayExitRemoval {
					delete(h.terminals, "existing")
				}
			}
			if v.Type == "resize" {
				h.resizes++
			}
			if v.Type == "image_paste" {
				h.attachment, _ = base64.StdEncoding.DecodeString(v.Data)
			}
			h.mu.Unlock()
			if v.Type == "image_paste" {
				if codec.write(ctx, ws, append(append([]byte{1, byte(len(m.ID))}, m.ID...), []byte("[attachment pasted]")...)) != nil {
					return
				}
				continue
			}
			if v.Type == "input" && v.Data == "\x04" {
				if codec.json(ctx, ws, map[string]string{"type": "closed", "id": m.ID}) != nil {
					return
				}
				continue
			}
			if v.Type == "input" {
				if codec.write(ctx, ws, append(append([]byte{1, byte(len(m.ID))}, m.ID...), []byte(v.Data)...)) != nil {
					return
				}
			}
		case "close":
			h.mu.Lock()
			h.closes++
			h.mu.Unlock()
		}
	}
}
func digest(b []byte) string { v := sha256.Sum256(b); return hex.EncodeToString(v[:]) }
func (h *Hub) request(m transport.Message) (int, string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var result any
	switch {
	case m.Path == "/api/auth/me":
		result = map[string]string{"id": "owner"}
	case m.Path == "/api/machines":
		list := []map[string]string{{"id": "machine", "name": "test machine", "home_dir": "/home/test"}}
		if h.secondMachine {
			list = append(list, map[string]string{"id": "machine-b", "name": "second machine", "home_dir": "/home/second"})
		}
		result = list
	case m.Path == "/api/terminals":
		var ids []string
		for id := range h.terminals {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		var ts []map[string]any
		for _, id := range ids {
			ts = append(ts, map[string]any{"id": id, "machine_id": "machine", "title": "Test", "cols": 80, "rows": 24, "reachable": true})
		}
		result = ts
	case strings.HasPrefix(m.Path, "/api/mode?"):
		var owner *string
		if h.controller != "" {
			owner = &h.controller
		}
		result = map[string]any{"controller_device_id": owner}
	case m.Path == "/api/mode/control" || m.Path == "/api/mode/release":
		if m.Path == "/api/mode/control" {
			h.controller = "test-device"
		} else {
			h.controller = ""
		}
		result = map[string]string{"controller_device_id": h.controller}
	case (m.Path == "/api/machines/machine/terminals" || m.Path == "/api/machines/machine-b/terminals") && m.Method == "POST":
		var req struct {
			Startup string `json:"startup_command"`
		}
		if m.Body != nil {
			_ = json.Unmarshal([]byte(*m.Body), &req)
		}
		h.startup = req.Startup
		h.created++
		id := "new"
		if h.created > 1 {
			id = fmt.Sprintf("new-%d", h.created)
		}
		h.terminals[id] = true
		machine := "machine"
		if strings.Contains(m.Path, "/machine-b/") {
			machine = "machine-b"
		}
		result = map[string]string{"id": id, "machine_id": machine, "title": "Shell"}
	case strings.HasPrefix(m.Path, "/api/machines/machine/terminals/") && m.Method == "DELETE":
		id := strings.TrimPrefix(m.Path, "/api/machines/machine/terminals/")
		if idx := strings.Index(id, "?"); idx != -1 {
			id = id[:idx]
		}
		delete(h.terminals, id)
		return 204, ""
	case strings.Contains(m.Path, "/foreground-process"):
		result = map[string]any{"has_foreground_process": true, "process_name": "codex"}
	case strings.Contains(m.Path, "/fs/list"):
		result = []map[string]any{{"name": "folder", "is_dir": true}, {"name": "note.txt", "is_dir": false, "size": len(h.content)}}
	case strings.Contains(m.Path, "/fs/read"):
		result = map[string]any{"path": "/note.txt", "name": "note.txt", "size": len(h.content), "sha256": digest(h.content), "data_base64": base64.StdEncoding.EncodeToString(h.content)}
	case strings.Contains(m.Path, "/fs/write"):
		var v map[string]string
		if m.Body == nil || json.Unmarshal([]byte(*m.Body), &v) != nil {
			return 400, "{}"
		}
		if v["base_sha256"] != digest(h.content) {
			return 409, "{}"
		}
		b, e := base64.StdEncoding.DecodeString(v["data_base64"])
		if e != nil {
			return 400, "{}"
		}
		h.content = b
		result = map[string]any{"path": "/note.txt", "size": len(b), "sha256": digest(b)}
	default:
		return 404, "{}"
	}
	b, _ := json.Marshal(result)
	return 200, string(b)
}
