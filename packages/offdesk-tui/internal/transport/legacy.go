package transport

// The official legacy application transport uses HTTPS and direct WSS, with a
// full-access bearer credential. It is distinct from the Noise device protocol.
import (
	"context"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type legacyClient struct {
	hub, token string
	http       *http.Client
	mu         sync.Mutex
	sockets    map[string]*legacySocket
}
type legacySocket struct {
	ws     *websocket.Conn
	mu     sync.Mutex
	events chan Message
	ctx    context.Context
	cancel context.CancelFunc
}

func directHTTP() *http.Client {
	return &http.Client{Transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: false, TLSHandshakeTimeout: 10 * time.Second}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}
func connectLegacy(ctx context.Context, cred Credentials, hc *http.Client) (*Client, string, error) {
	if cred.Token == "" || cred.DeviceID == "" {
		return nil, "", errors.New("invalid sign-in credentials")
	}
	if hc == nil {
		hc = directHTTP()
	}
	base, cancel := context.WithCancel(ctx)
	c := &Client{ctx: base, cancel: cancel, done: make(chan struct{}), legacy: &legacyClient{hub: strings.TrimRight(cred.Hub, "/"), token: cred.Token, http: hc, sockets: map[string]*legacySocket{}}}
	testCtx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	if _, e := c.legacyRequest(testCtx, "GET", "/api/auth/me", nil); e != nil {
		c.Close()
		return nil, "", errors.New("Hub sign-in failed")
	}
	return c, cred.DeviceID, nil
}
func (l *legacyClient) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, s := range l.sockets {
		s.cancel()
		s.ws.CloseNow()
		delete(l.sockets, id)
	}
	l.http.CloseIdleConnections()
}
func (c *Client) legacyRequest(ctx context.Context, method, path string, body *string) (Message, error) {
	var m Message
	if !strings.HasPrefix(path, "/api/") || strings.ContainsAny(path, "\\#") || strings.HasPrefix(path, "//") {
		return m, errors.New("invalid API path")
	}
	var reader io.Reader
	if body != nil {
		reader = strings.NewReader(*body)
	}
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, method, c.legacy.hub+path, reader)
	if e != nil {
		return m, errors.New("invalid Hub request")
	}
	req.Header.Set("Authorization", "Bearer "+c.legacy.token)
	req.Header.Set("Content-Type", "application/json")
	res, e := c.legacy.http.Do(req)
	if e != nil {
		return m, errors.New("Hub request interrupted; mutation outcome may be unknown")
	}
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, MaxMessage+1))
	if e != nil || len(b) > MaxMessage {
		return m, errors.New("Hub response interrupted or too large")
	}
	s := string(b)
	m = Message{Type: "http", Status: res.StatusCode, Body: &s}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return m, fmt.Errorf("Hub HTTP %d", res.StatusCode)
	}
	return m, nil
}
func (c *Client) legacyOpen(ctx context.Context, path string) (string, <-chan Message, error) {
	if !strings.HasPrefix(path, "/ws/terminal/") || strings.ContainsAny(path, "\\#") {
		return "", nil, errors.New("invalid terminal path")
	}
	u, e := url.Parse(c.legacy.hub + path)
	if e != nil {
		return "", nil, errors.New("invalid terminal address")
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	q := u.Query()
	q.Set("token", c.legacy.token)
	u.RawQuery = q.Encode()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ws, _, e := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPClient: c.legacy.http})
	if e != nil {
		return "", nil, errors.New("could not open terminal WebSocket")
	}
	ws.SetReadLimit(MaxMessage)
	id := c.nextID()
	socketCtx, socketCancel := context.WithCancel(c.ctx)
	s := &legacySocket{ws: ws, events: make(chan Message, 32), ctx: socketCtx, cancel: socketCancel}
	c.legacy.mu.Lock()
	c.legacy.sockets[id] = s
	c.legacy.mu.Unlock()
	go c.legacyRead(id, s)
	go c.legacyHeartbeat(s)
	return id, s.events, nil
}
func (c *Client) legacyRead(id string, s *legacySocket) {
	defer func() {
		select {
		case s.events <- Message{Type: "closed", ID: id}:
		case <-s.ctx.Done():
		}
	}()
	for {
		typ, b, e := s.ws.Read(s.ctx)
		if e != nil {
			return
		}
		m := Message{ID: id}
		switch typ {
		case websocket.MessageBinary:
			m.Type = "binary"
			m.Binary = b
		case websocket.MessageText:
			m.Type = "text"
			m.Data = string(b)
		default:
			continue
		}
		select {
		case s.events <- m:
		case <-s.ctx.Done():
			return
		}
	}
}
func (c *Client) legacyHeartbeat(s *legacySocket) {
	t := time.NewTicker(20 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
			ctx, cancel := context.WithTimeout(s.ctx, 15*time.Second)
			e := s.ws.Ping(ctx)
			cancel()
			if e != nil {
				s.ws.CloseNow()
				return
			}
		}
	}
}
func (c *Client) legacyCloseSocket(id string) error {
	c.legacy.mu.Lock()
	s := c.legacy.sockets[id]
	delete(c.legacy.sockets, id)
	c.legacy.mu.Unlock()
	if s != nil {
		s.cancel()
		s.ws.CloseNow()
	}
	return nil
}
func (c *Client) legacyText(ctx context.Context, id string, b []byte) error {
	c.legacy.mu.Lock()
	s := c.legacy.sockets[id]
	c.legacy.mu.Unlock()
	if s == nil {
		return errors.New("terminal is detached")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if e := s.ws.Write(ctx, websocket.MessageText, b); e != nil {
		return errors.New("terminal connection interrupted")
	}
	return nil
}
