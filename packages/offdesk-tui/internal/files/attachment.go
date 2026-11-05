package files

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"offdesk-tui/internal/transport"
)

// AttachmentLimit is the limit used by the official app's image_paste path.
const AttachmentLimit = 23 * 1024 * 1024

// SendAttachment sends the official terminal attachment message. The protocol
// has no delivery receipt: a successful write means submitted, not verified.
func SendAttachment(ctx context.Context, c *transport.Client, socket, local string, progress func(int64)) error {
	f, e := os.Open(local)
	if e != nil {
		return e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return e
	}
	if !st.Mode().IsRegular() || st.Size() > AttachmentLimit {
		return errors.New("attachment must be a regular file no larger than 23 MiB")
	}
	b, e := io.ReadAll(io.LimitReader(f, AttachmentLimit+1))
	if e != nil {
		return e
	}
	if len(b) > AttachmentLimit {
		return errors.New("attachment exceeds 23 MiB")
	}
	if e = ctx.Err(); e != nil {
		return e
	}
	name := filepath.Base(local)
	if name == "." || name == string(filepath.Separator) || strings.ContainsRune(name, 0) {
		return errors.New("invalid attachment name")
	}
	media := mime.TypeByExtension(filepath.Ext(name))
	if media == "" {
		media = "application/octet-stream"
	}
	e = c.Text(ctx, socket, map[string]string{"type": "image_paste", "data": base64.StdEncoding.EncodeToString(b), "mime": media, "filename": name})
	if e != nil {
		return e
	}
	if progress != nil {
		progress(int64(len(b)))
	}
	return nil
}
