package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"offdesk-tui/internal/transport"
	"strings"
	"time"
)

// ParseSignIn reads an official HTTPS sign-in link without exposing its token.
func ParseSignIn(raw string) (string, string, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	bad := errors.New("expected an HTTPS Offdesk sign-in link with exactly one token")
	if e != nil || u == nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", "", bad
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(q) != 1 || len(q["token"]) != 1 || q.Get("token") == "" {
		return "", "", bad
	}
	origin := "https://" + u.Host
	if transport.ValidateOrigin(origin) != nil {
		return "", "", bad
	}
	return origin, q.Get("token"), nil
}

// CreateToken uses the Hub's documented API to create an independently revocable token.
func CreateToken(ctx context.Context, hub, session string, hc *http.Client) (string, string, error) {
	if transport.ValidateOrigin(hub) != nil {
		return "", "", errors.New("invalid Hub")
	}
	if hc == nil {
		hc = &http.Client{Transport: &http.Transport{Proxy: nil, ForceAttemptHTTP2: false, TLSHandshakeTimeout: 10 * time.Second}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, "POST", strings.TrimRight(hub, "/")+"/api/auth/api-tokens", bytes.NewBufferString(`{"name":"offdesk-tui (Termux)"}`))
	if e != nil {
		return "", "", errors.New("invalid request")
	}
	req.Header.Set("Authorization", "Bearer "+session)
	req.Header.Set("Content-Type", "application/json")
	res, e := hc.Do(req)
	if e != nil {
		return "", "", errors.New("token creation interrupted; check Hub API tokens before retrying")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", "", fmt.Errorf("Hub rejected token creation (HTTP %d)", res.StatusCode)
	}
	var result struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&result) != nil || result.ID == "" || !strings.HasPrefix(result.Token, "odk_") {
		return "", "", errors.New("invalid token response; check Hub API tokens before retrying")
	}
	return result.ID, result.Token, nil
}
