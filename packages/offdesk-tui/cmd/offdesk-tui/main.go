package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/term"
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/auth"
	"offdesk-tui/internal/config"
	"offdesk-tui/internal/files"
	"offdesk-tui/internal/transport"
	"offdesk-tui/internal/tui"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
)

const upstream = "2c2c7e374f870bd7b622e960f60b4ae3f44924aa"

var version = "0.1.0-dev"

func hidden() (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("pairing requires an interactive terminal")
	}
	fmt.Fprint(os.Stderr, "Paste an official encrypted pairing or Hub sign-in link (hidden): ")
	b, e := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Fprintln(os.Stderr)
	if e != nil {
		return "", errors.New("could not read pairing link")
	}
	return strings.TrimSpace(string(b)), nil
}
func signIn(ctx context.Context, raw string) error {
	if _, e := config.Load(); e == nil {
		return errors.New("configuration already exists; preserve it before signing in again")
	} else if !os.IsNotExist(e) {
		return e
	}
	hub, session, e := auth.ParseSignIn(raw)
	if e != nil {
		return e
	}
	b := make([]byte, 16)
	if _, e = rand.Read(b); e != nil {
		return e
	}
	device := "tui-" + base64.RawURLEncoding.EncodeToString(b)
	id, token, e := auth.CreateToken(ctx, hub, session, nil)
	if e != nil {
		return e
	}
	cred := transport.Credentials{Hub: hub, Token: token, TokenID: id, DeviceID: device}
	if e = config.Save(config.Config{Credentials: cred, Prefix: 0x1d}); e != nil {
		return errors.New("token was created but could not be saved; revoke offdesk-tui in Hub API token settings")
	}
	c, _, e := transport.Connect(ctx, cred, "")
	if e != nil {
		return errors.New("token saved, but validation failed; check connectivity or Hub token settings")
	}
	defer c.Close()
	fmt.Println("Signed in with an independently revocable API token over HTTPS/WSS. Encrypted device pairing remains available separately.")
	return nil
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if e := run(ctx, os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, "offdesk-tui:", e)
		os.Exit(1)
	}
}
func run(ctx context.Context, args []string) error {
	cmd := ""
	if len(args) > 0 {
		cmd = args[0]
		args = args[1:]
	}
	if cmd == "help" || cmd == "--help" || cmd == "-h" {
		fmt.Println(`offdesk-tui — control Offdesk from your terminal

Authentication:
  offdesk-tui pair             Paste an encrypted offdesk://pair link or an
                               HTTPS Hub sign-in link into a hidden prompt.
  offdesk-tui login-file PATH  Read an HTTPS sign-in link from a private file.

The HTTPS sign-in creates a separate API token; encrypted pairing creates a
separate paired device. Credentials are saved in your user config directory
under offdesk-tui/config.json. Keep links and credentials private.

Commands:
  machines | terminals   list remote resources
  ls MACHINE /path       browse remote files
  download MACHINE /remote /local [--overwrite]
  upload MACHINE /local /remote --replace
  prefix HEX             configure local prefix (default 1d = Ctrl+])
  version
  (no command)           interactive persistent terminal tabs

Inside terminal: Ctrl+] then ? for local shortcuts.`)
		return nil
	}
	if cmd == "version" {
		fmt.Println("offdesk-tui "+version+"; upstream", upstream)
		return nil
	}
	if cmd == "login-file" {
		if len(args) != 1 {
			return errors.New("usage: login-file PATH")
		}
		b, e := os.ReadFile(args[0])
		if e != nil {
			return errors.New("could not read sign-in link file")
		}
		return signIn(ctx, strings.TrimSpace(string(b)))
	}
	if cmd == "pair" {
		previous, loadErr := config.Load()
		if loadErr == nil && previous.Credentials.DeviceID != "" {
			return errors.New("a paired configuration already exists; preserve it or move it aside before pairing another identity")
		}
		if loadErr != nil && !os.IsNotExist(loadErr) {
			return loadErr
		}
		// Persist the candidate key before consuming a single-use code. If the
		// response is lost, the same identity can resume on the next attempt.
		if loadErr == nil {
			c, id, e := transport.Connect(ctx, previous.Credentials, "")
			if e == nil {
				defer c.Close()
				previous.Credentials.DeviceID = id
				if e = config.Save(previous); e != nil {
					return e
				}
				fmt.Println("Recovered the existing independently paired device.")
				return nil
			}
		}
		raw, e := hidden()
		if e != nil {
			return e
		}
		if strings.HasPrefix(raw, "https://") {
			if loadErr == nil {
				return errors.New("pending encrypted pairing exists; preserve it before using a sign-in link")
			}
			return signIn(ctx, raw)
		}
		cred, code, e := auth.Parse(raw)
		if e != nil {
			return e
		}
		if loadErr == nil {
			if previous.Credentials.Hub != cred.Hub || !bytes.Equal(previous.Credentials.PublicKey, cred.PublicKey) {
				return errors.New("pending identity belongs to a different Hub; preserve or move the old configuration aside first")
			}
			cred.PrivateKey = previous.Credentials.PrivateKey
		} else {
			cred.PrivateKey = make([]byte, 32)
			if _, e = rand.Read(cred.PrivateKey); e != nil {
				return e
			}
			if e = config.Save(config.Config{Credentials: cred, Prefix: 0x1d}); e != nil {
				return e
			}
		}
		c, id, e := transport.Connect(ctx, cred, code)
		if e != nil {
			return e
		}
		defer c.Close()
		cred.DeviceID = id
		if e = config.Save(config.Config{Credentials: cred, Prefix: 0x1d}); e != nil {
			return e
		}
		a := api.API{C: c, Device: id}
		if e = a.Me(ctx); e != nil {
			return e
		}
		fmt.Println("Paired independently. Credentials saved privately; the Android app is unchanged.")
		return nil
	}
	cfg, e := config.Load()
	if os.IsNotExist(e) {
		return errors.New("run offdesk-tui pair with an official pairing or sign-in link")
	}
	if e != nil {
		return e
	}
	if cmd == "prefix" {
		if len(args) != 1 {
			return errors.New("usage: prefix HEX")
		}
		v, e := strconv.ParseUint(args[0], 16, 8)
		if e != nil || v == 0 || v > 31 || v == 3 || v == 27 || v == 2 {
			return errors.New("choose a control-byte prefix other than Ctrl+C, Escape or Ctrl+B")
		}
		cfg.Prefix = byte(v)
		return config.Save(cfg)
	}
	if cmd == "" {
		u := tui.UI{Config: &cfg}
		return u.Run(ctx)
	}
	c, id, e := transport.Connect(ctx, cfg.Credentials, "")
	if e != nil {
		return e
	}
	defer c.Close()
	a := api.API{C: c, Device: id}
	progress := func(n int64) { fmt.Fprintf(os.Stderr, "\rVerified transfer: %d bytes\n", n) }
	switch cmd {
	case "machines":
		v, e := a.Machines(ctx)
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(v)
	case "terminals":
		v, e := a.Terminals(ctx)
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(v)
	case "ls":
		if len(args) != 2 {
			return errors.New("usage: ls MACHINE /path")
		}
		v, e := a.ListFiles(ctx, args[0], args[1])
		if e != nil {
			return e
		}
		return json.NewEncoder(os.Stdout).Encode(v)
	case "download":
		if len(args) < 3 || len(args) > 4 || (len(args) == 4 && args[3] != "--overwrite") {
			return errors.New("usage: download MACHINE /remote /local [--overwrite]")
		}
		return files.Download(ctx, a, args[0], args[1], args[2], len(args) == 4, progress)
	case "upload":
		if len(args) != 4 || args[3] != "--replace" {
			return errors.New("usage: upload MACHINE /local /remote --replace (existing text files only)")
		}
		return files.Replace(ctx, a, args[0], args[1], args[2], true, progress)
	default:
		return errors.New("unknown command; see offdesk-tui help")
	}
}
