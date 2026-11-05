// Package auth validates official encrypted pairing descriptors.
package auth

import (
	"encoding/base64"
	"errors"
	"net/url"
	"offdesk-tui/internal/transport"
)

func Parse(raw string) (transport.Credentials, string, error) {
	var c transport.Credentials
	bad := errors.New("invalid offdesk encrypted pairing link (requires v=2)")
	if len(raw) > 2048 {
		return c, "", bad
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "offdesk" || u.Host != "pair" || u.User != nil || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return c, "", bad
	}
	q, e := url.ParseQuery(u.RawQuery)
	if e != nil || len(q) != 4 {
		return c, "", bad
	}
	for _, v := range q {
		if len(v) != 1 {
			return c, "", bad
		}
	}
	if q.Get("v") != "2" {
		return c, "", bad
	}
	c.Hub = q.Get("hub")
	if transport.ValidateOrigin(c.Hub) != nil {
		return c, "", bad
	}
	c.PublicKey, e = base64.RawURLEncoding.DecodeString(q.Get("key"))
	if e != nil || len(c.PublicKey) != 32 {
		return c, "", bad
	}
	code := q.Get("code")
	decoded, e := base64.RawURLEncoding.DecodeString(code)
	if e != nil || len(decoded) != 32 {
		return c, "", bad
	}
	return c, code, nil
}
