package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"offdesk-tui/internal/files"
)

type directoryEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  *int64 `json:"size"`
}

// Entry names are untrusted: never allow them to escape the displayed directory.
func validEntryName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\x00")
}

func sortEntries(entries []directoryEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
}

// browserKey keeps escape sequences intact even when the terminal splits reads.
func (u *UI) browserKey(pending *[]byte) (byte, error) {
	for {
		if len(*pending) > 0 {
			b := (*pending)[0]
			*pending = (*pending)[1:]
			if b != 27 {
				return b, nil
			}
			timer := time.NewTimer(80 * time.Millisecond)
			for len(*pending) < 2 {
				select {
				case chunk := <-u.input:
					*pending = append(*pending, chunk...)
				case <-timer.C:
					return 27, nil
				case e := <-u.readErr:
					timer.Stop()
					return 0, e
				case <-u.ctx.Done():
					timer.Stop()
					return 0, u.ctx.Err()
				}
			}
			timer.Stop()
			if (*pending)[0] == '[' || (*pending)[0] == 'O' {
				b = (*pending)[1]
				*pending = (*pending)[2:]
				switch b {
				case 'A':
					return 'k', nil
				case 'B':
					return 'j', nil
				case 'C':
					return '\r', nil
				case 'D':
					return 'h', nil
				}
				continue
			}
			return 27, nil
		}
		select {
		case chunk := <-u.input:
			*pending = append(*pending, chunk...)
		case e := <-u.readErr:
			return 0, e
		case <-u.ctx.Done():
			return 0, u.ctx.Err()
		}
	}
}

func (u *UI) renderBrowser(title, dir string, entries []directoryEntry, selected int, help, notice string) {
	u.clear()
	u.print(title + "\n" + Safe(dir) + "\n\n")
	_, height := u.dimensions()
	visible := max(1, height-8)
	start := 0
	if selected >= visible {
		start = selected - visible + 1
	}
	if len(entries) == 0 {
		u.print("  (empty)\n")
	}
	for i := start; i < len(entries) && i < start+visible; i++ {
		marker := "  "
		if i == selected {
			marker = "> "
		}
		kind := "  "
		if entries[i].IsDir {
			kind = "/ "
		}
		u.print(marker + kind + Safe(entries[i].Name) + "\n")
	}
	u.print("\n" + help + "\n")
	if notice != "" {
		u.print(Safe(notice) + "\n")
	}
}

func (u *UI) remoteEntries(machine, dir string) ([]directoryEntry, error) {
	if e := files.ValidatePath(dir); e != nil {
		return nil, e
	}
	raw, e := u.API.ListFiles(u.ctx, machine, dir)
	if e != nil {
		return nil, e
	}
	var entries []directoryEntry
	if e = json.Unmarshal(raw, &entries); e != nil {
		return nil, errors.New("invalid directory listing")
	}
	filtered := entries[:0]
	for _, v := range entries {
		if validEntryName(v.Name) {
			filtered = append(filtered, v)
		}
	}
	sortEntries(filtered)
	return filtered, nil
}

func localEntries(dir string) ([]directoryEntry, error) {
	entries, e := os.ReadDir(dir)
	if e != nil {
		return nil, e
	}
	out := make([]directoryEntry, 0, len(entries))
	for _, v := range entries {
		// Do not follow symlinks in the local picker.
		if v.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, e := v.Info()
		if e != nil || (!v.IsDir() && !info.Mode().IsRegular()) {
			continue
		}
		out = append(out, directoryEntry{Name: v.Name(), IsDir: v.IsDir()})
	}
	sortEntries(out)
	return out, nil
}

func (u *UI) localPicker() (string, error) {
	dir, e := os.UserHomeDir()
	if e != nil {
		return "", e
	}
	entries, e := localEntries(dir)
	if e != nil {
		return "", e
	}
	selected := 0
	var pending []byte
	notice := ""
	for {
		u.renderBrowser("Offdesk · Select local file", dir, entries, selected, "↑/↓ or j/k move · Enter open/select · ←/h parent · q cancel", notice)
		k, e := u.browserKey(&pending)
		if e != nil {
			return "", e
		}
		notice = ""
		switch k {
		case 'q', 27, 3:
			return "", errCancelled
		case 'j':
			if selected+1 < len(entries) {
				selected++
			}
		case 'k':
			if selected > 0 {
				selected--
			}
		case 'h', 127, 8:
			next := filepath.Dir(dir)
			nextEntries, err := localEntries(next)
			if err != nil {
				notice = err.Error()
			} else {
				dir = next
				entries = nextEntries
				selected = 0
			}
		case '\r', '\n':
			if len(entries) == 0 {
				continue
			}
			entry := entries[selected]
			next := filepath.Join(dir, entry.Name)
			if !entry.IsDir {
				return next, nil
			}
			nextEntries, err := localEntries(next)
			if err != nil {
				notice = err.Error()
			} else {
				dir = next
				entries = nextEntries
				selected = 0
			}
		}
	}
}

func downloadDir() (string, error) {
	home, e := os.UserHomeDir()
	if e != nil {
		return "", e
	}
	for _, dir := range []string{filepath.Join(home, "storage", "downloads"), filepath.Join(home, "Downloads")} {
		if st, e := os.Stat(dir); e == nil && st.IsDir() {
			return dir, nil
		}
	}
	return home, nil
}

func (u *UI) fileMenu() error {
	tab := u.Config.Tabs[u.Config.Active]
	dir := "/"
	machines, e := u.API.Machines(u.ctx)
	if e != nil {
		return e
	}
	for _, m := range machines {
		if m.ID == tab.Machine && files.ValidatePath(m.Home) == nil {
			dir = m.Home
			break
		}
	}
	entries, e := u.remoteEntries(tab.Machine, dir)
	if e != nil {
		return e
	}
	selected := 0
	var pending []byte
	notice := ""
	for {
		u.renderBrowser("Offdesk · Files", dir, entries, selected, "↑/↓ j/k move · Enter open/download · h parent · u upload · a attach · q back", notice)
		k, e := u.browserKey(&pending)
		if e != nil {
			return e
		}
		notice = ""
		switch k {
		case 'q', 27, 3:
			return nil
		case 'j':
			if selected+1 < len(entries) {
				selected++
			}
		case 'k':
			if selected > 0 {
				selected--
			}
		case 'h', 127, 8:
			next := path.Dir(dir)
			nextEntries, err := u.remoteEntries(tab.Machine, next)
			if err != nil {
				notice = err.Error()
			} else {
				dir = next
				entries = nextEntries
				selected = 0
			}
		case 'r':
			nextEntries, err := u.remoteEntries(tab.Machine, dir)
			if err != nil {
				notice = err.Error()
			} else {
				entries = nextEntries
				selected = min(selected, max(0, len(entries)-1))
			}
		case '\r', '\n':
			if len(entries) == 0 {
				continue
			}
			entry := entries[selected]
			remote := path.Join(dir, entry.Name)
			if entry.IsDir {
				nextEntries, err := u.remoteEntries(tab.Machine, remote)
				if err != nil {
					notice = err.Error()
				} else {
					dir = remote
					entries = nextEntries
					selected = 0
				}
				continue
			}
			localDir, err := downloadDir()
			if err != nil {
				notice = err.Error()
				continue
			}
			local := filepath.Join(localDir, entry.Name)
			overwrite := false
			if _, err = os.Lstat(local); err == nil {
				answer, err := u.prompt("File exists at " + Safe(local) + ". Type yes to overwrite: ")
				if err != nil {
					if errors.Is(err, errCancelled) {
						continue
					}
					return err
				}
				if answer != "yes" {
					notice = "Download cancelled."
					continue
				}
				overwrite = true
			} else if !os.IsNotExist(err) {
				notice = err.Error()
				continue
			}
			err = u.transfer(func(ctx context.Context, progress func(int64)) error {
				return files.Download(ctx, u.API, tab.Machine, remote, local, overwrite, progress)
			})
			if err != nil {
				notice = err.Error()
			} else {
				notice = "Downloaded to " + local
			}
		case 'a':
			local, err := u.localPicker()
			if err != nil {
				if errors.Is(err, errCancelled) {
					notice = "Attachment cancelled."
					continue
				}
				return err
			}
			u.print("Offdesk places this file in remote temporary storage and pastes its path into the terminal. There is no delivery receipt.\n")
			answer, err := u.prompt("Type yes to attach: ")
			if err != nil {
				if errors.Is(err, errCancelled) {
					continue
				}
				return err
			}
			if answer != "yes" {
				notice = "Attachment cancelled."
				continue
			}
			return u.attachFile(tab.Machine, tab.Terminal, local)
		case 'u':
			local, err := u.localPicker()
			if err != nil {
				if errors.Is(err, errCancelled) {
					notice = "Upload cancelled."
					continue
				}
				return err
			}
			name := filepath.Base(local)
			exists := false
			for _, entry := range entries {
				if entry.Name == name && !entry.IsDir {
					exists = true
					break
				}
			}
			if !exists {
				notice = "Offdesk cannot create files here. Upload only replaces an existing UTF-8 text file with the same name."
				continue
			}
			remote := path.Join(dir, name)
			answer, err := u.prompt("Replace " + Safe(remote) + " with local text file? Type yes: ")
			if err != nil {
				if errors.Is(err, errCancelled) {
					continue
				}
				return err
			}
			if answer != "yes" {
				notice = "Upload cancelled."
				continue
			}
			err = u.transfer(func(ctx context.Context, progress func(int64)) error {
				return files.Replace(ctx, u.API, tab.Machine, local, remote, true, progress)
			})
			if err != nil {
				notice = err.Error()
			} else {
				notice = fmt.Sprintf("Replaced %s and verified checksum.", remote)
			}
		}
	}
}
