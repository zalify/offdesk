package transport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/flynn/noise"
)

type Credentials struct {
	Hub        string `json:"hub"`
	PublicKey  []byte `json:"public_key,omitempty"`
	PrivateKey []byte `json:"private_key,omitempty"`
	DeviceID   string `json:"device_id"`
	Token      string `json:"token,omitempty"`
	TokenID    string `json:"token_id,omitempty"`
}
type Message struct {
	Type   string  `json:"type"`
	ID     string  `json:"id,omitempty"`
	Method string  `json:"method,omitempty"`
	Path   string  `json:"path,omitempty"`
	Body   *string `json:"body,omitempty"`
	Data   string  `json:"data,omitempty"`
	Status int     `json:"status,omitempty"`
	Text   string  `json:"message,omitempty"`
	Binary []byte  `json:"-"`
}
type Client struct {
	legacy   *legacyClient
	ws       *websocket.Conn
	ch       *channel
	cancel   context.CancelFunc
	ctx      context.Context
	write    sync.Mutex
	mu       sync.Mutex
	pending  map[string]chan Message
	sockets  map[string]chan Message
	done     chan struct{}
	once     sync.Once
	serial   atomic.Uint64
	received atomic.Int64
}

func ValidateOrigin(raw string) error {
	u, e := url.Parse(raw)
	if e != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return errors.New("Hub must be an HTTPS origin without path or credentials")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || (ip != nil && ip.IsLoopback()))) {
		return errors.New("HTTPS required except for loopback test Hubs")
	}
	return nil
}
func Connect(ctx context.Context, cred Credentials, code string) (*Client, string, error) {
	if e := ValidateOrigin(cred.Hub); e != nil {
		return nil, "", e
	}
	if cred.Token != "" {
		return connectLegacy(ctx, cred, nil)
	}
	if len(cred.PublicKey) != 32 || len(cred.PrivateKey) != 32 {
		return nil, "", errors.New("invalid device key")
	}
	u, _ := url.Parse(cred.Hub)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path = "/ws/secure"
	// Do not inherit HTTP_PROXY: traffic goes directly to the selected Hub.
	hc := &http.Client{Transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: false, TLSHandshakeTimeout: 10 * time.Second}}
	connCtx, cancel := context.WithCancel(ctx)
	dialCtx, stop := context.WithTimeout(connCtx, 15*time.Second)
	defer stop()
	ws, _, e := websocket.Dial(dialCtx, u.String(), &websocket.DialOptions{HTTPClient: hc})
	if e != nil {
		cancel()
		return nil, "", errors.New("could not open Hub secure WebSocket")
	}
	ws.SetReadLimit(65535)
	fail := func() (*Client, string, error) {
		cancel()
		ws.CloseNow()
		return nil, "", errors.New("Hub identity or encrypted authentication failed")
	}
	pub := noise.DH25519
	// DH public key derivation is Curve25519 with the supplied private scalar.
	pair, e := keyFromPrivate(cred.PrivateKey)
	if e != nil {
		return fail()
	}
	hs, e := noise.NewHandshakeState(noise.Config{CipherSuite: noise.NewCipherSuite(pub, noise.CipherChaChaPoly, noise.HashSHA256), Pattern: noise.HandshakeIK, Initiator: true, Prologue: []byte("offdesk-secure-v2"), StaticKeypair: pair, PeerStatic: cred.PublicKey})
	if e != nil {
		return fail()
	}
	hello, _, _, e := hs.WriteMessage(nil, nil)
	if e != nil {
		return fail()
	}
	if e = ws.Write(dialCtx, websocket.MessageBinary, hello); e != nil {
		return fail()
	}
	typ, hello, e := ws.Read(dialCtx)
	if e != nil || typ != websocket.MessageBinary {
		return fail()
	}
	payload, send, recv, e := hs.ReadMessage(nil, hello)
	if e != nil || len(payload) != 0 {
		return fail()
	}
	c := &Client{ws: ws, ch: newChannel(send, recv), cancel: cancel, ctx: connCtx, pending: map[string]chan Message{}, sockets: map[string]chan Message{}, done: make(chan struct{})}
	auth := map[string]string{"type": "resume"}
	if code != "" {
		auth = map[string]string{"type": "pair", "code": code, "device_name": "offdesk-tui (Termux)"}
	}
	b, _ := json.Marshal(auth)
	if e = c.sendRaw(dialCtx, b); e != nil {
		return fail()
	}
	typ, r, e := ws.Read(dialCtx)
	if e != nil || typ != websocket.MessageBinary {
		return fail()
	}
	b, e = c.ch.decode(r)
	if e != nil {
		return fail()
	}
	var result struct {
		Type   string `json:"type"`
		Device string `json:"device_id"`
	}
	if json.Unmarshal(b, &result) != nil || result.Type != "ready" || result.Device == "" {
		return fail()
	}
	if cred.DeviceID != "" && cred.DeviceID != result.Device {
		return fail()
	}
	c.received.Store(time.Now().Unix())
	go c.readLoop()
	go c.heartbeat()
	return c, result.Device, nil
}
func (c *Client) Close() {
	c.once.Do(func() {
		c.cancel()
		if c.ws != nil {
			c.ws.CloseNow()
		}
		if c.legacy != nil {
			c.legacy.close()
		}
		close(c.done)
	})
}
func (c *Client) Done() <-chan struct{} { return c.done }
func (c *Client) sendRaw(ctx context.Context, b []byte) error {
	if len(b) == 0 || len(b) > MaxMessage {
		return errRecord
	}
	var id uint64
	for off := 0; off < len(b); off += fragmentBytes {
		c.write.Lock()
		r, e := c.ch.encodeFragment(b, off, &id)
		if e == nil {
			e = c.ws.Write(ctx, websocket.MessageBinary, r)
		}
		c.write.Unlock()
		if e != nil {
			c.Close()
			return errors.New("encrypted connection interrupted")
		}
	}
	return nil
}
func (c *Client) Send(ctx context.Context, m Message) error {
	b, e := json.Marshal(m)
	if e != nil {
		return e
	}
	return c.sendRaw(ctx, append([]byte{0}, b...))
}
func (c *Client) readLoop() {
	defer c.Close()
	for {
		typ, r, e := c.ws.Read(c.ctx)
		if e != nil || typ != websocket.MessageBinary {
			return
		}
		b, e := c.ch.decode(r)
		if e != nil {
			return
		}
		if b == nil {
			continue
		}
		c.received.Store(time.Now().Unix())
		m, e := decodeMessage(b)
		if e != nil {
			return
		}
		if m.Type == "pong" {
			continue
		}
		c.mu.Lock()
		p := c.pending[m.ID]
		s := c.sockets[m.ID]
		c.mu.Unlock()
		if p != nil {
			select {
			case p <- m:
			case <-c.ctx.Done():
				return
			}
		} else if s != nil {
			select {
			case s <- m:
			case <-c.ctx.Done():
				return
			}
		}
	}
}
func decodeMessage(b []byte) (Message, error) {
	var m Message
	if len(b) == 0 {
		return m, errRecord
	}
	if b[0] == 0 {
		return m, json.Unmarshal(b[1:], &m)
	}
	if b[0] != 1 || len(b) < 2 || b[1] == 0 || b[1] > 64 || len(b) < 2+int(b[1]) {
		return m, errRecord
	}
	n := int(b[1])
	m.Type = "binary"
	m.ID = string(b[2 : 2+n])
	m.Binary = b[2+n:]
	return m, nil
}
func (c *Client) heartbeat() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-t.C:
			if time.Now().Unix()-c.received.Load() > 60 {
				c.Close()
				return
			}
			ctx, cancel := context.WithTimeout(c.ctx, 10*time.Second)
			e := c.Send(ctx, Message{Type: "ping", ID: "heartbeat"})
			cancel()
			if e != nil {
				c.Close()
				return
			}
		}
	}
}
func (c *Client) nextID() string { return fmt.Sprintf("tui-%d", c.serial.Add(1)) }
func (c *Client) Request(ctx context.Context, method, path string, body *string) (Message, error) {
	if c.legacy != nil {
		return c.legacyRequest(ctx, method, path, body)
	}
	id := c.nextID()
	p := make(chan Message, 1)
	c.mu.Lock()
	c.pending[id] = p
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, id); c.mu.Unlock() }()
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	if e := c.Send(ctx, Message{Type: "http", ID: id, Method: method, Path: path, Body: body}); e != nil {
		return Message{}, e
	}
	select {
	case m := <-p:
		if m.Type != "http" {
			return m, errors.New("Hub rejected encrypted request")
		}
		if m.Status < 200 || m.Status >= 300 {
			return m, fmt.Errorf("Hub HTTP %d", m.Status)
		}
		return m, nil
	case <-ctx.Done():
		c.Close()
		return Message{}, errors.New("request interrupted; mutation outcome may be unknown")
	case <-c.done:
		return Message{}, errors.New("Hub disconnected; mutation outcome may be unknown")
	}
}
func (c *Client) Open(ctx context.Context, path string) (string, <-chan Message, error) {
	if c.legacy != nil {
		return c.legacyOpen(ctx, path)
	}
	id := c.nextID()
	s := make(chan Message, 32)
	c.mu.Lock()
	c.sockets[id] = s
	c.mu.Unlock()
	if e := c.Send(ctx, Message{Type: "open", ID: id, Path: path}); e != nil {
		c.removeSocket(id)
		return "", nil, e
	}
	select {
	case m := <-s:
		if m.Type == "opened" {
			return id, s, nil
		}
		c.removeSocket(id)
		return "", nil, errors.New("Hub rejected terminal attach")
	case <-ctx.Done():
		c.removeSocket(id)
		return "", nil, ctx.Err()
	case <-c.done:
		c.removeSocket(id)
		return "", nil, errors.New("Hub disconnected")
	}
}
func (c *Client) removeSocket(id string) { c.mu.Lock(); delete(c.sockets, id); c.mu.Unlock() }
func (c *Client) CloseSocket(ctx context.Context, id string) error {
	if c.legacy != nil {
		return c.legacyCloseSocket(id)
	}
	c.removeSocket(id)
	return c.Send(ctx, Message{Type: "close", ID: id})
}
func (c *Client) Text(ctx context.Context, id string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if c.legacy != nil {
		return c.legacyText(ctx, id, b)
	}
	return c.Send(ctx, Message{Type: "text", ID: id, Data: string(b)})
}
func TerminalPath(machine, terminal, device string) string {
	return "/ws/terminal/" + url.PathEscape(machine) + "/" + url.PathEscape(terminal) + "?device_id=" + url.QueryEscape(device)
}
