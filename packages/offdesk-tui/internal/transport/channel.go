// Package transport implements Offdesk secure-v2 over a single WebSocket.
package transport

import (
	"encoding/binary"
	"errors"
	"github.com/flynn/noise"
	"sync"
)

const MaxMessage = 32 * 1024 * 1024
const fragmentBytes = 16 * 1024

var errRecord = errors.New("invalid secure record; reconnect required")

type assembly struct {
	total int
	data  []byte
}
type channel struct {
	mu         sync.Mutex
	send, recv *noise.CipherState
	next, last uint64
	pending    map[uint64]*assembly
	reserved   int
	failed     bool
}

func newChannel(send, recv *noise.CipherState) *channel {
	return &channel{send: send, recv: recv, next: 1, pending: make(map[uint64]*assembly)}
}
func (c *channel) encodeFragment(data []byte, off int, id *uint64) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.failed || len(data) == 0 || len(data) > MaxMessage || off < 0 || off >= len(data) {
		return nil, errRecord
	}
	if off == 0 {
		if c.next == 0 {
			return nil, errRecord
		}
		*id = c.next
		c.next++
	} else if *id == 0 {
		return nil, errRecord
	}
	end := min(off+fragmentBytes, len(data))
	p := make([]byte, 16, end-off+16)
	binary.BigEndian.PutUint64(p, *id)
	binary.BigEndian.PutUint32(p[8:], uint32(len(data)))
	binary.BigEndian.PutUint32(p[12:], uint32(off))
	p = append(p, data[off:end]...)
	r, e := c.send.Encrypt(nil, nil, p)
	if e != nil {
		c.failed = true
		return nil, e
	}
	return r, nil
}
func (c *channel) decode(record []byte) (out []byte, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer func() {
		if err != nil {
			c.failed = true
			c.pending = nil
			c.reserved = 0
		}
	}()
	if c.failed || len(record) < 33 || len(record) > fragmentBytes+32 {
		return nil, errRecord
	}
	p, e := c.recv.Decrypt(nil, nil, record)
	if e != nil {
		return nil, errRecord
	}
	id := binary.BigEndian.Uint64(p)
	total := int(binary.BigEndian.Uint32(p[8:]))
	off := int(binary.BigEndian.Uint32(p[12:]))
	data := p[16:]
	if total == 0 || total > MaxMessage || off+len(data) > total {
		return nil, errRecord
	}
	if off == 0 {
		if id <= c.last {
			return nil, errRecord
		}
		c.last = id
		if len(data) == total {
			return data, nil
		}
		if len(c.pending) >= 8 || c.reserved+total > 64*1024*1024 {
			return nil, errRecord
		}
		c.pending[id] = &assembly{total, append([]byte(nil), data...)}
		c.reserved += total
		return nil, nil
	}
	a := c.pending[id]
	if a == nil || a.total != total || len(a.data) != off {
		return nil, errRecord
	}
	a.data = append(a.data, data...)
	if len(a.data) == total {
		delete(c.pending, id)
		c.reserved -= total
		return a.data, nil
	}
	return nil, nil
}
