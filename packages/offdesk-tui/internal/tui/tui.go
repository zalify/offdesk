// Package tui provides a small raw-terminal menu and native ANSI passthrough.
package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/term"
	"offdesk-tui/internal/api"
	"offdesk-tui/internal/config"
	"offdesk-tui/internal/sessions"
	"offdesk-tui/internal/terminal"
	"offdesk-tui/internal/transport"
)

type UI struct {
	Config         *config.Config
	Client         *transport.Client
	API            api.API
	ctx            context.Context
	input          chan []byte
	readErr        chan error
	size           chan os.Signal
	decoder        terminal.Decoder
	actions        []terminal.Action
	resumeID       string
	resumeEvents   <-chan transport.Message
	recovering     bool
	streamed       bool
	autoCreated    bool
	lastEOF        time.Time
	tmuxPrefix     bool
	lastTmuxDetach time.Time
	output         io.Writer
}

var errCancelled = errors.New("cancelled")
var errAttachClosed = errors.New("terminal attach closed")

func Safe(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 32 && r != 127 && (r < 0x80 || r >= 0xa0) {
			b.WriteRune(r)
		}
	}
	return b.String()
}
func (u *UI) print(s string) { fmt.Fprint(u.output, strings.ReplaceAll(s, "\n", "\r\n")) }
func (u *UI) prompt(label string) (string, error) {
	u.print(label)
	var line []byte
	for {
		select {
		case <-u.ctx.Done():
			return "", u.ctx.Err()
		case e := <-u.readErr:
			return "", e
		case b := <-u.input:
			for _, v := range b {
				switch v {
				case 3, 27:
					return "", errCancelled
				case '\r', '\n':
					u.print("\n")
					return string(line), nil
				case 127, 8:
					if len(line) > 0 {
						_, n := utf8.DecodeLastRune(line)
						line = line[:len(line)-n]
						u.print("\b \b")
					}
				default:
					if v >= 32 && v != 127 && len(line) < 4096 {
						line = append(line, v)
						_, _ = u.output.Write([]byte{v})
					}
				}
			}
		}
	}
}
func (u *UI) clear() { fmt.Fprint(u.output, "\x1b[?1049l\x1b[?1049h\x1b[0m\x1b[?25h\x1b[H\x1b[2J") }
func (u *UI) dimensions() (int, int) {
	w, h, e := term.GetSize(int(os.Stdout.Fd()))
	if e != nil {
		return 80, 24
	}
	return max(1, min(w, 65535)), max(1, min(h, 65535))
}
func (u *UI) connect() error {
	if u.Client != nil {
		u.Client.Close()
	}
	c, id, e := transport.Connect(u.ctx, u.Config.Credentials, "")
	if e != nil {
		return e
	}
	u.Client = c
	u.API = api.API{C: c, Device: id}
	return nil
}
func (u *UI) save() error { return config.Save(*u.Config) }
func (u *UI) isDefaultTmux(machine, terminalID, title string) bool {
	for _, tab := range u.Config.Tabs {
		if tab.Machine == machine && tab.Terminal == terminalID {
			if tab.Socket == "default" || socketGroup(tab, title) == "Default tmux" {
				return true
			}
		}
	}
	for _, tab := range u.Config.DetachedTabs {
		if tab.Machine == machine && tab.Terminal == terminalID {
			if tab.Socket == "default" || socketGroup(tab, title) == "Default tmux" {
				return true
			}
		}
	}
	return socketGroup(config.Tab{Label: title}, title) == "Default tmux"
}

func (u *UI) findDefaultTmux(machineID string, ts []api.Terminal) (api.Terminal, bool) {
	for _, t := range ts {
		if t.Machine == machineID && u.isDefaultTmux(t.Machine, t.ID, t.Title) {
			return t, true
		}
	}
	for _, tab := range u.Config.Tabs {
		if tab.Machine == machineID && tab.Socket == "default" {
			for _, t := range ts {
				if t.Machine == machineID && t.ID == tab.Terminal {
					return t, true
				}
			}
		}
	}
	for _, tab := range u.Config.DetachedTabs {
		if tab.Machine == machineID && tab.Socket == "default" {
			for _, t := range ts {
				if t.Machine == machineID && t.ID == tab.Terminal {
					return t, true
				}
			}
		}
	}
	return api.Terminal{}, false
}

func (u *UI) createTerminal(m api.Machine, cwd string, initial bool) error {
	ts, _ := u.API.Terminals(u.ctx)
	existingTmux, hasExisting := u.findDefaultTmux(m.ID, ts)
	if hasExisting {
		u.print("\nTerminal on " + Safe(m.Name) + ":\n  1  Default tmux socket (already running — attach to existing)\n  2  Offdesk socket — new Offdesk-managed shell\n")
	} else {
		u.print("\nTerminal on " + Safe(m.Name) + ":\n  1  Default tmux socket — attach or create a session\n  2  Offdesk socket — new Offdesk-managed shell\n")
	}
	var startup, server, socket string
	for {
		choice, e := u.prompt("Socket [1/2, Enter=1, q=cancel]: ")
		if e != nil {
			return e
		}
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "", "1":
			if hasExisting {
				u.print("Attaching to existing Default tmux session on " + Safe(m.Name) + "…\n")
				sessions.Add(u.Config, config.Tab{Machine: m.ID, Terminal: existingTmux.ID, Label: "Default tmux", Socket: "default"})
				return u.save()
			}
			socket = "default"
			startup, server, e = sessions.TmuxStartup()
			if e != nil {
				return e
			}
		case "2":
			socket = "offdesk"
		case "q":
			if initial {
				return io.EOF
			}
			return errCancelled
		default:
			u.print("Choose 1 or 2.\n")
			continue
		}
		break
	}
	u.print("Starting a terminal on " + Safe(m.Name) + "…\n")
	var e error
	if e = u.API.Control(u.ctx, m.ID, true); e != nil {
		return e
	}
	w, h := u.dimensions()
	t, e := u.API.CreateWithStartup(u.ctx, m.ID, cwd, w, h, startup)
	if e != nil {
		return e
	}
	label := strings.TrimSpace(t.Title)
	if label == "" {
		if socket == "default" {
			label = "Default tmux"
		} else {
			label = "Shell"
		}
	}
	base := label
	for n := 2; ; n++ {
		used := false
		for _, tab := range u.Config.Tabs {
			if tab.Label == label {
				used = true
				break
			}
		}
		if !used {
			break
		}
		label = fmt.Sprintf("%s %d", base, n)
	}
	sessions.Add(u.Config, config.Tab{Machine: m.ID, Terminal: t.ID, Label: label, TmuxServer: server, Socket: socket})
	return u.save()
}
func (u *UI) terminateTerminal(machine, terminal string) error {
	if e := u.API.Control(u.ctx, machine, true); e != nil {
		return e
	}
	return u.API.Destroy(u.ctx, machine, terminal)
}

func (u *UI) removeConfigTab(machine, terminal string) {
	for j := len(u.Config.Tabs) - 1; j >= 0; j-- {
		if u.Config.Tabs[j].Machine == machine && u.Config.Tabs[j].Terminal == terminal {
			u.Config.Tabs = append(u.Config.Tabs[:j], u.Config.Tabs[j+1:]...)
		}
	}
	for j := len(u.Config.DetachedTabs) - 1; j >= 0; j-- {
		if u.Config.DetachedTabs[j].Machine == machine && u.Config.DetachedTabs[j].Terminal == terminal {
			u.Config.DetachedTabs = append(u.Config.DetachedTabs[:j], u.Config.DetachedTabs[j+1:]...)
		}
	}
	if u.Config.Active >= len(u.Config.Tabs) {
		u.Config.Active = max(0, len(u.Config.Tabs)-1)
	}
}

func (u *UI) detachTab(tab config.Tab) {
	for j := len(u.Config.Tabs) - 1; j >= 0; j-- {
		if u.Config.Tabs[j].Machine == tab.Machine && u.Config.Tabs[j].Terminal == tab.Terminal {
			tab = u.Config.Tabs[j]
			u.Config.Tabs = append(u.Config.Tabs[:j], u.Config.Tabs[j+1:]...)
		}
	}
	found := false
	for _, d := range u.Config.DetachedTabs {
		if d.Machine == tab.Machine && d.Terminal == tab.Terminal {
			found = true
			break
		}
	}
	if !found {
		u.Config.DetachedTabs = append(u.Config.DetachedTabs, tab)
	}
	if u.Config.Active >= len(u.Config.Tabs) {
		u.Config.Active = max(0, len(u.Config.Tabs)-1)
	}
}

func parseCommand(input string) (cmd string, arg string) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", ""
	}
	lower := strings.ToLower(input)
	for _, prefix := range []string{"x", "a", "d"} {
		if strings.HasPrefix(lower, prefix) {
			rest := strings.TrimSpace(input[len(prefix):])
			if rest == "" || rest == "all" || strings.HasPrefix(strings.ToLower(rest), "all ") || (len(rest) > 0 && (rest[0] >= '0' && rest[0] <= '9' || rest[0] == ',' || rest[0] == ' ')) {
				return prefix, rest
			}
		}
	}
	return "", input
}

func parseIndices(input string, maxLen int) []int {
	clean := strings.ReplaceAll(input, ",", " ")
	fields := strings.Fields(clean)
	var result []int
	seen := make(map[int]bool)
	for _, f := range fields {
		if strings.Contains(f, "-") {
			parts := strings.SplitN(f, "-", 2)
			start, err1 := strconv.Atoi(parts[0])
			end, err2 := strconv.Atoi(parts[1])
			if err1 == nil && err2 == nil && start <= end {
				for n := start; n <= end; n++ {
					if n >= 1 && n <= maxLen && !seen[n] {
						seen[n] = true
						result = append(result, n)
					}
				}
				continue
			}
		}
		n, err := strconv.Atoi(f)
		if err == nil && n >= 1 && n <= maxLen {
			if !seen[n] {
				seen[n] = true
				result = append(result, n)
			}
		}
	}
	return result
}

func (u *UI) choose(startup bool) error {
	for {
		u.clear()
		u.print("Offdesk TUI — select a terminal\n")
		machines, e := u.API.Machines(u.ctx)
		if e != nil {
			return e
		}
		ts, e := u.API.Terminals(u.ctx)
		if e != nil {
			return e
		}
		if startup {
			var changed bool
			ts, changed = sessions.VisibleAtStartup(u.Config, ts, time.Now())
			if changed {
				if e = u.save(); e != nil {
					return e
				}
			}
		}
		if startup && len(machines) == 1 && len(ts) == 0 && !u.autoCreated {
			e = u.createTerminal(machines[0], machines[0].Home, true)
			if e == nil {
				u.autoCreated = true
			}
			return e
		}
		if len(machines) == 0 {
			return errors.New("no machine is online")
		}
		if startup && len(ts) == 0 && len(machines) > 1 && !u.autoCreated {
			u.print("No terminals are running. Select a machine:\n\n")
			for i, m := range machines {
				u.print(fmt.Sprintf("  %d  %s\n", i+1, Safe(m.Name)))
			}
			choice, e := u.prompt("\nMachine number (q to quit): ")
			if e != nil {
				return e
			}
			if strings.TrimSpace(choice) == "q" {
				return io.EOF
			}
			n, e := strconv.Atoi(strings.TrimSpace(choice))
			if e != nil || n < 1 || n > len(machines) {
				return errors.New("invalid machine")
			}
			e = u.createTerminal(machines[n-1], machines[n-1].Home, true)
			if e == nil {
				u.autoCreated = true
			}
			return e
		}
		machineNames := make(map[string]string, len(machines))
		for _, m := range machines {
			machineNames[m.ID] = m.Name
		}
		names := u.foregroundNames(ts)
		if len(machines) == 1 {
			u.print(fmt.Sprintf("Machine: %s\n\n", Safe(machines[0].Name)))
		} else {
			for i, m := range machines {
				u.print(fmt.Sprintf("Machine %d: %s\n", i+1, Safe(m.Name)))
			}
			u.print("\n")
		}
		for i, t := range ts {
			label := terminalLabel(t.Title)
			proc := names[t.Machine+"\x00"+t.ID]
			if proc != "" && proc != "tmux" {
				if label == "Shell" || strings.HasPrefix(label, "Shell ") {
					label = proc
				} else if label != proc {
					label += " · " + proc
				}
			}
			machineTag := ""
			if len(machines) > 1 {
				mName := machineNames[t.Machine]
				if mName == "" {
					mName = t.Machine[:min(8, len(t.Machine))]
				}
				machineTag = fmt.Sprintf(" [%s]", mName)
			}
			detached := false
			for _, d := range u.Config.DetachedTabs {
				if d.Machine == t.Machine && d.Terminal == t.ID {
					detached = true
					break
				}
			}
			status := ""
			if !t.Reachable {
				status = " · unreachable"
			} else if detached {
				status = " · detached here"
			}
			u.print(fmt.Sprintf("  %d  %s%s  (%s)%s\n", i+1, Safe(label), Safe(machineTag), Safe(t.Cwd), status))
		}
		s, e := u.prompt("\nTerminal number, a=attach, d=detach, x=terminate, n=new, q=quit (e.g. 1, 1,2, a all, d all, x all): ")
		if e != nil {
			return e
		}
		s = strings.TrimSpace(s)
		if s == "q" {
			return io.EOF
		}
		if s == "n" {
			m := machines[0]
			if len(machines) > 1 {
				s, e = u.prompt("Machine number: ")
				if e != nil {
					return e
				}
				n, _ := strconv.Atoi(s)
				if n < 1 || n > len(machines) {
					return errors.New("invalid machine")
				}
				m = machines[n-1]
			}
			cwd, e := u.prompt("Working directory (empty = machine home): ")
			if e != nil {
				return e
			}
			if cwd == "" {
				cwd = m.Home
			}
			return u.createTerminal(m, cwd, false)
		}
		cmd, arg := parseCommand(s)
		if cmd == "x" {
			if arg == "all" || arg == "all -y" {
				proceed := arg == "all -y"
				if !proceed {
					confirm, err := u.prompt(fmt.Sprintf("Terminate all %d terminal(s)? [y/n]: ", len(ts)))
					if err != nil {
						return err
					}
					c := strings.TrimSpace(strings.ToLower(confirm))
					proceed = c == "y" || c == "yes"
				}
				if proceed {
					skippedDefault := 0
					for _, t := range ts {
						if u.isDefaultTmux(t.Machine, t.ID, t.Title) {
							skippedDefault++
							continue
						}
						_ = u.terminateTerminal(t.Machine, t.ID)
						u.removeConfigTab(t.Machine, t.ID)
					}
					_ = u.save()
					if skippedDefault > 0 {
						u.print(fmt.Sprintf("\nPreserved %d persistent Default tmux session(s).\n", skippedDefault))
						_, _ = u.prompt("Enter to continue: ")
					}
				}
				continue
			}
			indices := parseIndices(arg, len(ts))
			if len(indices) == 0 {
				u.print("Specify terminal number(s) to terminate (e.g. x 1, x 1,2, x all).\n")
				_, _ = u.prompt("Enter to continue: ")
				continue
			}
			var targets []api.Terminal
			skippedDefault := 0
			for _, idx := range indices {
				t := ts[idx-1]
				if u.isDefaultTmux(t.Machine, t.ID, t.Title) {
					skippedDefault++
					continue
				}
				targets = append(targets, t)
			}
			if len(targets) == 0 {
				u.print("\nDefault tmux sessions are persistent and cannot be terminated.\nUse detach instead.\n")
				_, _ = u.prompt("Enter to continue: ")
				continue
			}
			promptMsg := fmt.Sprintf("Terminate %s (%s)? [y/n]: ", terminalLabel(targets[0].Title), Safe(targets[0].Cwd))
			if len(targets) > 1 {
				promptMsg = fmt.Sprintf("Terminate %d terminal(s)? [y/n]: ", len(targets))
			}
			confirm, err := u.prompt(promptMsg)
			if err != nil {
				return err
			}
			c := strings.TrimSpace(strings.ToLower(confirm))
			if c == "y" || c == "yes" {
				for _, t := range targets {
					_ = u.terminateTerminal(t.Machine, t.ID)
					u.removeConfigTab(t.Machine, t.ID)
				}
				_ = u.save()
				if skippedDefault > 0 {
					u.print(fmt.Sprintf("\nPreserved %d persistent Default tmux session(s).\n", skippedDefault))
					_, _ = u.prompt("Enter to continue: ")
				}
			}
			continue
		}
		if cmd == "d" {
			if arg == "all" {
				for _, t := range ts {
					u.detachTab(config.Tab{Machine: t.Machine, Terminal: t.ID, Label: terminalLabel(t.Title)})
				}
				_ = u.save()
				continue
			}
			indices := parseIndices(arg, len(ts))
			if len(indices) == 0 {
				u.print("Specify terminal number(s) to detach (e.g. d 1, d 1,2, d all).\n")
				_, _ = u.prompt("Enter to continue: ")
				continue
			}
			for _, idx := range indices {
				t := ts[idx-1]
				u.detachTab(config.Tab{Machine: t.Machine, Terminal: t.ID, Label: terminalLabel(t.Title)})
			}
			_ = u.save()
			continue
		}
		if cmd == "a" {
			if arg == "all" {
				for _, t := range ts {
					label := terminalLabel(t.Title)
					sessions.Add(u.Config, config.Tab{Machine: t.Machine, Terminal: t.ID, Label: label})
				}
				if len(u.Config.Tabs) > 0 {
					u.Config.Active = 0
				}
				return u.save()
			}
			indices := parseIndices(arg, len(ts))
			if len(indices) == 0 {
				u.print("Specify terminal number(s) to attach (e.g. a 1, a 1,2, a all).\n")
				_, _ = u.prompt("Enter to continue: ")
				continue
			}
			for _, idx := range indices {
				t := ts[idx-1]
				label := terminalLabel(t.Title)
				sessions.Add(u.Config, config.Tab{Machine: t.Machine, Terminal: t.ID, Label: label})
			}
			first := ts[indices[0]-1]
			for i, tab := range u.Config.Tabs {
				if tab.Machine == first.Machine && tab.Terminal == first.ID {
					u.Config.Active = i
					break
				}
			}
			return u.save()
		}
		indices := parseIndices(s, len(ts))
		if len(indices) > 0 {
			for _, idx := range indices {
				t := ts[idx-1]
				label := terminalLabel(t.Title)
				sessions.Add(u.Config, config.Tab{Machine: t.Machine, Terminal: t.ID, Label: label})
			}
			first := ts[indices[0]-1]
			for i, tab := range u.Config.Tabs {
				if tab.Machine == first.Machine && tab.Terminal == first.ID {
					u.Config.Active = i
					break
				}
			}
			return u.save()
		}
		u.print("Invalid choice.\n")
		_, _ = u.prompt("Enter to continue: ")
	}
}

// New terminals bypass the existing-terminal picker.
func (u *UI) newTerminal() error {
	u.clear()
	u.print("Offdesk · New terminal\n\n")
	machines, err := u.API.Machines(u.ctx)
	if err != nil {
		return err
	}
	if len(machines) == 0 {
		return errors.New("no machine is online")
	}
	m := machines[0]
	if len(machines) > 1 {
		for i, machine := range machines {
			u.print(fmt.Sprintf("  %d  %s\n", i+1, Safe(machine.Name)))
		}
		for {
			choice, err := u.prompt("\nMachine number (q to cancel): ")
			if err != nil {
				return err
			}
			choice = strings.TrimSpace(choice)
			if strings.EqualFold(choice, "q") {
				return errCancelled
			}
			n, err := strconv.Atoi(choice)
			if err == nil && n >= 1 && n <= len(machines) {
				m = machines[n-1]
				break
			}
			u.print("Choose a listed machine.\n")
		}
	}
	return u.createTerminal(m, m.Home, false)
}

func (u *UI) local(cmd byte) (quit bool, err error) {
	u.lastEOF = time.Time{}
	u.lastTmuxDetach = time.Time{}
	u.tmuxPrefix = false
	switch cmd {
	case 0:
		return u.commandMenu()
	case 'q':
		return true, nil
	case 'n':
		return false, u.newTerminal()
	case 'o': // Retain the old shortcut as an alias for the combined list.
		return false, u.tabMenu()
	case ']':
		sessions.Switch(u.Config, 1)
	case '[':
		sessions.Switch(u.Config, -1)
	case 'd':
		sessions.Detach(u.Config)
		if len(u.Config.Tabs) == 0 {
			return true, u.save()
		}
	case 'r':
		u.clear()
		s, e := u.prompt("Local tab label: ")
		if e != nil {
			return false, e
		}
		u.Config.Tabs[u.Config.Active].Label = Safe(s)
	case 'x':
		u.clear()
		t := u.Config.Tabs[u.Config.Active]
		if t.Socket == "default" || terminalLabel(t.Label) == "Default tmux" {
			u.print("Default tmux sessions are persistent and cannot be terminated.\nUse 'd' to detach the tab instead.\n\n")
			_, _ = u.prompt("Enter to return: ")
			return false, nil
		}
		u.print("Terminate " + Safe(terminalLabel(t.Label)) + "? This closes the Offdesk terminal and may stop its programs.\n")
		s, e := u.prompt("Type yes to terminate; Enter cancels: ")
		if e != nil {
			return false, e
		}
		if strings.TrimSpace(strings.ToLower(s)) != "yes" {
			return false, errCancelled
		}
		if e = u.API.Control(u.ctx, t.Machine, true); e != nil {
			return false, e
		}
		if e = u.API.Destroy(u.ctx, t.Machine, t.Terminal); e != nil {
			return false, e
		}
		sessions.Remove(u.Config)
		if len(u.Config.Tabs) == 0 {
			return true, u.save()
		}
	case 't':
		t := u.Config.Tabs[u.Config.Active]
		return false, u.API.Control(u.ctx, t.Machine, true)
	case 'l':
		t := u.Config.Tabs[u.Config.Active]
		return false, u.API.Control(u.ctx, t.Machine, false)
	case 'c':
		return false, u.controlMenu()
	case 'f':
		return false, u.fileMenu()
	case 's':
		return false, u.tabMenu()
	case 'h', '?', 'b':
		u.clear()
		u.print("Tabs:\n")
		for i, t := range u.Config.Tabs {
			u.print(fmt.Sprintf("%d: %s\n", i+1, Safe(t.Label)))
			if t.TmuxServer != "" {
				u.print("  tmux server: " + Safe(t.TmuxServer) + "\n")
			}
		}
		if len(u.Config.DetachedTmux) > 0 {
			u.print("\nDetached tmux servers:\n")
			for _, d := range u.Config.DetachedTmux {
				u.print("  " + Safe(d.Server) + "  [" + Safe(d.Machine) + "]\n")
			}
		}
		u.print("Prefix defaults to Ctrl+] (0x1d). Then:\nf files; n new; s terminals; [ / ] or 1..9 switch\nr rename; d detach tab; x terminate with confirmation\nq quit; ? help; prefix twice sends itself\nCtrl+C, Ctrl+B, Alt+M and other keys go to the remote terminal.\n")
		_, err = u.prompt("Enter to return: ")
		return false, err
	default:
		if cmd >= '1' && cmd <= '9' {
			i := int(cmd - '1')
			if i < len(u.Config.Tabs) {
				u.Config.Active = i
			}
		}
	}
	return false, u.save()
}
func (u *UI) resize(id string) error {
	w, h := u.dimensions()
	ctx, cancel := context.WithTimeout(u.ctx, 10*time.Second)
	defer cancel()
	return u.Client.Text(ctx, id, map[string]any{"type": "resize", "cols": w, "rows": h})
}

// A missing terminal is conclusive only when discovery succeeds and its
// machine is currently online. An offline machine must retain its saved tab.
func (u *UI) terminalState() (missing, online bool) {
	if u.Config.Active < 0 || u.Config.Active >= len(u.Config.Tabs) {
		return false, false
	}
	tab := u.Config.Tabs[u.Config.Active]
	ctx, cancel := context.WithTimeout(u.ctx, 5*time.Second)
	defer cancel()
	terminals, e := u.API.Terminals(ctx)
	if e != nil {
		return false, false
	}
	exists := false
	for _, t := range terminals {
		if t.ID == tab.Terminal && t.Machine == tab.Machine {
			exists = true
			break
		}
	}
	machines, e := u.API.Machines(ctx)
	if e != nil {
		return false, false
	}
	for _, m := range machines {
		if m.ID == tab.Machine {
			return !exists, true
		}
	}
	return false, false
}

// Only prune after both discovery calls succeed; offline machines are retained.
func (u *UI) reconcileTabs() error {
	if len(u.Config.Tabs) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(u.ctx, 8*time.Second)
	defer cancel()
	terminals, e := u.API.Terminals(ctx)
	if e != nil {
		return e
	}
	machines, e := u.API.Machines(ctx)
	if e != nil {
		return e
	}
	if sessions.Prune(u.Config, machines, terminals) > 0 {
		return u.save()
	}
	return nil
}
func (u *UI) observeTmuxInput(data []byte) {
	for _, v := range data {
		if u.tmuxPrefix {
			if v == 'd' {
				u.lastTmuxDetach = time.Now()
			}
			u.tmuxPrefix = false
		}
		if v == 2 {
			u.tmuxPrefix = true
		}
	}
}
func (u *UI) attach() (byte, error) {
	t := u.Config.Tabs[u.Config.Active]
	id, events := u.resumeID, u.resumeEvents
	resuming := id != ""
	u.resumeID = ""
	u.resumeEvents = nil
	var e error
	if !resuming {
		ctx, cancel := context.WithTimeout(u.ctx, 15*time.Second)
		id, events, e = u.Client.Open(ctx, transport.TerminalPath(t.Machine, t.Terminal, u.API.Device))
		cancel()
	}
	if e != nil {
		return 0, e
	}
	if u.recovering {
		// Reads can arrive during the new handshake and attach; they were
		// entered while delivery was uncertain and must never be replayed.
		for len(u.input) > 0 {
			<-u.input
		}
		u.actions = nil
		u.decoder = terminal.Decoder{Prefix: u.Config.Prefix}
		u.recovering = false
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = u.Client.CloseSocket(ctx, id)
	}()
	if !resuming {
		u.clear()
	}
	if e = u.resize(id); e != nil {
		return 0, e
	}
	firstInput := true
	for {
		if len(u.actions) > 0 {
			a := u.actions[0]
			u.actions = u.actions[1:]
			if a.Command != 0 {
				// Input following a local command may have been intended for its
				// menu. Never replay it into the remote program on return.
				u.actions = nil
				return a.Command, nil
			}
			if len(a.Data) > 0 {
				u.observeTmuxInput(a.Data)
				if strings.ContainsRune(string(a.Data), '\x04') {
					u.lastEOF = time.Now()
				} else {
					u.lastEOF = time.Time{}
				}
				ctx, cancel := context.WithTimeout(u.ctx, 10*time.Second)
				e = u.Client.Text(ctx, id, map[string]string{"type": "input", "data": string(a.Data)})
				cancel()
				if e != nil {
					return 0, e
				}
				// The Hub claims ownership before forwarding the first input.
				// Resize after it, without dropping or replaying that input.
				if firstInput {
					if e = u.resize(id); e != nil {
						return 0, e
					}
					firstInput = false
				}
			}
			continue
		}
		if u.decoder.Pending {
			u.decoder.Pending = false
			return 0, nil
		}
		select {
		case <-u.ctx.Done():
			return 'q', nil
		case e := <-u.readErr:
			return 'q', e
		case <-u.Client.Done():
			return 0, errors.New("connection interrupted")
		case <-u.size:
			if e = u.resize(id); e != nil {
				return 0, e
			}
		case b := <-u.input:
			u.actions = u.decoder.Feed(b)
		case m := <-events:
			switch m.Type {
			case "binary":
				u.streamed = true
				if _, e = u.output.Write(m.Binary); e != nil {
					return 'q', e
				}
			case "closed":
				return 0, errAttachClosed
			case "error":
				return 0, errors.New("Hub rejected terminal stream")
			case "text":
				var status struct {
					Type    string `json:"type"`
					Message string `json:"message"`
				}
				if json.Unmarshal([]byte(m.Data), &status) == nil && status.Type == "error" {
					return 0, fmt.Errorf("terminal error: %s", Safe(status.Message))
				}
			}
		}
	}
}
func (u *UI) Run(ctx context.Context) error {
	u.ctx = ctx
	u.output = os.Stdout
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		return errors.New("interactive mode requires a terminal")
	}
	state, e := term.MakeRaw(int(os.Stdin.Fd()))
	if e != nil {
		return e
	}
	defer term.Restore(int(os.Stdin.Fd()), state)
	fmt.Fprint(u.output, "\x1b[?1049h")
	defer fmt.Fprint(u.output, "\x1b[0m\x1b[r\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l")
	u.input = make(chan []byte, 32)
	u.readErr = make(chan error, 1)
	u.size = make(chan os.Signal, 1)
	signal.Notify(u.size, syscall.SIGWINCH)
	defer signal.Stop(u.size)
	u.decoder.Prefix = u.Config.Prefix
	go func() {
		for {
			b := make([]byte, 4096)
			n, e := os.Stdin.Read(b)
			if e != nil {
				u.readErr <- e
				return
			}
			select {
			case u.input <- b[:n]:
			case <-ctx.Done():
				return
			}
		}
	}()
	u.clear()
	u.print(fmt.Sprintf("Offdesk TUI\n\nPress Ctrl+%c for commands and tabs.\n", u.Config.Prefix+64))
	// Briefly show the local shortcut before fullscreen terminal output takes
	// over. Input is buffered, so early keystrokes remain available.
	startupHint := time.NewTimer(1200 * time.Millisecond)
	select {
	case <-startupHint.C:
	case <-ctx.Done():
		startupHint.Stop()
		return nil
	case err := <-u.readErr:
		startupHint.Stop()
		return err
	}
	defer func() {
		if u.Client != nil {
			u.Client.Close()
		}
	}()
	retryDelay := 2 * time.Second
	attachFailures := 0
	reconciled := false
	for {
		if u.Client == nil {
			u.print("Connecting directly to Hub…\n")
			if e = u.connect(); e != nil {
				u.recovering = true
				u.print(fmt.Sprintf("Connection failed; retrying in %s (q quits).\n", retryDelay))
				timer := time.NewTimer(retryDelay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return nil
				case err := <-u.readErr:
					timer.Stop()
					return err
				case b := <-u.input:
					timer.Stop()
					if string(b) == "q" {
						return nil
					}
				case <-timer.C:
				}
				for len(u.input) > 0 {
					<-u.input
				}
				retryDelay = min(retryDelay*2, 30*time.Second)
				continue
			}
			retryDelay = 2 * time.Second
		}
		if !reconciled {
			if u.reconcileTabs() == nil {
				reconciled = true
			}
		}
		if len(u.Config.Tabs) == 0 {
			if e = u.choose(true); e != nil {
				if e == io.EOF {
					return nil
				}
				select {
				case <-u.Client.Done():
					u.Client = nil
					continue
				default:
				}
				u.print("Error: " + Safe(e.Error()) + "\n")
				_, _ = u.prompt("Enter to return: ")
				continue
			}
		}
		if u.Config.Active < 0 || u.Config.Active >= len(u.Config.Tabs) {
			u.Config.Active = 0
		}
		cmd, e := u.attach()
		if e != nil {
			attachFailures++
			u.recovering = true
			u.actions = nil
			u.decoder = terminal.Decoder{Prefix: u.Config.Prefix}
			missing, online := u.terminalState()
			if !u.lastEOF.IsZero() && time.Since(u.lastEOF) < 5*time.Second {
				if online {
					if errors.Is(e, errAttachClosed) && u.Config.Active >= 0 && u.Config.Active < len(u.Config.Tabs) {
						sessions.RememberExit(u.Config, u.Config.Tabs[u.Config.Active], time.Now())
					}
					sessions.Remove(u.Config)
					if e = u.save(); e != nil {
						return e
					}
				}
				return nil
			}
			if missing {
				if !u.lastTmuxDetach.IsZero() && time.Since(u.lastTmuxDetach) < 10*time.Second && u.Config.Active >= 0 && u.Config.Active < len(u.Config.Tabs) {
					sessions.RememberDetached(u.Config, u.Config.Tabs[u.Config.Active])
				}
				u.lastTmuxDetach = time.Time{}
				sessions.Remove(u.Config)
				if e = u.save(); e != nil {
					return e
				}
				attachFailures = 0
				if len(u.Config.Tabs) == 0 && u.streamed {
					return nil
				}
				continue
			}
			u.clear()
			u.print("Disconnected: " + Safe(e.Error()) + "\n")
			u.Client.Close()
			u.Client = nil
			// Input is never replayed across an outage. q exits, d removes a stale tab.
			delayDuration := min(time.Duration(1<<min(attachFailures, 4))*time.Second, 30*time.Second)
			delay := time.NewTimer(delayDuration)
			select {
			case <-ctx.Done():
				delay.Stop()
				return nil
			case b := <-u.input:
				delay.Stop()
				if string(b) == "q" {
					return nil
				}
				if string(b) == "d" {
					sessions.Remove(u.Config)
					_ = u.save()
				}
			case <-delay.C:
			}
			for len(u.input) > 0 {
				<-u.input
			}
			continue
		}
		attachFailures = 0
		quit, e := u.local(cmd)
		if quit {
			return e
		}
		if e != nil {
			if errors.Is(e, errCancelled) {
				continue
			}
			u.clear()
			u.print("Error: " + Safe(e.Error()) + "\n")
			_, _ = u.prompt("Enter to return: ")
		}
	}
}
