package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"offdesk-tui/internal/api"
	"offdesk-tui/internal/config"
	"offdesk-tui/internal/files"
	"offdesk-tui/internal/sessions"
	"offdesk-tui/internal/terminal"
	"offdesk-tui/internal/transport"
)

// A prefix on its own opens this menu immediately. The terminal is detached
// while it is visible, and reattached when the user returns.
func (u *UI) commandMenu() (bool, error) {
	u.clear()
	u.print("Offdesk · Commands\n\n")
	if u.Config.Active >= 0 && u.Config.Active < len(u.Config.Tabs) {
		u.print("Terminal: " + Safe(u.Config.Tabs[u.Config.Active].Label) + "\n\n")
	}
	u.print(" f  Files          c  Control\n n  New terminal   s  Terminals\n d  Detach tab     r  Rename\n [  Previous tab   ]  Next tab\n 1–9  Switch tab   x  Terminate\n ?  Help           q  Quit\n Esc  Return\n\n")
	u.print(fmt.Sprintf("Press a key; Ctrl+%c again sends the prefix.\n", u.Config.Prefix+64))
	for {
		select {
		case <-u.ctx.Done():
			return true, nil
		case e := <-u.readErr:
			return true, e
		case b := <-u.input:
			if len(b) == 0 {
				continue
			}
			key := b[0]
			if key == u.Config.Prefix {
				u.actions = append([]terminal.Action{{Data: []byte{key}}}, u.actions...)
				if len(b) > 1 {
					u.actions = append(u.actions, u.decoder.Feed(b[1:])...)
				}
				return false, nil
			}
			if key == 27 || key == 3 || key == '\r' || key == '\n' {
				return false, nil
			}
			if strings.ContainsRune("fcnsq[]123456789drxtl?bho", rune(key)) {
				return u.local(key)
			}
			u.print("Unknown key. Choose one of the commands above.\n")
		}
	}
}

func terminalLabel(label string) string {
	if strings.Contains(label, "tmux -L offdesk-tui-") {
		return "Isolated tmux"
	}
	if strings.Contains(label, "tmux -L default") || strings.Contains(label, "tmux -S /tmp/tmux-") {
		return "Default tmux"
	}
	if strings.TrimSpace(label) == "" {
		return "Shell"
	}
	return label
}

// Load foreground names on demand with bounded concurrency. The endpoint only
// describes the outer Offdesk pane; it cannot inspect nested tmux windows.
func (u *UI) foregroundNames(terminals []api.Terminal) map[string]string {
	ctx, cancel := context.WithTimeout(u.ctx, 3*time.Second)
	defer cancel()
	result := make(map[string]string)
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for _, t := range terminals {
		wg.Add(1)
		go func(t api.Terminal) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			name, err := u.API.ForegroundProcess(ctx, t.Machine, t.ID)
			if err == nil && name != "" {
				mu.Lock()
				result[t.Machine+"\x00"+t.ID] = name
				mu.Unlock()
			}
		}(t)
	}
	wg.Wait()
	return result
}

func (u *UI) tabMenu() error {
	ctx, cancel := context.WithTimeout(u.ctx, 5*time.Second)
	remote, discoveryErr := u.API.Terminals(ctx)
	machines, machinesErr := u.API.Machines(ctx)
	cancel()
	var names map[string]string
	if discoveryErr == nil {
		names = u.foregroundNames(remote)
	}
	var other []api.Terminal
	for _, t := range remote {
		found := false
		for _, tab := range u.Config.Tabs {
			if tab.Machine == t.Machine && tab.Terminal == t.ID {
				found = true
				break
			}
		}
		if !found {
			other = append(other, t)
		}
	}
	machineNames := make(map[string]string)
	for _, m := range machines {
		machineNames[m.ID] = m.Name
	}
	remoteByKey := make(map[string]api.Terminal)
	for _, t := range remote {
		remoteByKey[t.Machine+"\x00"+t.ID] = t
	}
	if discoveryErr == nil && machinesErr == nil {
		online := make(map[string]bool)
		for _, m := range machines {
			online[m.ID] = true
		}
		kept := u.Config.DetachedTabs[:0]
		for _, tab := range u.Config.DetachedTabs {
			_, present := remoteByKey[tab.Machine+"\x00"+tab.Terminal]
			if present || !online[tab.Machine] {
				kept = append(kept, tab)
			}
		}
		changed := len(kept) != len(u.Config.DetachedTabs)
		u.Config.DetachedTabs = kept
		if changed {
			if e := u.save(); e != nil {
				return e
			}
		}
	}
	type row struct {
		tab      config.Tab
		saved    int
		current  bool
		detached bool
		group    string
	}
	var rows []row
	for i, tab := range u.Config.Tabs {
		group := socketGroup(tab, remoteByKey[tab.Machine+"\x00"+tab.Terminal].Title)
		rows = append(rows, row{tab: tab, saved: i, current: i == u.Config.Active, group: group})
	}
	for _, t := range other {
		tab := config.Tab{Machine: t.Machine, Terminal: t.ID, Label: terminalLabel(t.Title)}
		detached := false
		for _, d := range u.Config.DetachedTabs {
			if d.Machine == t.Machine && d.Terminal == t.ID {
				tab = d
				detached = true
				break
			}
		}
		rows = append(rows, row{tab: tab, saved: -1, detached: detached, group: socketGroup(tab, t.Title)})
	}
	rank := map[string]int{"Default tmux": 0, "Offdesk shell": 1, "Other / unknown": 2}
	sort.SliceStable(rows, func(i, j int) bool { return rank[rows[i].group] < rank[rows[j].group] })
	for {
		u.clear()
		u.print("Offdesk · Terminals\n")
		for _, group := range []string{"Default tmux", "Offdesk shell", "Other / unknown"} {
			printed := false
			for i, r := range rows {
				if r.group != group {
					continue
				}
				if !printed {
					u.print("\n" + group + ":\n")
					printed = true
				}
				marker := "  "
				if r.current {
					marker = "* "
				}
				label := terminalLabel(r.tab.Label)
				if group == "Default tmux" && (label == "Shell" || strings.HasPrefix(label, "Shell ")) {
					label = "Default tmux"
				}
				process := names[r.tab.Machine+"\x00"+r.tab.Terminal]
				if process != "" && process != "tmux" {
					if label == "Shell" || strings.HasPrefix(label, "Shell ") {
						label = process
					} else if label != process {
						label += " · " + process
					}
				} else if process == "tmux" && group != "Default tmux" {
					label += " · tmux"
				}
				machine := machineNames[r.tab.Machine]
				if machine == "" {
					machine = "machine " + r.tab.Machine[:min(8, len(r.tab.Machine))]
				}
				status := ""
				if r.detached {
					status = " · detached here"
				} else if r.saved < 0 {
					status = " · not open here"
				}
				u.print(fmt.Sprintf("%s%d  %s  (%s)%s\n", marker, i+1, Safe(label), Safe(machine), status))
			}
		}
		if discoveryErr != nil {
			u.print("\nCould not load other terminals; saved tabs are still shown.\n")
		}
		u.print("\nDefault tmux windows: attach, then Ctrl+B w.\n")
		choice, e := u.prompt("\nTerminal number (Enter to return): ")
		if e != nil {
			return e
		}
		choice = strings.TrimSpace(choice)
		if choice == "" || strings.EqualFold(choice, "q") {
			return nil
		}
		n, e := strconv.Atoi(choice)
		if e == nil && n >= 1 && n <= len(rows) {
			selected := rows[n-1]
			if selected.saved >= 0 {
				u.Config.Active = selected.saved
			} else {
				sessions.Add(u.Config, selected.tab)
			}
			return u.save()
		}
		u.print("Invalid terminal.\n")
		if _, e = u.prompt("Enter to try again: "); e != nil {
			return e
		}
	}
}

// Existing terminals lack socket metadata; infer only recognizable startup
// commands and keep the rest in an explicitly unknown group.
func socketGroup(tab config.Tab, remoteTitle string) string {
	if tab.Socket == "default" {
		return "Default tmux"
	}
	if tab.Socket == "offdesk" {
		return "Offdesk shell"
	}
	if tab.TmuxServer != "" {
		return "Other / unknown"
	}
	for _, title := range []string{tab.Label, remoteTitle} {
		if terminalLabel(title) == "Default tmux" {
			return "Default tmux"
		}
	}
	return "Other / unknown"
}

// These menus only operate on the selected machine. The terminal attachment is
// closed while a menu is displayed, so the full screen belongs to the menu.
func (u *UI) controlMenu() error {
	tab := u.Config.Tabs[u.Config.Active]
	for {
		u.clear()
		u.print("Offdesk · Terminal control\n\n")
		owner, e := u.API.Controller(u.ctx, tab.Machine)
		if e != nil {
			return e
		}
		status := "Another device has control"
		if owner == "" {
			status = "No device has control"
		} else if owner == u.API.Device {
			status = "This device has control"
		}
		u.print(status + "\n\n")
		choice, e := u.prompt("[t] take control  [l] release  [Enter] return: ")
		if e != nil {
			return e
		}
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "":
			return nil
		case "t":
			if e = u.API.Control(u.ctx, tab.Machine, true); e != nil {
				return e
			}
		case "l":
			if e = u.API.Control(u.ctx, tab.Machine, false); e != nil {
				return e
			}
		}
	}
}

func (u *UI) transfer(run func(context.Context, func(int64)) error) error {
	ctx, cancel := context.WithCancel(u.ctx)
	defer cancel()
	done := make(chan error, 1)
	progress := make(chan int64, 1)
	go func() {
		done <- run(ctx, func(n int64) {
			select {
			case progress <- n:
			default:
			}
		})
	}()
	u.print("Transferring… Ctrl+C cancels.\n")
	cancelling := false
	for {
		select {
		case e := <-done:
			if cancelling && e != nil {
				return errors.New("transfer cancelled or interrupted; a remote write already sent may have completed")
			}
			return e
		case n := <-progress:
			u.print(fmt.Sprintf("Processed %d bytes.\n", n))
		case b := <-u.input:
			if bytesContainCtrlC(b) && !cancelling {
				cancelling = true
				cancel()
				u.print("Cancelling…\n")
			}
		case e := <-u.readErr:
			cancel()
			return e
		case <-u.ctx.Done():
			return u.ctx.Err()
		}
	}
}
func bytesContainCtrlC(b []byte) bool {
	for _, v := range b {
		if v == 3 {
			return true
		}
	}
	return false
}

// attachFile keeps the same attach alive after submission, because the node
// pastes the uploaded path through that attach and does not acknowledge it.
func (u *UI) attachFile(machine, terminal, local string) error {
	ctx, cancel := context.WithTimeout(u.ctx, 15*time.Second)
	defer cancel()
	if e := u.API.Control(ctx, machine, true); e != nil {
		return e
	}
	id, events, e := u.Client.Open(ctx, transport.TerminalPath(machine, terminal, u.API.Device))
	if e != nil {
		return e
	}
	keep := false
	defer func() {
		if !keep {
			cl, stop := context.WithTimeout(context.Background(), 2*time.Second)
			defer stop()
			_ = u.Client.CloseSocket(cl, id)
		}
	}()
	u.clear()
	// The node creates the attach asynchronously. Wait for its first terminal
	// output before sending, otherwise an early image_paste can be dropped.
	for {
		select {
		case m := <-events:
			if m.Type == "binary" {
				if _, e = u.output.Write(m.Binary); e != nil {
					return e
				}
				goto ready
			}
			if m.Type == "closed" || m.Type == "error" {
				return errors.New("terminal closed before attachment")
			}
		case <-ctx.Done():
			return errors.New("terminal did not become ready")
		}
	}
ready:
	stopPump := make(chan struct{})
	stopped := make(chan struct{})
	pumpErr := make(chan error, 1)
	go func() {
		defer close(stopped)
		for {
			select {
			case <-stopPump:
				return
			case <-u.ctx.Done():
				return
			case m := <-events:
				if m.Type == "binary" {
					if _, e := u.output.Write(m.Binary); e != nil {
						pumpErr <- e
						return
					}
				} else if m.Type == "closed" || m.Type == "error" {
					pumpErr <- errors.New("terminal closed during attachment")
					return
				}
			}
		}
	}()
	e = u.transfer(func(ctx context.Context, progress func(int64)) error {
		return files.SendAttachment(ctx, u.Client, id, local, progress)
	})
	close(stopPump)
	<-stopped
	if e != nil {
		return e
	}
	select {
	case e = <-pumpErr:
		return e
	default:
	}
	// Do not claim delivery: upstream does not send a receipt for image_paste.
	u.resumeID = id
	u.resumeEvents = events
	keep = true
	return nil
}
