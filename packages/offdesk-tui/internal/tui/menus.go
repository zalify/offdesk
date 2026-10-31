package tui

import (
	"context"
	"errors"
	"fmt"
	"sort"
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
	u.print(" f  Files          s  Terminals\n n  New terminal   r  Rename\n d  Detach tab     x  Terminate\n [  Previous tab   ]  Next tab\n 1–9  Switch tab   q  Quit\n ?  Help           Esc  Return\n\n")
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
	var notice string
	for {
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
		if notice != "" {
			u.print("\n" + notice + "\n")
			notice = ""
		}
		choice, e := u.prompt("\nTerminal number, a=attach, d=detach, x=terminate (e.g. 1, 1,2, a all, d all, x all; Enter to return): ")
		if e != nil {
			return e
		}
		choice = strings.TrimSpace(choice)
		if choice == "" || strings.EqualFold(choice, "q") {
			return nil
		}
		cmd, arg := parseCommand(choice)
		if cmd == "x" {
			if arg == "all" || arg == "all -y" {
				proceed := arg == "all -y"
				if !proceed {
					confirm, err := u.prompt(fmt.Sprintf("Terminate all %d terminal(s)? [y/n]: ", len(rows)))
					if err != nil {
						return err
					}
					c := strings.TrimSpace(strings.ToLower(confirm))
					proceed = c == "y" || c == "yes"
				}
				if proceed {
					skippedDefault := 0
					termCount := 0
					for _, r := range rows {
						if r.group == "Default tmux" || r.tab.Socket == "default" {
							skippedDefault++
							continue
						}
						_ = u.terminateTerminal(r.tab.Machine, r.tab.Terminal)
						u.removeConfigTab(r.tab.Machine, r.tab.Terminal)
						termCount++
					}
					_ = u.save()
					msg := fmt.Sprintf("Terminated %d terminal(s).", termCount)
					if skippedDefault > 0 {
						msg += fmt.Sprintf(" Preserved %d persistent Default tmux session(s).", skippedDefault)
					}
					notice = msg
				}
				continue
			}
			indices := parseIndices(arg, len(rows))
			if len(indices) == 0 {
				notice = "Specify terminal number(s) to terminate (e.g. x 1, x 1,2, x all)."
				continue
			}
			var targets []row
			skippedDefault := 0
			for _, idx := range indices {
				target := rows[idx-1]
				if target.group == "Default tmux" || target.tab.Socket == "default" {
					skippedDefault++
					continue
				}
				targets = append(targets, target)
			}
			if len(targets) == 0 {
				u.print("\nDefault tmux sessions are persistent and cannot be terminated.\nUse detach instead.\n")
				_, _ = u.prompt("Enter to continue: ")
				continue
			}
			promptMsg := fmt.Sprintf("Terminate %s? [y/n]: ", terminalLabel(targets[0].tab.Label))
			if len(targets) > 1 {
				promptMsg = fmt.Sprintf("Terminate %d terminal(s)? [y/n]: ", len(targets))
			}
			confirm, err := u.prompt(promptMsg)
			if err != nil {
				return err
			}
			c := strings.TrimSpace(strings.ToLower(confirm))
			if c == "y" || c == "yes" {
				for _, target := range targets {
					_ = u.terminateTerminal(target.tab.Machine, target.tab.Terminal)
					u.removeConfigTab(target.tab.Machine, target.tab.Terminal)
				}
				_ = u.save()
				msg := fmt.Sprintf("Terminated %d terminal(s).", len(targets))
				if skippedDefault > 0 {
					msg += fmt.Sprintf(" Preserved %d persistent Default tmux session(s).", skippedDefault)
				}
				notice = msg
			}
			continue
		}
		if cmd == "d" {
			if arg == "all" {
				detachedCount := 0
				for _, r := range rows {
					if r.saved >= 0 {
						u.detachTab(r.tab)
						detachedCount++
					}
				}
				for len(u.Config.Tabs) > 0 {
					u.detachTab(u.Config.Tabs[0])
				}
				_ = u.save()
				notice = fmt.Sprintf("Detached %d open terminal(s).", detachedCount)
				continue
			}
			indices := parseIndices(arg, len(rows))
			if len(indices) == 0 {
				notice = "Specify terminal number(s) to detach (e.g. d 1, d 1,2, d all)."
				continue
			}
			for _, idx := range indices {
				u.detachTab(rows[idx-1].tab)
			}
			_ = u.save()
			notice = fmt.Sprintf("Detached %d terminal(s).", len(indices))
			continue
		}
		if cmd == "a" {
			if arg == "all" {
				for _, r := range rows {
					sessions.Add(u.Config, r.tab)
				}
				_ = u.save()
				notice = fmt.Sprintf("Attached all %d terminal(s). (Enter to return to active terminal)", len(rows))
				continue
			}
			indices := parseIndices(arg, len(rows))
			if len(indices) == 0 {
				notice = "Specify terminal number(s) to attach (e.g. a 1, a 1,2, a all)."
				continue
			}
			for _, idx := range indices {
				r := rows[idx-1]
				sessions.Add(u.Config, r.tab)
			}
			_ = u.save()
			notice = fmt.Sprintf("Attached %d terminal(s). (Enter to return to active terminal)", len(indices))
			continue
		}
		indices := parseIndices(choice, len(rows))
		if len(indices) > 0 {
			for _, idx := range indices {
				r := rows[idx-1]
				sessions.Add(u.Config, r.tab)
			}
			first := rows[indices[0]-1]
			for i, tab := range u.Config.Tabs {
				if tab.Machine == first.tab.Machine && tab.Terminal == first.tab.Terminal {
					u.Config.Active = i
					break
				}
			}
			return u.save()
		}
		notice = "Invalid choice. Enter terminal number(s), or a, d, x commands."
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
