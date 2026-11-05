package files

import (
	"encoding/base64"
	"os"
	"path/filepath"
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

func TestRenameNoReplacePreservesExistingFile(t *testing.T) {
	dir := t.TempDir()
	src, dst := filepath.Join(dir, "source"), filepath.Join(dir, "destination")
	if err := os.WriteFile(src, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(src, dst); err == nil {
		t.Fatal("existing destination overwritten")
	}
	b, err := os.ReadFile(dst)
	if err != nil || string(b) != "existing" {
		t.Fatal("existing file changed")
	}
	if err := os.Remove(dst); err != nil {
		t.Fatal(err)
	}
	if err := renameNoReplace(src, dst); err != nil {
		t.Fatal(err)
	}
	b, err = os.ReadFile(dst)
	if err != nil || string(b) != "new" {
		t.Fatal("new file not installed")
	}
}
