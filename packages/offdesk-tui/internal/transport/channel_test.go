package transport

import (
	"bytes"
	"crypto/rand"
	"github.com/flynn/noise"
	"testing"
)

func channels(t *testing.T) (*channel, *channel) {
	t.Helper()
	suite := noise.NewCipherSuite(noise.DH25519, noise.CipherChaChaPoly, noise.HashSHA256)
	a, e := noise.DH25519.GenerateKeypair(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	b, e := noise.DH25519.GenerateKeypair(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	client, e := noise.NewHandshakeState(noise.Config{CipherSuite: suite, Pattern: noise.HandshakeIK, Initiator: true, Prologue: []byte("offdesk-secure-v2"), StaticKeypair: a, PeerStatic: b.Public})
	if e != nil {
		t.Fatal(e)
	}
	server, e := noise.NewHandshakeState(noise.Config{CipherSuite: suite, Pattern: noise.HandshakeIK, Prologue: []byte("offdesk-secure-v2"), StaticKeypair: b})
	if e != nil {
		t.Fatal(e)
	}
	hello, _, _, e := client.WriteMessage(nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, _, _, e = server.ReadMessage(nil, hello); e != nil {
		t.Fatal(e)
	}
	hello, recv, send, e := server.WriteMessage(nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	_, out, in, e := client.ReadMessage(nil, hello)
	if e != nil {
		t.Fatal(e)
	}
	return newChannel(out, in), newChannel(send, recv)
}
func TestInterleavedFragments(t *testing.T) {
	a, b := channels(t)
	bulk := bytes.Repeat([]byte("z"), fragmentBytes*2+1)
	var bulkID, smallID uint64
	r, e := a.encodeFragment(bulk, 0, &bulkID)
	if e != nil {
		t.Fatal(e)
	}
	if got, e := b.decode(r); e != nil || got != nil {
		t.Fatal("initial fragment", e)
	}
	r, e = a.encodeFragment([]byte("heartbeat"), 0, &smallID)
	if e != nil {
		t.Fatal(e)
	}
	if got, e := b.decode(r); e != nil || string(got) != "heartbeat" {
		t.Fatal("interleaved heartbeat", e)
	}
	for off := fragmentBytes; off < len(bulk); off += fragmentBytes {
		r, e = a.encodeFragment(bulk, off, &bulkID)
		if e != nil {
			t.Fatal(e)
		}
		got, e := b.decode(r)
		if e != nil {
			t.Fatal(e)
		}
		if off+fragmentBytes >= len(bulk) && !bytes.Equal(got, bulk) {
			t.Fatal("incomplete bulk")
		}
	}
}
func TestTamperingClosesChannel(t *testing.T) {
	a, b := channels(t)
	var id uint64
	r, e := a.encodeFragment([]byte("test"), 0, &id)
	if e != nil {
		t.Fatal(e)
	}
	r[len(r)-1] ^= 1
	if _, e = b.decode(r); e == nil {
		t.Fatal("tampering accepted")
	}
	if _, e = b.decode(r); e == nil {
		t.Fatal("failed channel reused")
	}
}
