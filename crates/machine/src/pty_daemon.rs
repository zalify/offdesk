//! Pure-Rust persistent PTY daemon (`offdesk-node pty-daemon`) — experimental
//! drop-in replacement for `tmux` enabled via `OFFDESK_PTY_BACKEND=native`.
//!
//! Architecture:
//! - Runs as an independent `setsid` background process listening on a Unix
//!   domain socket (`~/.offdesk/pty-daemon.sock`, overridable with
//!   `OFFDESK_PTY_DAEMON_SOCK`). Because it lives in its own session and
//!   `offdesk-node.service` uses `KillMode=process`, restarting or upgrading
//!   `offdesk-node` never kills running shells or coding agents.
//! - Each session owns one real OS PTY (`portable-pty`) and an in-memory
//!   `vt100::Parser` (10,000 lines of scrollback).
//! - Live PTY bytes stream straight through to attached clients with zero
//!   double-VT transcoding (preserving truecolor, OSC 52, DEC 2026 sync output,
//!   Kitty keyboard protocol, and wide Unicode).
//! - Attaching to a session emits `screen.state_formatted()` from memory in
//!   < 1 ms (zero `fork`/`exec`), then streams live output.
//! - Screen capture (`CaptureScreen`) reads `screen.contents()` from memory in
//!   microseconds (zero `tmux capture-pane` subprocesses).

#[cfg(unix)]
mod unix_impl {
    use alacritty_terminal::event::{Event as AlacEvent, EventListener};
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line};
    use alacritty_terminal::term::cell::Flags as CellFlags;
    use alacritty_terminal::term::{Config as AlacConfig, Term, TermMode};
    use alacritty_terminal::vte::ansi::{self, Color as AnsiColor, NamedColor, Rgb};
    use base64::Engine as _;
    use bytes::Bytes;
    use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU16, AtomicU64, Ordering};
    use std::sync::{mpsc as std_mpsc, Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const SCROLLBACK_LEN: usize = 10_000;
    const SUBSCRIBER_QUEUE_CAP: usize = 256;

    // Raw binary frame tags for an upgraded Attach stream.
    const TAG_OUTPUT: u8 = 1;
    const TAG_DIED: u8 = 2;
    const TAG_COMPOSER_ACK: u8 = 3;

    const CMD_INPUT: u8 = 1;
    const CMD_RESIZE: u8 = 2;
    const CMD_REFRESH: u8 = 3;
    const CMD_COMPOSER: u8 = 4;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    pub struct DaemonSessionSnapshot {
        pub id: String,
        pub pid: Option<u32>,
        pub title: String,
        pub cwd: String,
        pub current_command: Option<String>,
        pub cols: u16,
        pub rows: u16,
        pub activity_ms: i64,
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "op", rename_all = "snake_case")]
    enum DaemonRequest {
        Ping,
        CreateSession {
            id: String,
            cwd: String,
            cols: u16,
            rows: u16,
            shell: String,
            env: Vec<(String, String)>,
        },
        DestroySession {
            id: String,
        },
        WriteInput {
            id: String,
            data_b64: String,
        },
        Resize {
            id: String,
            cols: u16,
            rows: u16,
        },
        ListSessions,
        CaptureScreen {
            id: String,
        },
        Attach {
            id: String,
            cols: u16,
            rows: u16,
        },
    }

    #[derive(Debug, Serialize, Deserialize)]
    #[serde(tag = "status", rename_all = "snake_case")]
    enum DaemonResponse {
        Pong { pid: u32 },
        Ok,
        Err { message: String },
        Sessions { sessions: Vec<DaemonSessionSnapshot> },
        Screen { contents: Option<String> },
        Attached,
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default()
    }

    /// Intercept standard terminal queries (DSR `ESC[6n`/`ESC[5n`, DA1
    /// `ESC[c`/`ESC[0c`, DA2 `ESC[>c`/`ESC[>0c`) and answer them locally in
    /// sub-millisecond time using the daemon's authoritative `vt100` cursor
    /// state — just like `tmux` does. Stripping the queries from the bytes
    /// forwarded to attached clients prevents duplicate replies and eliminates
    /// startup stalls in shells like `fish` and TUIs over high-RTT links or
    /// fresh split panes.
    /// Parse SGR mouse sequences (`ESC [ < Cb ; Cx ; Cy M/m`) from client input
    /// when the foreground app has NOT enabled mouse tracking. Returns
    /// `(remaining_non_mouse_bytes, wheel_line_delta)` where positive delta
    /// means scroll UP into history and negative delta means scroll DOWN toward live.
    fn extract_sgr_mouse_for_scrollback(input: &[u8]) -> (Vec<u8>, isize) {
        let mut passthrough = Vec::with_capacity(input.len());
        let mut wheel_delta: isize = 0;
        let mut i = 0;
        while i < input.len() {
            if i + 3 < input.len()
                && input[i] == 0x1b
                && input[i + 1] == b'['
                && input[i + 2] == b'<'
            {
                let mut end = i + 3;
                while end < input.len()
                    && (input[end].is_ascii_digit() || input[end] == b';')
                {
                    end += 1;
                }
                if end < input.len() && (input[end] == b'M' || input[end] == b'm') {
                    let params = std::str::from_utf8(&input[i + 3..end]).unwrap_or("");
                    if let Some(btn_str) = params.split(';').next() {
                        if let Ok(btn) = btn_str.parse::<u16>() {
                            // Strip modifier bits (Shift=4, Meta=8, Ctrl=16); wheel is 64 (up) / 65 (down).
                            let base = btn & !0x1c;
                            if input[end] == b'M' {
                                if base == 64 {
                                    wheel_delta += 3;
                                } else if base == 65 {
                                    wheel_delta -= 3;
                                }
                            }
                        }
                    }
                    i = end + 1;
                    continue;
                }
            }
            passthrough.push(input[i]);
            i += 1;
        }
        (passthrough, wheel_delta)
    }

    fn intercept_terminal_queries(output: &[u8], cursor: (u16, u16)) -> (Vec<u8>, Option<Vec<u8>>) {
        let mut forward = Vec::with_capacity(output.len());
        let mut reply = Vec::new();
        let mut i = 0;
        while i < output.len() {
            if i + 2 < output.len() && output[i] == 0x1b && output[i + 1] == b'[' {
                let rest = &output[i + 2..];
                if rest.starts_with(b"6n") {
                    let row = cursor.0.saturating_add(1);
                    let col = cursor.1.saturating_add(1);
                    reply.extend_from_slice(format!("\x1b[{row};{col}R").as_bytes());
                    i += 4;
                    continue;
                }
                if rest.starts_with(b"5n") {
                    reply.extend_from_slice(b"\x1b[0n");
                    i += 4;
                    continue;
                }
                if rest.starts_with(b"c") {
                    reply.extend_from_slice(b"\x1b[?62;22c");
                    i += 3;
                    continue;
                }
                if rest.starts_with(b"0c") {
                    reply.extend_from_slice(b"\x1b[?62;22c");
                    i += 4;
                    continue;
                }
                if rest.starts_with(b">c") {
                    reply.extend_from_slice(b"\x1b[>0;276;0c");
                    i += 4;
                    continue;
                }
                if rest.starts_with(b">0c") {
                    reply.extend_from_slice(b"\x1b[>0;276;0c");
                    i += 5;
                    continue;
                }
            }
            forward.push(output[i]);
            i += 1;
        }
        (forward, (!reply.is_empty()).then_some(reply))
    }

    pub fn default_socket_path() -> PathBuf {
        if let Ok(path) = std::env::var("OFFDESK_PTY_DAEMON_SOCK") {
            if !path.trim().is_empty() {
                return PathBuf::from(path);
            }
        }
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
        home.join(".offdesk").join("pty-daemon.sock")
    }

    fn write_json_frame<W: Write, T: Serialize>(w: &mut W, msg: &T) -> std::io::Result<()> {
        let payload = serde_json::to_vec(msg)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let len = payload.len() as u32;
        w.write_all(&len.to_be_bytes())?;
        w.write_all(&payload)?;
        w.flush()
    }

    fn read_json_frame<R: Read, T: for<'de> Deserialize<'de>>(r: &mut R) -> std::io::Result<T> {
        let mut len_buf = [0u8; 4];
        r.read_exact(&mut len_buf)?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 32 * 1024 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "frame too large",
            ));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf)?;
        serde_json::from_slice(&buf)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    fn write_bin_frame<W: Write>(w: &mut W, tag: u8, payload: &[u8]) -> std::io::Result<()> {
        let mut header = [0u8; 5];
        header[0] = tag;
        header[1..5].copy_from_slice(&(payload.len() as u32).to_be_bytes());
        w.write_all(&header)?;
        if !payload.is_empty() {
            w.write_all(payload)?;
        }
        w.flush()
    }

    fn read_bin_frame<R: Read>(r: &mut R) -> std::io::Result<(u8, Vec<u8>)> {
        let mut header = [0u8; 5];
        r.read_exact(&mut header)?;
        let tag = header[0];
        let len = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if len > 32 * 1024 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "binary frame too large",
            ));
        }
        let mut buf = vec![0u8; len];
        if len > 0 {
            r.read_exact(&mut buf)?;
        }
        Ok((tag, buf))
    }

    #[derive(Clone, Default)]
    struct DaemonEventSink {
        title: Arc<Mutex<String>>,
    }

    impl EventListener for DaemonEventSink {
        fn send_event(&self, event: AlacEvent) {
            match event {
                AlacEvent::Title(t) => {
                    if let Ok(mut guard) = self.title.lock() {
                        *guard = t;
                    }
                }
                AlacEvent::ResetTitle => {
                    if let Ok(mut guard) = self.title.lock() {
                        guard.clear();
                    }
                }
                _ => {}
            }
        }
    }

    struct DaemonDimensions {
        cols: usize,
        rows: usize,
    }

    impl Dimensions for DaemonDimensions {
        fn total_lines(&self) -> usize {
            self.rows
        }
        fn screen_lines(&self) -> usize {
            self.rows
        }
        fn columns(&self) -> usize {
            self.cols
        }
    }

    /// Production VT100/xterm emulator backed by `alacritty_terminal` (10,000-line
    /// scrollback that properly preserves lines scrolled out under DECSTBM scroll
    /// regions and accurately tracks CJK wide characters and 24-bit color).
    struct DaemonTerm {
        term: Term<DaemonEventSink>,
        processor: ansi::Processor,
        sink: DaemonEventSink,
        cols: u16,
        rows: u16,
    }

    impl DaemonTerm {
        fn new(rows: u16, cols: u16, scrollback_len: usize) -> Self {
            let cols = cols.max(2);
            let rows = rows.max(2);
            let sink = DaemonEventSink::default();
            let config = AlacConfig {
                scrolling_history: scrollback_len,
                ..AlacConfig::default()
            };
            let dims = DaemonDimensions {
                cols: cols as usize,
                rows: rows as usize,
            };
            let term = Term::new(config, &dims, sink.clone());
            Self {
                term,
                processor: ansi::Processor::new(),
                sink,
                cols,
                rows,
            }
        }

        fn process(&mut self, bytes: &[u8]) {
            self.processor.advance(&mut self.term, bytes);
        }

        fn set_size(&mut self, rows: u16, cols: u16) {
            let cols = cols.max(2);
            let rows = rows.max(2);
            if self.cols == cols && self.rows == rows {
                return;
            }
            self.cols = cols;
            self.rows = rows;
            self.term.resize(DaemonDimensions {
                cols: cols as usize,
                rows: rows as usize,
            });
        }

        fn title(&self) -> String {
            self.sink
                .title
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default()
        }

        fn cursor_position(&self) -> (u16, u16) {
            let pt = self.term.grid().cursor.point;
            let row = pt.line.0.clamp(0, self.rows.saturating_sub(1) as i32) as u16;
            let col = pt.column.0.min(self.cols.saturating_sub(1) as usize) as u16;
            (row, col)
        }

        fn app_wants_mouse(&self) -> bool {
            self.term.mode().intersects(TermMode::MOUSE_MODE)
        }

        fn capture_contents(&self) -> String {
            let grid = self.term.grid();
            let mut out = String::new();
            for row in 0..self.rows as usize {
                let mut line_str = String::new();
                for col in 0..self.cols as usize {
                    let cell = &grid[Line(row as i32)][Column(col)];
                    if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                        continue;
                    }
                    line_str.push(cell.c);
                }
                let trimmed = line_str.trim_end();
                if row > 0 {
                    out.push('\n');
                }
                out.push_str(trimmed);
            }
            out
        }

        fn render_ansi_at_scrollback(&self, requested_offset: usize) -> (Vec<u8>, usize) {
            use std::fmt::Write as _;

            let grid = self.term.grid();
            let history_size = grid.history_size();
            let actual_offset = requested_offset.min(history_size);
            let mode = *self.term.mode();
            let app_wants_mouse = mode.intersects(TermMode::MOUSE_MODE);

            let mut out = String::with_capacity(self.rows as usize * self.cols as usize * 2);
            // Begin DEC 2026 synchronized output + full SGR/DECSTBM/viewport reset.
            out.push_str("\x1b[?2026h\x1b[0m\x1b[r\x1b[2J\x1b[H");

            let mut cur_fg = AnsiColor::Named(NamedColor::Foreground);
            let mut cur_bg = AnsiColor::Named(NamedColor::Background);
            let mut cur_flags = CellFlags::empty();

            for vis_row in 0..self.rows as usize {
                let line = Line(vis_row as i32 - actual_offset as i32);
                // Find the last non-default cell on this row to avoid emitting
                // hundreds of trailing blank cells.
                let mut last_used: Option<usize> = None;
                for col in (0..self.cols as usize).rev() {
                    let cell = &grid[line][Column(col)];
                    let has_bg = cell.bg != AnsiColor::Named(NamedColor::Background);
                    let has_inv = cell.flags.contains(CellFlags::INVERSE);
                    let has_char = cell.c != ' ' && cell.c != '\0';
                    if has_char || has_bg || has_inv {
                        last_used = Some(col);
                        break;
                    }
                }
                let Some(end_col) = last_used else {
                    continue;
                };

                // Explicitly position cursor at column 1 of this row so full-width
                // CJK rows can never wrap-drift into the next row.
                let _ = write!(out, "\x1b[{};1H", vis_row + 1);

                for col in 0..=end_col {
                    let cell = &grid[line][Column(col)];
                    if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                        continue;
                    }
                    let style_flags = cell.flags
                        & (CellFlags::BOLD
                            | CellFlags::DIM
                            | CellFlags::ITALIC
                            | CellFlags::UNDERLINE
                            | CellFlags::INVERSE
                            | CellFlags::STRIKEOUT);
                    if cell.fg != cur_fg || cell.bg != cur_bg || style_flags != cur_flags {
                        write_sgr(&mut out, cell.fg, cell.bg, style_flags);
                        cur_fg = cell.fg;
                        cur_bg = cell.bg;
                        cur_flags = style_flags;
                    }
                    out.push(if cell.c == '\0' { ' ' } else { cell.c });
                    if let Some(zw) = cell.zerowidth() {
                        for &z in zw {
                            out.push(z);
                        }
                    }
                }
            }

            out.push_str("\x1b[0m");

            if actual_offset > 0 {
                // Hide live cursor while viewing scrollback history.
                out.push_str("\x1b[?25l");
            } else {
                let (crow, ccol) = self.cursor_position();
                let _ = write!(out, "\x1b[{};{}H", crow + 1, ccol + 1);
                if mode.contains(TermMode::SHOW_CURSOR) {
                    out.push_str("\x1b[?25h");
                } else {
                    out.push_str("\x1b[?25l");
                }
                if mode.contains(TermMode::BRACKETED_PASTE) {
                    out.push_str("\x1b[?2004h");
                }
                if mode.contains(TermMode::APP_CURSOR) {
                    out.push_str("\x1b[?1h");
                }
            }

            // Keep SGR mouse reporting enabled on the client even when the app
            // doesn't request it (e.g., agy, fish, bash) so wheel/touch scroll
            // drives daemon-side scrollback — matching tmux's mouse mode.
            if !app_wants_mouse {
                out.push_str("\x1b[?1000h\x1b[?1006h");
            }
            out.push_str("\x1b[?2026l");

            (out.into_bytes(), actual_offset)
        }
    }

    fn write_sgr(out: &mut String, fg: AnsiColor, bg: AnsiColor, flags: CellFlags) {
        use std::fmt::Write as _;
        out.push_str("\x1b[0");
        if flags.contains(CellFlags::BOLD) {
            out.push_str(";1");
        }
        if flags.contains(CellFlags::DIM) {
            out.push_str(";2");
        }
        if flags.contains(CellFlags::ITALIC) {
            out.push_str(";3");
        }
        if flags.contains(CellFlags::UNDERLINE) {
            out.push_str(";4");
        }
        if flags.contains(CellFlags::INVERSE) {
            out.push_str(";7");
        }
        if flags.contains(CellFlags::STRIKEOUT) {
            out.push_str(";9");
        }
        match fg {
            AnsiColor::Named(NamedColor::Foreground | NamedColor::BrightForeground) => {}
            AnsiColor::Named(n) => {
                if let Some(code) = named_color_sgr(n, false) {
                    let _ = write!(out, ";{code}");
                }
            }
            AnsiColor::Indexed(idx) => {
                let _ = write!(out, ";38;5;{idx}");
            }
            AnsiColor::Spec(Rgb { r, g, b }) => {
                let _ = write!(out, ";38;2;{r};{g};{b}");
            }
        }
        match bg {
            AnsiColor::Named(NamedColor::Background) => {}
            AnsiColor::Named(n) => {
                if let Some(code) = named_color_sgr(n, true) {
                    let _ = write!(out, ";{code}");
                }
            }
            AnsiColor::Indexed(idx) => {
                let _ = write!(out, ";48;5;{idx}");
            }
            AnsiColor::Spec(Rgb { r, g, b }) => {
                let _ = write!(out, ";48;2;{r};{g};{b}");
            }
        }
        out.push('m');
    }

    fn named_color_sgr(c: NamedColor, is_bg: bool) -> Option<u8> {
        let base = match c {
            NamedColor::Black => 30,
            NamedColor::Red => 31,
            NamedColor::Green => 32,
            NamedColor::Yellow => 33,
            NamedColor::Blue => 34,
            NamedColor::Magenta => 35,
            NamedColor::Cyan => 36,
            NamedColor::White => 37,
            NamedColor::BrightBlack | NamedColor::DimBlack => 90,
            NamedColor::BrightRed | NamedColor::DimRed => 91,
            NamedColor::BrightGreen | NamedColor::DimGreen => 92,
            NamedColor::BrightYellow | NamedColor::DimYellow => 93,
            NamedColor::BrightBlue | NamedColor::DimBlue => 94,
            NamedColor::BrightMagenta | NamedColor::DimMagenta => 95,
            NamedColor::BrightCyan | NamedColor::DimCyan => 96,
            NamedColor::BrightWhite | NamedColor::DimWhite => 97,
            _ => return None,
        };
        Some(if is_bg { base + 10 } else { base })
    }

    struct LiveSession {
        id: String,
        initial_cwd: String,
        pid: Option<u32>,
        master: Mutex<Box<dyn MasterPty + Send>>,
        writer: Mutex<Box<dyn Write + Send>>,
        child: Mutex<Box<dyn Child + Send + Sync>>,
        parser: Mutex<DaemonTerm>,
        cols: AtomicU16,
        rows: AtomicU16,
        activity_ms: AtomicI64,
        alive: AtomicBool,
        subscribers: Mutex<HashMap<u64, std_mpsc::SyncSender<Bytes>>>,
    }

    impl LiveSession {
        fn snapshot(&self) -> DaemonSessionSnapshot {
            let title = self
                .parser
                .lock()
                .map(|p| p.title())
                .unwrap_or_default();
            let cwd = self
                .pid
                .and_then(read_proc_cwd)
                .unwrap_or_else(|| self.initial_cwd.clone());
            let current_command = self.pid.and_then(read_foreground_command);
            DaemonSessionSnapshot {
                id: self.id.clone(),
                pid: self.pid,
                title,
                cwd,
                current_command,
                cols: self.cols.load(Ordering::Relaxed),
                rows: self.rows.load(Ordering::Relaxed),
                activity_ms: self.activity_ms.load(Ordering::Relaxed),
            }
        }

        fn state_formatted_at_scrollback(&self, offset: usize) -> (Vec<u8>, usize) {
            let Ok(parser) = self.parser.lock() else {
                return (Vec::new(), 0);
            };
            parser.render_ansi_at_scrollback(offset)
        }

        fn state_formatted(&self) -> Vec<u8> {
            self.state_formatted_at_scrollback(0).0
        }

        fn app_wants_mouse(&self) -> bool {
            self.parser
                .lock()
                .map(|p| p.app_wants_mouse())
                .unwrap_or(false)
        }

        fn capture_contents(&self) -> String {
            self.parser
                .lock()
                .map(|p| p.capture_contents())
                .unwrap_or_default()
        }

        fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
            let cols = cols.max(1);
            let rows = rows.max(1);
            if let Ok(master) = self.master.lock() {
                master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| format!("pty resize failed: {}", e))?;
            }
            if let Ok(mut parser) = self.parser.lock() {
                parser.set_size(rows, cols);
            }
            self.cols.store(cols, Ordering::Relaxed);
            self.rows.store(rows, Ordering::Relaxed);
            Ok(())
        }

        fn write_all(&self, data: &[u8]) -> Result<(), String> {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| "writer lock poisoned".to_string())?;
            writer
                .write_all(data)
                .and_then(|_| writer.flush())
                .map_err(|e| format!("pty write failed: {}", e))
        }

        fn kill(&self) {
            self.alive.store(false, Ordering::SeqCst);
            if let Ok(mut child) = self.child.lock() {
                let _ = child.kill();
            }
            if let Ok(mut subs) = self.subscribers.lock() {
                subs.clear();
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn read_proc_cwd(pid: u32) -> Option<String> {
        std::fs::read_link(format!("/proc/{}/cwd", pid))
            .ok()
            .and_then(|p| p.to_str().map(String::from))
    }

    #[cfg(not(target_os = "linux"))]
    fn read_proc_cwd(_pid: u32) -> Option<String> {
        None
    }

    #[cfg(target_os = "linux")]
    fn read_foreground_command(shell_pid: u32) -> Option<String> {
        // Read tpgid (field 8) from /proc/<pid>/stat.
        let stat = std::fs::read_to_string(format!("/proc/{}/stat", shell_pid)).ok()?;
        let after_comm = stat.rsplit_once(')')?.1;
        let fields: Vec<&str> = after_comm.split_whitespace().collect();
        // After ')', field 0 is state (3), field 5 is tpgid (8).
        let tpgid: u32 = fields.get(5)?.parse().ok()?;
        let target_pid = if tpgid > 0 { tpgid } else { shell_pid };
        let comm = std::fs::read_to_string(format!("/proc/{}/comm", target_pid)).ok()?;
        let cmd = comm.trim().to_string();
        if cmd.is_empty() {
            None
        } else {
            Some(cmd)
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn read_foreground_command(_shell_pid: u32) -> Option<String> {
        None
    }

    struct DaemonState {
        sessions: Mutex<HashMap<String, Arc<LiveSession>>>,
        next_sub_id: AtomicU64,
    }

    impl DaemonState {
        fn new() -> Self {
            Self {
                sessions: Mutex::new(HashMap::new()),
                next_sub_id: AtomicU64::new(1),
            }
        }

        fn create_session(
            self: &Arc<Self>,
            id: String,
            cwd: String,
            cols: u16,
            rows: u16,
            shell: String,
            env: Vec<(String, String)>,
        ) -> Result<(), String> {
            let cols = cols.max(1);
            let rows = rows.max(1);
            let pty_system = native_pty_system();
            let pair = pty_system
                .openpty(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("openpty failed: {}", e))?;

            let mut cmd = CommandBuilder::new(&shell);
            cmd.cwd(&cwd);
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            cmd.env("OFFDESK_SESSION", &id);
            for (k, v) in env {
                cmd.env(k, v);
            }

            let child = pair
                .slave
                .spawn_command(cmd)
                .map_err(|e| format!("spawn shell '{}' failed: {}", shell, e))?;
            let pid = child.process_id();
            drop(pair.slave);

            let reader = pair
                .master
                .try_clone_reader()
                .map_err(|e| format!("clone pty reader failed: {}", e))?;
            let writer = pair
                .master
                .take_writer()
                .map_err(|e| format!("take pty writer failed: {}", e))?;

            let session = Arc::new(LiveSession {
                id: id.clone(),
                initial_cwd: cwd,
                pid,
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
                parser: Mutex::new(DaemonTerm::new(rows, cols, SCROLLBACK_LEN)),
                cols: AtomicU16::new(cols),
                rows: AtomicU16::new(rows),
                activity_ms: AtomicI64::new(now_ms()),
                alive: AtomicBool::new(true),
                subscribers: Mutex::new(HashMap::new()),
            });

            {
                let mut guard = self
                    .sessions
                    .lock()
                    .map_err(|_| "sessions lock poisoned".to_string())?;
                if let Some(old) = guard.insert(id.clone(), Arc::clone(&session)) {
                    old.kill();
                }
            }

            // Dedicated blocking reader thread for this PTY.
            let state_weak = Arc::downgrade(self);
            let session_ref = Arc::clone(&session);
            let session_id = id;
            std::thread::spawn(move || {
                let mut reader = reader;
                let mut buf = [0u8; 16_384];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let slice = &buf[..n];
                            let cursor_pos = if let Ok(mut parser) = session_ref.parser.lock() {
                                parser.process(slice);
                                Some(parser.cursor_position())
                            } else {
                                None
                            };
                            session_ref.activity_ms.store(now_ms(), Ordering::Relaxed);
                            let (forward_bytes, query_reply) =
                                intercept_terminal_queries(slice, cursor_pos.unwrap_or((0, 0)));
                            if let Some(reply) = query_reply {
                                let _ = session_ref.write_all(&reply);
                            }
                            if !forward_bytes.is_empty() {
                                let chunk = Bytes::from(forward_bytes);
                                if let Ok(mut subs) = session_ref.subscribers.lock() {
                                    let mut dead = Vec::new();
                                    for (&sub_id, tx) in subs.iter() {
                                        match tx.try_send(chunk.clone()) {
                                            Ok(()) => {}
                                            Err(std_mpsc::TrySendError::Full(_)) => {
                                                // Drop chunk for lagging subscriber rather than stalling PTY.
                                            }
                                            Err(std_mpsc::TrySendError::Disconnected(_)) => {
                                                dead.push(sub_id);
                                            }
                                        }
                                    }
                                    for sub_id in dead {
                                        subs.remove(&sub_id);
                                    }
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                session_ref.alive.store(false, Ordering::SeqCst);
                if let Ok(mut subs) = session_ref.subscribers.lock() {
                    subs.clear();
                }
                if let Some(state) = state_weak.upgrade() {
                    if let Ok(mut guard) = state.sessions.lock() {
                        if guard
                            .get(&session_id)
                            .is_some_and(|s| Arc::ptr_eq(s, &session_ref))
                        {
                            guard.remove(&session_id);
                        }
                    }
                }
            });

            Ok(())
        }
    }

    fn handle_connection(state: Arc<DaemonState>, mut stream: UnixStream) {
        let req: DaemonRequest = match read_json_frame(&mut stream) {
            Ok(r) => r,
            Err(_) => return,
        };

        match req {
            DaemonRequest::Ping => {
                let _ = write_json_frame(
                    &mut stream,
                    &DaemonResponse::Pong {
                        pid: std::process::id(),
                    },
                );
            }
            DaemonRequest::CreateSession {
                id,
                cwd,
                cols,
                rows,
                shell,
                env,
            } => {
                let resp = match state.create_session(id, cwd, cols, rows, shell, env) {
                    Ok(()) => DaemonResponse::Ok,
                    Err(message) => DaemonResponse::Err { message },
                };
                let _ = write_json_frame(&mut stream, &resp);
            }
            DaemonRequest::DestroySession { id } => {
                let removed = state
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&id));
                let resp = if let Some(session) = removed {
                    session.kill();
                    DaemonResponse::Ok
                } else {
                    DaemonResponse::Err {
                        message: format!("session {} not found", id),
                    }
                };
                let _ = write_json_frame(&mut stream, &resp);
            }
            DaemonRequest::WriteInput { id, data_b64 } => {
                let resp = match base64::engine::general_purpose::STANDARD.decode(&data_b64) {
                    Ok(bytes) => {
                        let session = state
                            .sessions
                            .lock()
                            .ok()
                            .and_then(|map| map.get(&id).cloned());
                        match session {
                            Some(s) => match s.write_all(&bytes) {
                                Ok(()) => DaemonResponse::Ok,
                                Err(message) => DaemonResponse::Err { message },
                            },
                            None => DaemonResponse::Err {
                                message: format!("session {} not found", id),
                            },
                        }
                    }
                    Err(e) => DaemonResponse::Err {
                        message: format!("invalid base64: {}", e),
                    },
                };
                let _ = write_json_frame(&mut stream, &resp);
            }
            DaemonRequest::Resize { id, cols, rows } => {
                let session = state
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&id).cloned());
                let resp = match session {
                    Some(s) => match s.resize(cols, rows) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(message) => DaemonResponse::Err { message },
                    },
                    None => DaemonResponse::Err {
                        message: format!("session {} not found", id),
                    },
                };
                let _ = write_json_frame(&mut stream, &resp);
            }
            DaemonRequest::ListSessions => {
                let sessions: Vec<DaemonSessionSnapshot> = state
                    .sessions
                    .lock()
                    .map(|map| {
                        map.values()
                            .filter(|s| s.alive.load(Ordering::Relaxed))
                            .map(|s| s.snapshot())
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = write_json_frame(&mut stream, &DaemonResponse::Sessions { sessions });
            }
            DaemonRequest::CaptureScreen { id } => {
                let contents = state
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&id).cloned())
                    .map(|s| s.capture_contents());
                let _ = write_json_frame(&mut stream, &DaemonResponse::Screen { contents });
            }
            DaemonRequest::Attach { id, cols, rows } => {
                let session = state
                    .sessions
                    .lock()
                    .ok()
                    .and_then(|map| map.get(&id).cloned());
                let Some(session) = session else {
                    let _ = write_json_frame(
                        &mut stream,
                        &DaemonResponse::Err {
                            message: format!("session {} not found", id),
                        },
                    );
                    return;
                };
                if !session.alive.load(Ordering::Relaxed) {
                    let _ = write_json_frame(
                        &mut stream,
                        &DaemonResponse::Err {
                            message: format!("session {} already exited", id),
                        },
                    );
                    return;
                }

                // Subscribe BEFORE sending initial snapshot so no output bytes
                // are missed between snapshot capture and live streaming.
                let sub_id = state.next_sub_id.fetch_add(1, Ordering::Relaxed);
                let (tx, rx) = std_mpsc::sync_channel::<Bytes>(SUBSCRIBER_QUEUE_CAP);
                if let Ok(mut subs) = session.subscribers.lock() {
                    subs.insert(sub_id, tx);
                }

                // Resize if requested dimensions differ from current session size.
                if cols > 0
                    && rows > 0
                    && (session.cols.load(Ordering::Relaxed) != cols
                        || session.rows.load(Ordering::Relaxed) != rows)
                {
                    let _ = session.resize(cols, rows);
                }

                if write_json_frame(&mut stream, &DaemonResponse::Attached).is_err() {
                    if let Ok(mut subs) = session.subscribers.lock() {
                        subs.remove(&sub_id);
                    }
                    return;
                }

                let Ok(mut read_stream) = stream.try_clone() else {
                    if let Ok(mut subs) = session.subscribers.lock() {
                        subs.remove(&sub_id);
                    }
                    return;
                };

                let write_stream = Arc::new(Mutex::new(stream));

                // Emit initial formatted screen state (< 1ms from memory).
                let initial = session.state_formatted();
                if !initial.is_empty() {
                    if let Ok(mut ws) = write_stream.lock() {
                        if write_bin_frame(&mut *ws, TAG_OUTPUT, &initial).is_err() {
                            if let Ok(mut subs) = session.subscribers.lock() {
                                subs.remove(&sub_id);
                            }
                            return;
                        }
                    }
                }

                // Spawn inbound command reader thread (Input / Resize / Refresh / Composer).
                let session_for_in = Arc::clone(&session);
                let ws_for_in = Arc::clone(&write_stream);
                let scrollback_offset = Arc::new(std::sync::atomic::AtomicUsize::new(0));
                let sb_for_in = Arc::clone(&scrollback_offset);
                let in_handle = std::thread::spawn(move || {
                    while let Ok((tag, payload)) = read_bin_frame(&mut read_stream) {
                        match tag {
                            CMD_INPUT => {
                                if session_for_in.app_wants_mouse() {
                                    // Foreground app (e.g. Claude Code, vim) owns mouse tracking.
                                    if sb_for_in.swap(0, Ordering::Relaxed) > 0 {
                                        let snap = session_for_in.state_formatted();
                                        if let Ok(mut ws) = ws_for_in.lock() {
                                            let _ = write_bin_frame(&mut *ws, TAG_OUTPUT, &snap);
                                        }
                                    }
                                    if session_for_in.write_all(&payload).is_err() {
                                        break;
                                    }
                                } else {
                                    let (passthrough, wheel_delta) =
                                        extract_sgr_mouse_for_scrollback(&payload);
                                    if wheel_delta != 0 {
                                        let cur = sb_for_in.load(Ordering::Relaxed);
                                        let target = if wheel_delta > 0 {
                                            cur.saturating_add(wheel_delta as usize)
                                        } else {
                                            cur.saturating_sub(wheel_delta.unsigned_abs())
                                        };
                                        let (snap, actual) =
                                            session_for_in.state_formatted_at_scrollback(target);
                                        sb_for_in.store(actual, Ordering::Relaxed);
                                        if let Ok(mut ws) = ws_for_in.lock() {
                                            if write_bin_frame(&mut *ws, TAG_OUTPUT, &snap).is_err()
                                            {
                                                break;
                                            }
                                        }
                                    }
                                    if !passthrough.is_empty() {
                                        // Any real keystroke snaps back to live bottom before typing.
                                        if sb_for_in.swap(0, Ordering::Relaxed) > 0 {
                                            let snap = session_for_in.state_formatted();
                                            if let Ok(mut ws) = ws_for_in.lock() {
                                                let _ =
                                                    write_bin_frame(&mut *ws, TAG_OUTPUT, &snap);
                                            }
                                        }
                                        if session_for_in.write_all(&passthrough).is_err() {
                                            break;
                                        }
                                    }
                                }
                            }
                            CMD_RESIZE if payload.len() >= 4 => {
                                let c = u16::from_be_bytes([payload[0], payload[1]]);
                                let r = u16::from_be_bytes([payload[2], payload[3]]);
                                let _ = session_for_in.resize(c, r);
                            }
                            CMD_REFRESH => {
                                let cur = sb_for_in.load(Ordering::Relaxed);
                                let (snap, actual) =
                                    session_for_in.state_formatted_at_scrollback(cur);
                                sb_for_in.store(actual, Ordering::Relaxed);
                                if let Ok(mut ws) = ws_for_in.lock() {
                                    if write_bin_frame(&mut *ws, TAG_OUTPUT, &snap).is_err() {
                                        break;
                                    }
                                }
                            }
                            CMD_COMPOSER => {
                                if sb_for_in.swap(0, Ordering::Relaxed) > 0 {
                                    let snap = session_for_in.state_formatted();
                                    if let Ok(mut ws) = ws_for_in.lock() {
                                        let _ = write_bin_frame(&mut *ws, TAG_OUTPUT, &snap);
                                    }
                                }
                                let pasted = session_for_in.write_all(&payload).is_ok();
                                let ok = if pasted {
                                    std::thread::sleep(Duration::from_millis(100));
                                    session_for_in.write_all(b"\r").is_ok()
                                } else {
                                    false
                                };
                                if let Ok(mut ws) = ws_for_in.lock() {
                                    let _ = write_bin_frame(
                                        &mut *ws,
                                        TAG_COMPOSER_ACK,
                                        &[u8::from(ok)],
                                    );
                                }
                            }
                            _ => {}
                        }
                    }
                    // Client disconnected: remove subscriber so outbound loop ends.
                    if let Ok(mut subs) = session_for_in.subscribers.lock() {
                        subs.remove(&sub_id);
                    }
                });

                // Outbound loop: live PTY output -> binary frames.
                // Pause live output streaming while this client is scrolled up
                // into scrollback (just like tmux copy-mode).
                while let Ok(chunk) = rx.recv() {
                    if scrollback_offset.load(Ordering::Relaxed) > 0 {
                        continue;
                    }
                    let send_ok = write_stream
                        .lock()
                        .map(|mut ws| write_bin_frame(&mut *ws, TAG_OUTPUT, &chunk).is_ok())
                        .unwrap_or(false);
                    if !send_ok {
                        break;
                    }
                }

                if let Ok(mut subs) = session.subscribers.lock() {
                    subs.remove(&sub_id);
                }
                if !session.alive.load(Ordering::Relaxed) {
                    if let Ok(mut ws) = write_stream.lock() {
                        let _ = write_bin_frame(&mut *ws, TAG_DIED, &[]);
                    }
                }
                let _ = write_stream
                    .lock()
                    .map(|ws| ws.shutdown(std::net::Shutdown::Both));
                let _ = in_handle.join();
            }
        }
    }

    /// Run the standalone PTY daemon server loop on `socket_path`.
    pub fn run_server(socket_path: &Path) -> Result<(), String> {
        if let Some(parent) = socket_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create socket dir failed: {}", e))?;
        }
        // Remove stale socket file if no daemon is listening on it.
        if socket_path.exists() {
            if ping_at(socket_path).is_ok() {
                return Ok(());
            }
            let _ = std::fs::remove_file(socket_path);
        }

        let listener = UnixListener::bind(socket_path)
            .map_err(|e| format!("bind {:?} failed: {}", socket_path, e))?;

        // Restrict socket permissions to owner (0600).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ =
                std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600));
        }

        tracing::info!("offdesk pty-daemon listening on {:?}", socket_path);
        let state = Arc::new(DaemonState::new());

        for incoming in listener.incoming() {
            match incoming {
                Ok(stream) => {
                    let state_clone = Arc::clone(&state);
                    std::thread::spawn(move || handle_connection(state_clone, stream));
                }
                Err(e) => {
                    tracing::warn!("pty-daemon accept error: {}", e);
                }
            }
        }
        Ok(())
    }

    fn rpc(socket_path: &Path, req: &DaemonRequest) -> Result<DaemonResponse, String> {
        let mut stream = UnixStream::connect(socket_path)
            .map_err(|e| format!("connect pty-daemon {:?} failed: {}", socket_path, e))?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        write_json_frame(&mut stream, req).map_err(|e| format!("rpc write failed: {}", e))?;
        read_json_frame(&mut stream).map_err(|e| format!("rpc read failed: {}", e))
    }

    pub fn ping_at(socket_path: &Path) -> Result<u32, String> {
        match rpc(socket_path, &DaemonRequest::Ping)? {
            DaemonResponse::Pong { pid } => Ok(pid),
            other => Err(format!("unexpected ping response: {:?}", other)),
        }
    }

    pub fn ensure_daemon_running() -> Result<PathBuf, String> {
        let sock = default_socket_path();
        if ping_at(&sock).is_ok() {
            return Ok(sock);
        }
        let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {}", e))?;
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("pty-daemon")
            .arg("--socket")
            .arg(&sock)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Detach into its own session so restarting offdesk-node never kills the daemon.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn()
            .map_err(|e| format!("spawn pty-daemon failed: {}", e))?;

        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(50));
            if ping_at(&sock).is_ok() {
                return Ok(sock);
            }
        }
        Err(format!("pty-daemon did not become ready at {:?}", sock))
    }

    pub fn create_session(
        id: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
        shell: &str,
        env: Vec<(String, String)>,
    ) -> Result<(), String> {
        let sock = ensure_daemon_running()?;
        match rpc(
            &sock,
            &DaemonRequest::CreateSession {
                id: id.to_string(),
                cwd: cwd.to_string(),
                cols,
                rows,
                shell: shell.to_string(),
                env,
            },
        )? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Err { message } => Err(message),
            other => Err(format!("unexpected response: {:?}", other)),
        }
    }

    pub fn destroy_session(id: &str) -> Result<(), String> {
        let sock = default_socket_path();
        match rpc(&sock, &DaemonRequest::DestroySession { id: id.to_string() })? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Err { message } => Err(message),
            other => Err(format!("unexpected response: {:?}", other)),
        }
    }

    pub fn write_input(id: &str, data: &[u8]) -> Result<(), String> {
        let sock = default_socket_path();
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(data);
        match rpc(
            &sock,
            &DaemonRequest::WriteInput {
                id: id.to_string(),
                data_b64,
            },
        )? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Err { message } => Err(message),
            other => Err(format!("unexpected response: {:?}", other)),
        }
    }

    pub fn resize_session(id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sock = default_socket_path();
        match rpc(
            &sock,
            &DaemonRequest::Resize {
                id: id.to_string(),
                cols,
                rows,
            },
        )? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Err { message } => Err(message),
            other => Err(format!("unexpected response: {:?}", other)),
        }
    }

    pub fn list_sessions() -> Vec<DaemonSessionSnapshot> {
        let sock = default_socket_path();
        match rpc(&sock, &DaemonRequest::ListSessions) {
            Ok(DaemonResponse::Sessions { sessions }) => sessions,
            _ => Vec::new(),
        }
    }

    pub fn capture_screen(id: &str) -> Option<String> {
        let sock = default_socket_path();
        match rpc(&sock, &DaemonRequest::CaptureScreen { id: id.to_string() }) {
            Ok(DaemonResponse::Screen { contents }) => contents,
            _ => None,
        }
    }

    /// Client handle for a live binary attach stream to `pty-daemon`.
    pub struct NativeAttachStream {
        reader: UnixStream,
        writer: UnixStream,
    }

    pub enum NativeAttachFrame {
        Output(Bytes),
        Died,
        ComposerAck(bool),
    }

    impl NativeAttachStream {
        pub fn connect(session_id: &str, cols: u16, rows: u16) -> Result<Self, String> {
            let sock = default_socket_path();
            Self::connect_at(&sock, session_id, cols, rows)
        }

        pub fn connect_at(
            socket_path: &Path,
            session_id: &str,
            cols: u16,
            rows: u16,
        ) -> Result<Self, String> {
            let mut stream = UnixStream::connect(socket_path)
                .map_err(|e| format!("connect pty-daemon failed: {}", e))?;
            write_json_frame(
                &mut stream,
                &DaemonRequest::Attach {
                    id: session_id.to_string(),
                    cols,
                    rows,
                },
            )
            .map_err(|e| format!("attach handshake write failed: {}", e))?;
            match read_json_frame::<_, DaemonResponse>(&mut stream)
                .map_err(|e| format!("attach handshake read failed: {}", e))?
            {
                DaemonResponse::Attached => {}
                DaemonResponse::Err { message } => return Err(message),
                other => return Err(format!("unexpected attach response: {:?}", other)),
            }
            let writer = stream
                .try_clone()
                .map_err(|e| format!("clone attach stream failed: {}", e))?;
            Ok(Self {
                reader: stream,
                writer,
            })
        }

        pub fn split(self) -> (NativeAttachReader, NativeAttachWriter) {
            (
                NativeAttachReader {
                    stream: self.reader,
                },
                NativeAttachWriter {
                    stream: self.writer,
                },
            )
        }
    }

    pub struct NativeAttachReader {
        stream: UnixStream,
    }

    impl NativeAttachReader {
        pub fn read_frame(&mut self) -> std::io::Result<NativeAttachFrame> {
            let (tag, payload) = read_bin_frame(&mut self.stream)?;
            match tag {
                TAG_OUTPUT => Ok(NativeAttachFrame::Output(Bytes::from(payload))),
                TAG_DIED => Ok(NativeAttachFrame::Died),
                TAG_COMPOSER_ACK => Ok(NativeAttachFrame::ComposerAck(
                    payload.first().copied().unwrap_or(0) != 0,
                )),
                _ => Ok(NativeAttachFrame::Output(Bytes::new())),
            }
        }
    }

    pub struct NativeAttachWriter {
        stream: UnixStream,
    }

    impl NativeAttachWriter {
        pub fn send_input(&mut self, data: &[u8]) -> std::io::Result<()> {
            write_bin_frame(&mut self.stream, CMD_INPUT, data)
        }

        pub fn send_resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
            let mut buf = [0u8; 4];
            buf[0..2].copy_from_slice(&cols.to_be_bytes());
            buf[2..4].copy_from_slice(&rows.to_be_bytes());
            write_bin_frame(&mut self.stream, CMD_RESIZE, &buf)
        }

        pub fn send_refresh(&mut self) -> std::io::Result<()> {
            write_bin_frame(&mut self.stream, CMD_REFRESH, &[])
        }

        pub fn send_composer(&mut self, paste: &[u8]) -> std::io::Result<()> {
            write_bin_frame(&mut self.stream, CMD_COMPOSER, paste)
        }

        pub fn shutdown(&self) {
            let _ = self.stream.shutdown(std::net::Shutdown::Both);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::AtomicUsize;

        static TEST_COUNTER: AtomicUsize = AtomicUsize::new(0);

        fn start_test_daemon() -> PathBuf {
            let n = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let sock = std::env::temp_dir().join(format!(
                "offdesk-pty-daemon-test-{}-{}.sock",
                std::process::id(),
                n
            ));
            let _ = std::fs::remove_file(&sock);
            let sock_clone = sock.clone();
            std::thread::spawn(move || {
                let _ = run_server(&sock_clone);
            });
            for _ in 0..40 {
                if ping_at(&sock).is_ok() {
                    return sock;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("test pty-daemon failed to start at {:?}", sock);
        }

        fn rpc_create(sock: &Path, id: &str, cols: u16, rows: u16) {
            let resp = rpc(
                sock,
                &DaemonRequest::CreateSession {
                    id: id.to_string(),
                    cwd: "/tmp".to_string(),
                    cols,
                    rows,
                    shell: "/bin/sh".to_string(),
                    env: vec![],
                },
            )
            .expect("create rpc");
            assert!(matches!(resp, DaemonResponse::Ok), "{:?}", resp);
        }

        fn wait_for_screen_contains(sock: &Path, id: &str, needle: &str) -> String {
            for _ in 0..80 {
                if let Ok(DaemonResponse::Screen {
                    contents: Some(text),
                }) = rpc(sock, &DaemonRequest::CaptureScreen { id: id.to_string() })
                {
                    if text.contains(needle) {
                        return text;
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            panic!("screen for {} never contained {:?}", id, needle);
        }

        #[test]
        fn daemon_ping_create_list_and_destroy() {
            let sock = start_test_daemon();
            assert!(ping_at(&sock).unwrap() > 0);
            rpc_create(&sock, "s1", 80, 24);

            let sessions = match rpc(&sock, &DaemonRequest::ListSessions).unwrap() {
                DaemonResponse::Sessions { sessions } => sessions,
                other => panic!("unexpected {:?}", other),
            };
            assert_eq!(sessions.len(), 1);
            assert_eq!(sessions[0].id, "s1");
            assert_eq!(sessions[0].cols, 80);
            assert_eq!(sessions[0].rows, 24);

            let resp = rpc(
                &sock,
                &DaemonRequest::DestroySession {
                    id: "s1".to_string(),
                },
            )
            .unwrap();
            assert!(matches!(resp, DaemonResponse::Ok));
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn daemon_attach_streams_live_io_and_reattach_preserves_screen() {
            let sock = start_test_daemon();
            rpc_create(&sock, "s-io", 80, 24);

            // Attach client 1, run a command, verify live output.
            let stream = NativeAttachStream::connect_at(&sock, "s-io", 80, 24).unwrap();
            let (reader, mut writer) = stream.split();
            writer.send_input(b"echo HELLO_NATIVE_PTY\n").unwrap();

            let screen = wait_for_screen_contains(&sock, "s-io", "HELLO_NATIVE_PTY");
            assert!(screen.contains("HELLO_NATIVE_PTY"));

            // Detach client 1.
            writer.shutdown();
            drop(writer);
            drop(reader);

            // Re-attach client 2: first Output frame must contain the preserved screen state!
            let stream2 = NativeAttachStream::connect_at(&sock, "s-io", 80, 24).unwrap();
            let (mut reader2, writer2) = stream2.split();
            let first = reader2.read_frame().unwrap();
            match first {
                NativeAttachFrame::Output(bytes) => {
                    let s = String::from_utf8_lossy(&bytes);
                    assert!(
                        s.contains("HELLO_NATIVE_PTY"),
                        "reattach initial state missing marker: {:?}",
                        s
                    );
                }
                _ => panic!("expected Output frame on reattach"),
            }
            writer2.shutdown();
            let _ = rpc(
                &sock,
                &DaemonRequest::DestroySession {
                    id: "s-io".to_string(),
                },
            );
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn daemon_resize_and_refresh_redraw() {
            let sock = start_test_daemon();
            rpc_create(&sock, "s-rsz", 80, 24);

            let stream = NativeAttachStream::connect_at(&sock, "s-rsz", 120, 40).unwrap();
            let (mut reader, mut writer) = stream.split();

            // Verify PTY size updated to 120x40.
            writer.send_input(b"stty size\n").unwrap();
            let screen = wait_for_screen_contains(&sock, "s-rsz", "40 120");
            assert!(screen.contains("40 120"));

            // Dynamic resize to 100x30.
            writer.send_resize(100, 30).unwrap();
            std::thread::sleep(Duration::from_millis(50));
            writer.send_input(b"stty size\n").unwrap();
            let screen2 = wait_for_screen_contains(&sock, "s-rsz", "30 100");
            assert!(screen2.contains("30 100"));

            // Refresh must emit a full screen redraw frame containing previous output.
            writer.send_refresh().unwrap();
            let mut saw_redraw = false;
            for _ in 0..20 {
                if let Ok(NativeAttachFrame::Output(bytes)) = reader.read_frame() {
                    if String::from_utf8_lossy(&bytes).contains("30 100") {
                        saw_redraw = true;
                        break;
                    }
                }
            }
            assert!(saw_redraw, "refresh did not emit full screen redraw");

            writer.shutdown();
            let _ = rpc(
                &sock,
                &DaemonRequest::DestroySession {
                    id: "s-rsz".to_string(),
                },
            );
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn daemon_multi_client_simultaneous_attach() {
            let sock = start_test_daemon();
            rpc_create(&sock, "s-multi", 80, 24);

            let s1 = NativeAttachStream::connect_at(&sock, "s-multi", 80, 24).unwrap();
            let s2 = NativeAttachStream::connect_at(&sock, "s-multi", 80, 24).unwrap();
            let (mut r1, mut w1) = s1.split();
            let (mut r2, w2) = s2.split();

            w1.send_input(b"echo MULTI_OK_42\n").unwrap();
            wait_for_screen_contains(&sock, "s-multi", "MULTI_OK_42");

            let read_until = |r: &mut NativeAttachReader| -> bool {
                let mut acc = String::new();
                for _ in 0..30 {
                    if let Ok(NativeAttachFrame::Output(b)) = r.read_frame() {
                        acc.push_str(&String::from_utf8_lossy(&b));
                        if acc.contains("MULTI_OK_42") {
                            return true;
                        }
                    }
                }
                false
            };

            assert!(read_until(&mut r1), "client 1 missed output");
            assert!(read_until(&mut r2), "client 2 missed output");

            w1.shutdown();
            w2.shutdown();
            let _ = rpc(
                &sock,
                &DaemonRequest::DestroySession {
                    id: "s-multi".to_string(),
                },
            );
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn daemon_alt_screen_tui_and_composer_ack() {
            let sock = start_test_daemon();
            rpc_create(&sock, "s-alt", 80, 24);

            let stream = NativeAttachStream::connect_at(&sock, "s-alt", 80, 24).unwrap();
            let (mut reader, mut writer) = stream.split();

            // Enter alternate screen (like vim / Claude Code / htop) and draw text.
            writer
                .send_input(b"printf '\\033[?1049h\\033[2J\\033[HALT_TUI_MARKER'\n")
                .unwrap();
            wait_for_screen_contains(&sock, "s-alt", "ALT_TUI_MARKER");

            // Test Composer paste + Enter + ack.
            writer.send_composer(b"echo COMPOSER_OK").unwrap();
            let mut got_ack = false;
            for _ in 0..30 {
                if let Ok(NativeAttachFrame::ComposerAck(ok)) = reader.read_frame() {
                    assert!(ok);
                    got_ack = true;
                    break;
                }
            }
            assert!(got_ack, "expected ComposerAck(true)");

            writer.shutdown();
            drop(writer);
            drop(reader);

            // Re-attach must restore alternate screen contents.
            let stream2 = NativeAttachStream::connect_at(&sock, "s-alt", 80, 24).unwrap();
            let (mut reader2, writer2) = stream2.split();
            let first = reader2.read_frame().unwrap();
            match first {
                NativeAttachFrame::Output(bytes) => {
                    let s = String::from_utf8_lossy(&bytes);
                    assert!(
                        s.contains("ALT_TUI_MARKER"),
                        "reattach missed alt-screen contents: {:?}",
                        s
                    );
                }
                _ => panic!("expected Output frame on alt-screen reattach"),
            }
            writer2.shutdown();
            let _ = rpc(
                &sock,
                &DaemonRequest::DestroySession {
                    id: "s-alt".to_string(),
                },
            );
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn daemon_shell_exit_emits_died_and_reaps_session() {
            let sock = start_test_daemon();
            rpc_create(&sock, "s-exit", 80, 24);

            let stream = NativeAttachStream::connect_at(&sock, "s-exit", 80, 24).unwrap();
            let (mut reader, mut writer) = stream.split();

            writer.send_input(b"exit\n").unwrap();
            let mut saw_died = false;
            for _ in 0..50 {
                match reader.read_frame() {
                    Ok(NativeAttachFrame::Died) => {
                        saw_died = true;
                        break;
                    }
                    Ok(_) => continue,
                    Err(_) => {
                        saw_died = true;
                        break;
                    }
                }
            }
            assert!(saw_died, "expected Died notification after shell exit");

            // Session should be reaped from ListSessions shortly after exit.
            let mut reaped = false;
            for _ in 0..40 {
                if let Ok(DaemonResponse::Sessions { sessions }) =
                    rpc(&sock, &DaemonRequest::ListSessions)
                {
                    if sessions.is_empty() {
                        reaped = true;
                        break;
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            assert!(reaped, "exited session was not reaped");
            let _ = std::fs::remove_file(&sock);
        }

        #[test]
        fn intercept_terminal_queries_answers_dsr_and_da_and_strips_queries() {
            let input = b"hello\x1b[6nworld\x1b[c!\x1b[>0c";
            let (forward, reply) = intercept_terminal_queries(input, (4, 9));
            assert_eq!(forward, b"helloworld!");
            assert_eq!(
                reply.as_deref(),
                Some(&b"\x1b[5;10R\x1b[?62;22c\x1b[>0;276;0c"[..])
            );

            let plain = b"plain text\r\n";
            let (fwd2, rep2) = intercept_terminal_queries(plain, (0, 0));
            assert_eq!(fwd2, plain);
            assert!(rep2.is_none());
        }

        #[test]
        fn sgr_mouse_wheel_drives_daemon_scrollback_without_leaking_to_pty() {
            let (pass, delta) =
                extract_sgr_mouse_for_scrollback(b"\x1b[<64;10;5M\x1b[<64;10;5M");
            assert!(pass.is_empty());
            assert_eq!(delta, 6);

            let (pass2, delta2) =
                extract_sgr_mouse_for_scrollback(b"\x1b[<65;10;5Mabc\x1b[<0;1;1m");
            assert_eq!(pass2, b"abc");
            assert_eq!(delta2, -3);
        }

        #[test]
        fn alacritty_scrollback_up_and_down_reaches_exact_bottom_with_decstbm_and_cjk() {
            let mut term = DaemonTerm::new(10, 60, 1000);
            // Simulate an app like agy that sets a top-anchored scroll region
            // (rows 1..8) while keeping a pinned prompt on rows 9..10.
            term.process(b"\x1b[1;8r\x1b[1;1H");
            for i in 0..40 {
                term.process(format!("LINE_{i:02} 中文测试行\r\n").as_bytes());
            }
            // Pin prompt at bottom.
            term.process(b"\x1b[r\x1b[10;1H> prompt");

            // Live view (offset 0) must show the pinned bottom prompt.
            let (live_bytes, live_off) = term.render_ansi_at_scrollback(0);
            assert_eq!(live_off, 0);
            let live_str = String::from_utf8_lossy(&live_bytes);
            assert!(live_str.contains("> prompt"), "live view missing bottom prompt");
            assert!(live_str.contains("LINE_39"), "live view missing latest line");

            // Scroll up 20 lines: must show older history and hide live cursor.
            let (up_bytes, up_off) = term.render_ansi_at_scrollback(20);
            assert_eq!(up_off, 20);
            let up_str = String::from_utf8_lossy(&up_bytes);
            assert!(up_str.contains("LINE_15"), "scrolled up view missing older history: {up_str}");
            assert!(!up_str.contains("> prompt"), "scrolled up view leaked bottom prompt");
            assert!(up_str.contains("\x1b[?25l"), "scrolled up view should hide cursor");

            // Scroll back down to 0: must restore exact live bottom with prompt & cursor.
            let (down_bytes, down_off) = term.render_ansi_at_scrollback(0);
            assert_eq!(down_off, 0);
            let down_str = String::from_utf8_lossy(&down_bytes);
            assert!(down_str.contains("> prompt"), "scrolled back to bottom missing prompt");
            assert!(down_str.contains("LINE_39"), "scrolled back to bottom missing latest line");
            assert!(down_str.contains("\x1b[?25h"), "scrolled back to bottom should restore cursor");
        }
    }
}

#[cfg(unix)]
pub use unix_impl::*;

#[cfg(not(unix))]
pub mod non_unix_stub {
    use std::path::{Path, PathBuf};

    #[derive(Debug, Clone)]
    pub struct DaemonSessionSnapshot {
        pub id: String,
        pub pid: Option<u32>,
        pub title: String,
        pub cwd: String,
        pub current_command: Option<String>,
        pub cols: u16,
        pub rows: u16,
        pub activity_ms: i64,
    }

    pub fn default_socket_path() -> PathBuf {
        PathBuf::from("pty-daemon.sock")
    }

    pub fn run_server(_socket_path: &Path) -> Result<(), String> {
        Err("native pty-daemon is only supported on Unix".to_string())
    }

    pub fn ensure_daemon_running() -> Result<PathBuf, String> {
        Err("native pty-daemon is only supported on Unix".to_string())
    }
}

#[cfg(not(unix))]
pub use non_unix_stub::*;
