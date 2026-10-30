package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSignInAndIndependentToken(t *testing.T) {
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/api-tokens" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer fake-session" {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(`{"id":"fixture-id","token":"odk_fixture"}`))
	}))
	defer s.Close()
	hub, token, e := ParseSignIn(s.URL + "/?token=fake-session")
	if e != nil || hub != s.URL || token != "fake-session" {
		t.Fatal("parse", e)
	}
	id, secret, e := CreateToken(context.Background(), hub, token, s.Client())
	if e != nil || id != "fixture-id" || secret != "odk_fixture" {
		t.Fatal("create", e)
	}
	for _, bad := range []string{"http://example.test/?token=x", "https://example.test/?token=a&token=b", "https://example.test/?token=a&other=b", "https://user@example.test/?token=a"} {
		if _, _, e := ParseSignIn(bad); e == nil {
			t.Fatal("accepted invalid link")
		}
	}
}
