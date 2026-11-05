package sessions

// TmuxStartup attaches the most recently used default-server session, or
// creates one if there are no sessions. Run a POSIX shell explicitly because
// the remote user's login shell may be Fish. Remove the outer Offdesk TMUX
// variable so tmux allows the nested attachment. No server options are changed.
func TmuxStartup() (command, server string, err error) {
	return `exec env -u TMUX sh -c 'if tmux -L default has-session 2>/dev/null; then exec tmux -L default attach-session; else exec tmux -L default new-session; fi'`, "", nil
}
