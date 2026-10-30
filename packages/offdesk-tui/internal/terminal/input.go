// Package terminal forwards terminal bytes without interpreting remote shortcuts.
package terminal

import "unicode/utf8"

// Decoder reserves only Prefix followed by one local command byte. A doubled
// prefix sends one literal prefix. State survives arbitrary read boundaries.
type Decoder struct {
	Prefix  byte
	Pending bool
	tail    []byte
}
type Action struct {
	Data    []byte
	Command byte
}

func (d *Decoder) Feed(b []byte) (out []Action) {
	data := d.tail
	d.tail = nil
	flush := func() {
		if len(data) > 0 {
			out = append(out, Action{Data: data})
			data = nil
		}
	}
	for _, v := range b {
		if d.Pending {
			d.Pending = false
			if v == d.Prefix {
				data = append(data, v)
			} else {
				flush()
				out = append(out, Action{Command: v})
			}
		} else if v == d.Prefix {
			d.Pending = true
		} else {
			data = append(data, v)
		}
	}
	// JSON input carries UTF-8 strings; never turn a split Unicode key into
	// replacement characters at an arbitrary stdin read boundary.
	for i := 0; i < len(data); {
		if !utf8.FullRune(data[i:]) {
			d.tail = append([]byte(nil), data[i:]...)
			data = data[:i]
			break
		}
		_, n := utf8.DecodeRune(data[i:])
		i += n
	}
	flush()
	return
}
