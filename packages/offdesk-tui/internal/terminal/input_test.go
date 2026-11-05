package terminal

import (
	"bytes"
	"testing"
)

func TestInputEveryBoundary(t *testing.T) {
	want := []byte("a\x1bm\x03\x02\x1b[A\x1b[15~\t世界")
	for split := 0; split <= len(want); split++ {
		d := Decoder{Prefix: 0x1d}
		var got []byte
		for _, b := range [][]byte{want[:split], want[split:]} {
			for _, a := range d.Feed(b) {
				if a.Command != 0 {
					t.Fatalf("consumed key %d", a.Command)
				}
				got = append(got, a.Data...)
			}
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("split %d: %q", split, got)
		}
	}
}
func TestPrefixAcrossReads(t *testing.T) {
	d := Decoder{Prefix: 0x1d}
	if len(d.Feed([]byte{0x1d})) != 0 {
		t.Fatal("premature prefix")
	}
	a := d.Feed([]byte{'n', 'a', 0x1d, 0x1d})
	if len(a) != 2 || a[0].Command != 'n' || !bytes.Equal(a[1].Data, []byte{'a', 0x1d}) {
		t.Fatalf("%v", a)
	}
}
