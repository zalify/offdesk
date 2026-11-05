package auth

import (
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
)

func TestPairingDescriptor(t *testing.T) {
	key := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	link := "offdesk://pair?v=2&hub=" + url.QueryEscape("https://hub.example.com") + "&key=" + key + "&code=" + key
	if _, _, e := Parse(link); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{link + "&code=" + key, link + "#fragment", strings.Replace(link, "v=2", "v=1", 1), strings.Replace(link, "https%3A%2F%2F", "http%3A%2F%2F", 1), "https://hub.example.com/?token=secret", link + "&extra=x"} {
		if _, _, e := Parse(s); e == nil {
			t.Fatal("invalid descriptor accepted")
		}
	}
}
