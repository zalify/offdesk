use alacritty_terminal::event::{Event as TermEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::{Config as TermConfig, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color as AnsiColor, NamedColor, Rgb};
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const ANSI_16: [&str; 16] = [
    "#18181b", "#ef4444", "#22c55e", "#eab308", "#60a5fa", "#c084fc", "#2dd4bf", "#d4d4d8",
    "#71717a", "#f87171", "#4ade80", "#facc15", "#93c5fd", "#d8b4fe", "#5eead4", "#fafafa",
];

#[derive(Clone, Default)]
struct TitleSink {
    title: Arc<Mutex<Option<String>>>,
}

impl EventListener for TitleSink {
    fn send_event(&self, event: TermEvent) {
        if let TermEvent::Title(t) = event {
            if let Ok(mut guard) = self.title.lock() {
                *guard = Some(t);
            }
        }
    }
}

struct TermSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for TermSize {
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

#[derive(Debug, Clone, Serialize)]
pub struct NativeSpan {
    pub c: usize,
    pub t: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub f: Option<String>,
    #[serde(skip_serializing_if = "is_false")]
    pub b: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub i: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeBgRun {
    pub r: usize,
    pub c: usize,
    pub l: usize,
    pub g: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeTermFrame {
    pub cols: u16,
    pub rows: u16,
    pub spans: Vec<Vec<NativeSpan>>,
    pub bgs: Vec<NativeBgRun>,
    pub cursor: Option<(usize, usize)>,
    pub display_offset: usize,
    pub history_size: usize,
    pub wants_mouse: bool,
    pub bracketed_paste: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

struct TermInstance {
    term: Term<TitleSink>,
    parser: ansi::Processor,
    sink: TitleSink,
    cols: u16,
    rows: u16,
}

impl TermInstance {
    fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(2);
        let sink = TitleSink::default();
        let config = TermConfig {
            scrolling_history: 10_000,
            ..TermConfig::default()
        };
        let size = TermSize {
            cols: cols as usize,
            rows: rows as usize,
        };
        let term = Term::new(config, &size, sink.clone());
        Self {
            term,
            parser: ansi::Processor::new(),
            sink,
            cols,
            rows,
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        if !bytes.is_empty() {
            self.parser.advance(&mut self.term, bytes);
        }
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(2);
        let rows = rows.max(2);
        if self.cols == cols && self.rows == rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        self.term.resize(TermSize {
            cols: cols as usize,
            rows: rows as usize,
        });
    }

    fn snapshot(&self) -> NativeTermFrame {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let grid = self.term.grid();
        let display_offset = grid.display_offset();
        let mut spans_by_row = Vec::with_capacity(rows);
        let mut bgs = Vec::new();

        for vis_row in 0..rows {
            let line = Line(vis_row as i32 - display_offset as i32);
            let mut row_spans: Vec<NativeSpan> = Vec::new();
            let mut cur_span: Option<NativeSpan> = None;
            let mut cur_bg: Option<(usize, usize, String)> = None;

            for col in 0..cols {
                let cell = &grid[line][Column(col)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let inverse = cell.flags.contains(CellFlags::INVERSE);
                let mut fg = resolve_fg_hex(cell.fg);
                let mut bg = resolve_bg_hex(cell.bg);
                if inverse {
                    let next_fg = bg.clone().or_else(|| Some("#131415".to_string()));
                    let next_bg = fg.clone().or_else(|| Some("#e4e4e7".to_string()));
                    fg = next_fg;
                    bg = next_bg;
                }

                let cell_w = if cell.flags.contains(CellFlags::WIDE_CHAR) { 2 } else { 1 };
                if let Some(bg_hex) = bg {
                    match &mut cur_bg {
                        Some((start, len, color)) if *start + *len == col && *color == bg_hex => {
                            *len += cell_w;
                        }
                        _ => {
                            if let Some((start, len, color)) = cur_bg.take() {
                                bgs.push(NativeBgRun {
                                    r: vis_row,
                                    c: start,
                                    l: len,
                                    g: color,
                                });
                            }
                            cur_bg = Some((col, cell_w, bg_hex));
                        }
                    }
                } else if let Some((start, len, color)) = cur_bg.take() {
                    bgs.push(NativeBgRun {
                        r: vis_row,
                        c: start,
                        l: len,
                        g: color,
                    });
                }

                let ch = cell.c;
                if ch == ' ' || ch == '\0' {
                    if let Some(sp) = cur_span.take() {
                        row_spans.push(sp);
                    }
                    continue;
                }
                let bold = cell.flags.contains(CellFlags::BOLD);
                let italic = cell.flags.contains(CellFlags::ITALIC);
                let can_merge = cur_span
                    .as_ref()
                    .is_some_and(|s| s.f == fg && s.b == bold && s.i == italic);
                if can_merge {
                    if let Some(sp) = &mut cur_span {
                        sp.t.push(ch);
                        if let Some(zw) = cell.zerowidth() {
                            for &z in zw {
                                sp.t.push(z);
                            }
                        }
                    }
                } else {
                    if let Some(sp) = cur_span.take() {
                        row_spans.push(sp);
                    }
                    let mut text = String::with_capacity(8);
                    text.push(ch);
                    if let Some(zw) = cell.zerowidth() {
                        for &z in zw {
                            text.push(z);
                        }
                    }
                    cur_span = Some(NativeSpan {
                        c: col,
                        t: text,
                        f: fg,
                        b: bold,
                        i: italic,
                    });
                }
            }
            if let Some(sp) = cur_span.take() {
                row_spans.push(sp);
            }
            if let Some((start, len, color)) = cur_bg.take() {
                bgs.push(NativeBgRun {
                    r: vis_row,
                    c: start,
                    l: len,
                    g: color,
                });
            }
            spans_by_row.push(row_spans);
        }

        let mode = self.term.mode();
        let cursor = if display_offset == 0 && mode.contains(TermMode::SHOW_CURSOR) {
            let pt = grid.cursor.point;
            if pt.line.0 >= 0 && (pt.line.0 as usize) < rows {
                Some((pt.column.0, pt.line.0 as usize))
            } else {
                None
            }
        } else {
            None
        };
        let title = self.sink.title.lock().ok().and_then(|mut g| g.take());

        let history_size = grid.history_size();

        NativeTermFrame {
            cols: self.cols,
            rows: self.rows,
            spans: spans_by_row,
            bgs,
            cursor,
            display_offset,
            history_size,
            wants_mouse: mode.intersects(TermMode::MOUSE_MODE),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            title,
        }
    }

    fn plain_lines(&self) -> Vec<String> {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let grid = self.term.grid();
        let display_offset = grid.display_offset();
        let mut out = Vec::with_capacity(rows);
        for vis_row in 0..rows {
            let line = Line(vis_row as i32 - display_offset as i32);
            let mut s = String::with_capacity(cols);
            for col in 0..cols {
                let cell = &grid[line][Column(col)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                s.push(if cell.c == '\0' { ' ' } else { cell.c });
            }
            out.push(s.trim_end().to_string());
        }
        out
    }
}

fn resolve_fg_hex(color: AnsiColor) -> Option<String> {
    match color {
        AnsiColor::Named(NamedColor::Foreground | NamedColor::BrightForeground) => None,
        other => Some(color_to_hex(other)),
    }
}

fn resolve_bg_hex(color: AnsiColor) -> Option<String> {
    match color {
        AnsiColor::Named(NamedColor::Background) => None,
        other => Some(color_to_hex(other)),
    }
}

fn color_to_hex(color: AnsiColor) -> String {
    match color {
        AnsiColor::Spec(Rgb { r, g, b }) => format!("#{r:02x}{g:02x}{b:02x}"),
        AnsiColor::Indexed(idx) => {
            if (idx as usize) < 16 {
                ANSI_16[idx as usize].to_string()
            } else if idx < 232 {
                let n = idx - 16;
                let lvl = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                format!("#{:02x}{:02x}{:02x}", lvl(n / 36), lvl((n % 36) / 6), lvl(n % 6))
            } else {
                let g = 8 + (idx - 232) * 10;
                format!("#{g:02x}{g:02x}{g:02x}")
            }
        }
        AnsiColor::Named(named) => match named {
            NamedColor::Black => ANSI_16[0].into(),
            NamedColor::Red => ANSI_16[1].into(),
            NamedColor::Green => ANSI_16[2].into(),
            NamedColor::Yellow => ANSI_16[3].into(),
            NamedColor::Blue => ANSI_16[4].into(),
            NamedColor::Magenta => ANSI_16[5].into(),
            NamedColor::Cyan => ANSI_16[6].into(),
            NamedColor::White => ANSI_16[7].into(),
            NamedColor::BrightBlack | NamedColor::DimBlack => ANSI_16[8].into(),
            NamedColor::BrightRed | NamedColor::DimRed => ANSI_16[9].into(),
            NamedColor::BrightGreen | NamedColor::DimGreen => ANSI_16[10].into(),
            NamedColor::BrightYellow | NamedColor::DimYellow => ANSI_16[11].into(),
            NamedColor::BrightBlue | NamedColor::DimBlue => ANSI_16[12].into(),
            NamedColor::BrightMagenta | NamedColor::DimMagenta => ANSI_16[13].into(),
            NamedColor::BrightCyan | NamedColor::DimCyan => ANSI_16[14].into(),
            NamedColor::BrightWhite | NamedColor::DimWhite => ANSI_16[15].into(),
            NamedColor::Background => "#131415".into(),
            _ => "#e4e4e7".into(),
        },
    }
}

#[derive(Default)]
pub struct NativeTermState {
    instances: Mutex<HashMap<String, TermInstance>>,
}

#[tauri::command]
pub fn native_term_open(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<NativeTermFrame, String> {
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .entry(id)
        .or_insert_with(|| TermInstance::new(cols, rows));
    inst.resize(cols, rows);
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_feed(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    data_b64: String,
) -> Result<NativeTermFrame, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| format!("base64 decode: {e}"))?;
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .entry(id)
        .or_insert_with(|| TermInstance::new(120, 36));
    inst.feed(&bytes);
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_resize(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<NativeTermFrame, String> {
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .entry(id)
        .or_insert_with(|| TermInstance::new(cols, rows));
    inst.resize(cols, rows);
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_scroll(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    delta_lines: i32,
) -> Result<NativeTermFrame, String> {
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .get_mut(&id)
        .ok_or_else(|| "terminal not open".to_string())?;
    inst.term.scroll_display(Scroll::Delta(delta_lines));
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_snap_bottom(
    state: tauri::State<'_, NativeTermState>,
    id: String,
) -> Result<NativeTermFrame, String> {
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .get_mut(&id)
        .ok_or_else(|| "terminal not open".to_string())?;
    if inst.term.grid().display_offset() > 0 {
        inst.term.scroll_display(Scroll::Bottom);
    }
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_plain_lines(
    state: tauri::State<'_, NativeTermState>,
    id: String,
) -> Result<Vec<String>, String> {
    let map = state.instances.lock().map_err(|e| e.to_string())?;
    let inst = map
        .get(&id)
        .ok_or_else(|| "terminal not open".to_string())?;
    Ok(inst.plain_lines())
}

#[tauri::command]
pub fn native_term_close(
    state: tauri::State<'_, NativeTermState>,
    id: String,
) -> Result<(), String> {
    let mut map = state.instances.lock().map_err(|e| e.to_string())?;
    map.remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alacritty_instance_handles_cjk_truecolor_and_scrollback() {
        let mut inst = TermInstance::new(80, 10);
        for i in 0..25 {
            inst.feed(format!("\x1b[38;2;96;165;250m中文行 {i}\x1b[0m\r\n").as_bytes());
        }
        let frame = inst.snapshot();
        assert_eq!(frame.display_offset, 0);
        assert!(frame.spans.iter().flatten().any(|s| s.t.contains("中文行 24")));
        inst.term.scroll_display(Scroll::Delta(12));
        let scrolled = inst.snapshot();
        assert!(scrolled.display_offset > 0);
        assert!(scrolled.spans.iter().flatten().any(|s| s.t.contains("中文行 10")));
    }
}
