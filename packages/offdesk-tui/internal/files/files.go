// Package files implements the bounded upstream fs/read and fs/write APIs.
package files

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"offdesk-tui/internal/api"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const Limit = 20 * 1024 * 1024

type Remote struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	Data string `json:"data_base64"`
	Hash string `json:"sha256"`
}

func ValidatePath(p string) error {
	if !path.IsAbs(p) || strings.ContainsRune(p, 0) {
		return errors.New("specify an absolute remote path")
	}
	for _, s := range strings.Split(p, "/") {
		if s == ".." {
			return errors.New("parent traversal is not allowed")
		}
	}
	return nil
}
func Read(ctx context.Context, a api.API, machine, p string) (r Remote, e error) {
	if e = ValidatePath(p); e != nil {
		return
	}
	e = a.Do(ctx, "GET", api.MachinePath(machine)+"/fs/read?path="+url.QueryEscape(p), nil, &r)
	return
}
func decode(r Remote) ([]byte, error) {
	if r.Size < 0 || r.Size > Limit || len(r.Data) > base64.StdEncoding.EncodedLen(Limit) {
		return nil, errors.New("remote file exceeds protocol limit")
	}
	b, e := base64.StdEncoding.DecodeString(r.Data)
	if e != nil {
		return nil, e
	}
	if int64(len(b)) != r.Size {
		return nil, errors.New("remote size mismatch")
	}
	if r.Hash != "" && !strings.EqualFold(hash(b), r.Hash) {
		return nil, errors.New("remote checksum mismatch")
	}
	return b, nil
}
func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// Download never uses a server-provided name for the local destination.
func Download(ctx context.Context, a api.API, machine, remote, local string, overwrite bool, progress func(int64)) error {
	r, e := Read(ctx, a, machine, remote)
	if e != nil {
		return e
	}
	b, e := decode(r)
	if e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	local, e = filepath.Abs(local)
	if e != nil {
		return e
	}
	info, e := os.Lstat(local)
	if e == nil {
		if !info.Mode().IsRegular() {
			return errors.New("destination must be a regular file")
		}
		if !overwrite {
			return errors.New("destination exists: confirm overwrite")
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(local), ".offdesk-download-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	for off := 0; off < len(b); {
		if e = ctx.Err(); e != nil {
			f.Close()
			return e
		}
		end := min(off+64*1024, len(b))
		if _, e = f.Write(b[off:end]); e != nil {
			f.Close()
			return e
		}
		off = end
		if progress != nil {
			progress(int64(off))
		}
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if overwrite {
		return os.Rename(f.Name(), local)
	}
	return renameNoReplace(f.Name(), local)
}

// Replace implements the supported text editor operation, not arbitrary upload.
func Replace(ctx context.Context, a api.API, machine, local, remote string, confirmed bool, progress func(int64)) error {
	if !confirmed {
		return errors.New("remote replacement requires confirmation")
	}
	if e := ValidatePath(remote); e != nil {
		return e
	}
	f, e := os.Open(local)
	if e != nil {
		return e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Size() > Limit {
		return errors.New("upload must be a regular file at most 20 MiB")
	}
	b, e := io.ReadAll(io.LimitReader(f, Limit+1))
	if e != nil {
		return e
	}
	if len(b) > Limit || !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
		return errors.New("upstream replacement supports UTF-8 text without NUL only")
	}
	r, e := Read(ctx, a, machine, remote)
	if e != nil {
		return e
	}
	if r.Hash == "" {
		return errors.New("node does not advertise conditional file writes")
	}
	if _, e = decode(r); e != nil {
		return e
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	var result struct {
		Hash string `json:"sha256"`
		Size int64  `json:"size"`
	}
	e = a.Do(ctx, "PUT", api.MachinePath(machine)+"/fs/write", map[string]string{"path": remote, "data_base64": base64.StdEncoding.EncodeToString(b), "base_sha256": r.Hash}, &result)
	if e != nil {
		return e
	}
	if result.Hash != hash(b) || result.Size != int64(len(b)) {
		return fmt.Errorf("replacement checksum or size mismatch")
	}
	if progress != nil {
		progress(int64(len(b)))
	}
	return nil
}
