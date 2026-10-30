package files

import (
	"encoding/base64"
	"testing"
)

func TestPathsAndIntegrity(t *testing.T) {
	for _, p := range []string{"relative", "/a/../b", "/a\x00b"} {
		if ValidatePath(p) == nil {
			t.Fatal("bad path")
		}
	}
	r := Remote{Size: 1, Data: base64.StdEncoding.EncodeToString([]byte("a")), Hash: hash([]byte("a"))}
	if _, e := decode(r); e != nil {
		t.Fatal(e)
	}
	r.Hash = hash([]byte("b"))
	if _, e := decode(r); e == nil {
		t.Fatal("corruption accepted")
	}
	r.Hash = ""
	r.Size = 2
	if _, e := decode(r); e == nil {
		t.Fatal("size mismatch accepted")
	}
}
