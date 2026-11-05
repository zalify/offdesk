package transport

import (
	"github.com/flynn/noise"
	"golang.org/x/crypto/curve25519"
)

func keyFromPrivate(private []byte) (noise.DHKey, error) {
	pub, e := curve25519.X25519(private, curve25519.Basepoint)
	return noise.DHKey{Private: private, Public: pub}, e
}
