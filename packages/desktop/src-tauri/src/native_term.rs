use alacritty_terminal::event::{Event as TermEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::{Config as TermConfig, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color as AnsiColor, CursorShape, NamedColor, Rgb};
use base64::Engine;
use serde::Serialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const ANSI_16: [&str; 16] = [
    "#18181b", "#ef4444", "#22c55e", "#eab308", "#60a5fa", "#c084fc", "#2dd4bf", "#d4d4d8",
    "#71717a", "#f87171", "#4ade80", "#facc15", "#93c5fd", "#d8b4fe", "#5eead4", "#fafafa",
];

#[derive(Clone, Default)]
struct TitleSink {
    title: Arc<Mutex<Option<String>>>,
    clipboard: Arc<Mutex<Option<String>>>,
}

impl EventListener for TitleSink {
    fn send_event(&self, event: TermEvent) {
        match event {
            TermEvent::Title(t) => {
                if let Ok(mut guard) = self.title.lock() {
                    *guard = Some(t);
                }
            }
            TermEvent::ClipboardStore(_, text) => {
                if let Ok(mut guard) = self.clipboard.lock() {
                    *guard = Some(text);
                }
            }
            _ => {}
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
    pub f: Option<Cow<'static, str>>,
    #[serde(skip_serializing_if = "is_false")]
    pub b: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub i: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub u: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub s: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeBgRun {
    pub r: usize,
    pub c: usize,
    pub l: usize,
    pub g: Cow<'static, str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeTermFrame {
    pub cols: u16,
    pub rows: u16,
    pub spans: Vec<Vec<NativeSpan>>,
    pub bgs: Vec<NativeBgRun>,
    pub cursor: Option<(usize, usize)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_shape: Option<&'static str>,
    pub display_offset: usize,
    pub history_size: usize,
    pub wants_mouse: bool,
    pub bracketed_paste: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub app_cursor: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard_write: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub wrapped_rows: Vec<bool>,
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
        let mut wrapped_rows = Vec::with_capacity(rows);
        let mut any_wrapped = false;

        for vis_row in 0..rows {
            let line = Line(vis_row as i32 - display_offset as i32);
            let row_wrapped = cols > 0
                && grid[line][Column(cols - 1)]
                    .flags
                    .contains(CellFlags::WRAPLINE);
            if row_wrapped {
                any_wrapped = true;
            }
            wrapped_rows.push(row_wrapped);
            let mut row_spans: Vec<NativeSpan> = Vec::new();
            let mut cur_span: Option<NativeSpan> = None;
            let mut cur_span_color_key: Option<(AnsiColor, AnsiColor, bool, bool)> = None;
            let mut cur_bg: Option<(usize, usize, Cow<'static, str>)> = None;
            let mut cur_bg_key: Option<(AnsiColor, AnsiColor, bool)> = None;

            for col in 0..cols {
                let cell = &grid[line][Column(col)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let inverse = cell.flags.contains(CellFlags::INVERSE);
                let dim = cell.flags.contains(CellFlags::DIM);
                let cell_w = if cell.flags.contains(CellFlags::WIDE_CHAR) { 2 } else { 1 };

                let has_bg = inverse || !matches!(cell.bg, AnsiColor::Named(NamedColor::Background));
                if has_bg {
                    let bg_key = (cell.fg, cell.bg, inverse);
                    let can_extend_bg = cur_bg
                        .as_ref()
                        .is_some_and(|(start, len, _)| *start + *len == col)
                        && cur_bg_key == Some(bg_key);
                    if can_extend_bg {
                        if let Some((_, len, _)) = &mut cur_bg {
                            *len += cell_w;
                        }
                    } else {
                        let bg_hex = if inverse {
                            resolve_fg_hex(cell.fg).unwrap_or(Cow::Borrowed("#e4e4e7"))
                        } else {
                            resolve_bg_hex(cell.bg).unwrap_or(Cow::Borrowed("#131415"))
                        };
                        match &mut cur_bg {
                            Some((start, len, color))
                                if *start + *len == col && *color == bg_hex =>
                            {
                                *len += cell_w;
                                cur_bg_key = Some(bg_key);
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
                                cur_bg_key = Some(bg_key);
                            }
                        }
                    }
                } else if let Some((start, len, color)) = cur_bg.take() {
                    bgs.push(NativeBgRun {
                        r: vis_row,
                        c: start,
                        l: len,
                        g: color,
                    });
                    cur_bg_key = None;
                }

                let ch = cell.c;
                if ch == ' ' || ch == '\0' || cell.flags.contains(CellFlags::HIDDEN) {
                    if let Some(sp) = cur_span.take() {
                        row_spans.push(sp);
                        cur_span_color_key = None;
                    }
                    continue;
                }
                let bold = cell.flags.contains(CellFlags::BOLD);
                let italic = cell.flags.contains(CellFlags::ITALIC);
                let underline = cell.flags.intersects(CellFlags::ALL_UNDERLINES);
                let strikeout = cell.flags.contains(CellFlags::STRIKEOUT);
                let hyperlink = cell.hyperlink().map(|hl| hl.uri().to_string());
                let color_key = (cell.fg, cell.bg, inverse, dim);

                let can_merge_fast = cur_span_color_key == Some(color_key)
                    && cur_span.as_ref().is_some_and(|sp| {
                        sp.b == bold
                            && sp.i == italic
                            && sp.u == underline
                            && sp.s == strikeout
                            && sp.h == hyperlink
                    });
                if can_merge_fast {
                    if let Some(sp) = &mut cur_span {
                        sp.t.push(ch);
                        if let Some(zw) = cell.zerowidth() {
                            for &z in zw {
                                sp.t.push(z);
                            }
                        }
                    }
                    continue;
                }

                let mut fg = if inverse {
                    Some(resolve_bg_hex(cell.bg).unwrap_or(Cow::Borrowed("#131415")))
                } else {
                    resolve_fg_hex(cell.fg)
                };
                if dim {
                    let base = fg.as_deref().unwrap_or("#e4e4e7");
                    fg = Some(Cow::Owned(dim_hex(base)));
                }

                let can_merge = cur_span.as_ref().is_some_and(|sp| {
                    sp.f == fg
                        && sp.b == bold
                        && sp.i == italic
                        && sp.u == underline
                        && sp.s == strikeout
                        && sp.h == hyperlink
                });
                if can_merge {
                    if let Some(sp) = &mut cur_span {
                        sp.t.push(ch);
                        if let Some(zw) = cell.zerowidth() {
                            for &z in zw {
                                sp.t.push(z);
                            }
                        }
                    }
                    cur_span_color_key = Some(color_key);
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
                        u: underline,
                        s: strikeout,
                        h: hyperlink,
                    });
                    cur_span_color_key = Some(color_key);
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
        let cursor_shape_raw = self.term.cursor_style().shape;
        let cursor = if display_offset == 0
            && mode.contains(TermMode::SHOW_CURSOR)
            && !matches!(cursor_shape_raw, CursorShape::Hidden)
        {
            let pt = grid.cursor.point;
            if pt.line.0 >= 0 && (pt.line.0 as usize) < rows {
                Some((pt.column.0, pt.line.0 as usize))
            } else {
                None
            }
        } else {
            None
        };
        let cursor_shape = Some(match cursor_shape_raw {
            CursorShape::Beam => "beam",
            CursorShape::Underline => "underline",
            CursorShape::HollowBlock => "hollow",
            _ => "block",
        });
        let title = self.sink.title.lock().ok().and_then(|mut g| g.take());
        let clipboard_write = self.sink.clipboard.lock().ok().and_then(|mut g| g.take());

        let history_size = grid.history_size();

        NativeTermFrame {
            cols: self.cols,
            rows: self.rows,
            spans: spans_by_row,
            bgs,
            cursor,
            cursor_shape,
            display_offset,
            history_size,
            wants_mouse: mode.intersects(TermMode::MOUSE_MODE),
            bracketed_paste: mode.contains(TermMode::BRACKETED_PASTE),
            app_cursor: mode.contains(TermMode::APP_CURSOR),
            title,
            clipboard_write,
            wrapped_rows: if any_wrapped { wrapped_rows } else { Vec::new() },
        }
    }

    fn plain_lines(&self) -> Vec<String> {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let grid = self.term.grid();
        let history_size = grid.history_size();
        let total = history_size + rows;
        let mut out = Vec::with_capacity(total);
        for idx in 0..total {
            let line = Line(idx as i32 - history_size as i32);
            let mut s = String::with_capacity(cols);
            for col in 0..cols {
                let cell = &grid[line][Column(col)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                if cell.flags.contains(CellFlags::HIDDEN) {
                    s.push(' ');
                    continue;
                }
                s.push(if cell.c == '\0' { ' ' } else { cell.c });
            }
            out.push(s.trim_end().to_string());
        }
        out
    }
}

fn resolve_fg_hex(color: AnsiColor) -> Option<Cow<'static, str>> {
    match color {
        AnsiColor::Named(NamedColor::Foreground | NamedColor::BrightForeground) => None,
        other => Some(color_to_hex(other)),
    }
}

fn resolve_bg_hex(color: AnsiColor) -> Option<Cow<'static, str>> {
    match color {
        AnsiColor::Named(NamedColor::Background) => None,
        other => Some(color_to_hex(other)),
    }
}

fn color_to_hex(color: AnsiColor) -> Cow<'static, str> {
    match color {
        AnsiColor::Spec(Rgb { r, g, b }) => Cow::Owned(format!("#{r:02x}{g:02x}{b:02x}")),
        AnsiColor::Indexed(idx) => {
            if (idx as usize) < 16 {
                Cow::Borrowed(ANSI_16[idx as usize])
            } else if idx < 232 {
                let n = idx - 16;
                let lvl = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
                Cow::Owned(format!(
                    "#{:02x}{:02x}{:02x}",
                    lvl(n / 36),
                    lvl((n % 36) / 6),
                    lvl(n % 6)
                ))
            } else {
                let g = 8 + (idx - 232) * 10;
                Cow::Owned(format!("#{g:02x}{g:02x}{g:02x}"))
            }
        }
        AnsiColor::Named(named) => match named {
            NamedColor::Black => Cow::Borrowed(ANSI_16[0]),
            NamedColor::Red => Cow::Borrowed(ANSI_16[1]),
            NamedColor::Green => Cow::Borrowed(ANSI_16[2]),
            NamedColor::Yellow => Cow::Borrowed(ANSI_16[3]),
            NamedColor::Blue => Cow::Borrowed(ANSI_16[4]),
            NamedColor::Magenta => Cow::Borrowed(ANSI_16[5]),
            NamedColor::Cyan => Cow::Borrowed(ANSI_16[6]),
            NamedColor::White => Cow::Borrowed(ANSI_16[7]),
            NamedColor::BrightBlack => Cow::Borrowed(ANSI_16[8]),
            NamedColor::BrightRed => Cow::Borrowed(ANSI_16[9]),
            NamedColor::BrightGreen => Cow::Borrowed(ANSI_16[10]),
            NamedColor::BrightYellow => Cow::Borrowed(ANSI_16[11]),
            NamedColor::BrightBlue => Cow::Borrowed(ANSI_16[12]),
            NamedColor::BrightMagenta => Cow::Borrowed(ANSI_16[13]),
            NamedColor::BrightCyan => Cow::Borrowed(ANSI_16[14]),
            NamedColor::BrightWhite => Cow::Borrowed(ANSI_16[15]),
            NamedColor::DimBlack => Cow::Owned(dim_hex(ANSI_16[0])),
            NamedColor::DimRed => Cow::Owned(dim_hex(ANSI_16[1])),
            NamedColor::DimGreen => Cow::Owned(dim_hex(ANSI_16[2])),
            NamedColor::DimYellow => Cow::Owned(dim_hex(ANSI_16[3])),
            NamedColor::DimBlue => Cow::Owned(dim_hex(ANSI_16[4])),
            NamedColor::DimMagenta => Cow::Owned(dim_hex(ANSI_16[5])),
            NamedColor::DimCyan => Cow::Owned(dim_hex(ANSI_16[6])),
            NamedColor::DimWhite => Cow::Owned(dim_hex(ANSI_16[7])),
            NamedColor::DimForeground => Cow::Owned(dim_hex("#e4e4e7")),
            NamedColor::Background => Cow::Borrowed("#131415"),
            _ => Cow::Borrowed("#e4e4e7"),
        },
    }
}

fn dim_hex(hex: &str) -> String {
    let raw = hex.strip_prefix('#').unwrap_or(hex);
    if raw.len() == 6 {
        if let (Ok(r), Ok(g), Ok(b)) = (
            u8::from_str_radix(&raw[0..2], 16),
            u8::from_str_radix(&raw[2..4], 16),
            u8::from_str_radix(&raw[4..6], 16),
        ) {
            // Blend 55% toward dark terminal background (#131415) for ANSI SGR 2 (dim/faint).
            let mix = |c: u8, bg: u8| -> u8 { ((c as u16 * 45 + bg as u16 * 55) / 100) as u8 };
            return format!("#{:02x}{:02x}{:02x}", mix(r, 0x13), mix(g, 0x14), mix(b, 0x15));
        }
    }
    "#737477".into()
}

#[derive(Default)]
pub struct NativeTermState {
    instances: Mutex<HashMap<String, Arc<Mutex<TermInstance>>>>,
}

impl NativeTermState {
    fn create_fresh(
        &self,
        id: String,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Mutex<TermInstance>>, String> {
        let mut map = self.instances.lock().map_err(|e| e.to_string())?;
        let inst = Arc::new(Mutex::new(TermInstance::new(cols, rows)));
        map.insert(id, Arc::clone(&inst));
        Ok(inst)
    }

    fn get_or_create(
        &self,
        id: String,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Mutex<TermInstance>>, String> {
        let mut map = self.instances.lock().map_err(|e| e.to_string())?;
        Ok(Arc::clone(
            map.entry(id)
                .or_insert_with(|| Arc::new(Mutex::new(TermInstance::new(cols, rows)))),
        ))
    }

    fn get(&self, id: &str) -> Result<Arc<Mutex<TermInstance>>, String> {
        let map = self.instances.lock().map_err(|e| e.to_string())?;
        map.get(id)
            .cloned()
            .ok_or_else(|| "terminal not open".to_string())
    }
}

#[tauri::command]
pub fn native_term_open(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<NativeTermFrame, String> {
    // Always create a fresh TermInstance so OTA/webview reloads never inherit
    // stale dimensions, modes, or scrollback from a previous JS lifecycle.
    let inst_arc = state.create_fresh(id, cols, rows)?;
    let inst = inst_arc.lock().map_err(|e| e.to_string())?;
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
    let inst_arc = state.get(&id)?;
    let mut inst = inst_arc.lock().map_err(|e| e.to_string())?;
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
    let inst_arc = state.get_or_create(id, cols, rows)?;
    let mut inst = inst_arc.lock().map_err(|e| e.to_string())?;
    inst.resize(cols, rows);
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_scroll(
    state: tauri::State<'_, NativeTermState>,
    id: String,
    delta_lines: i32,
) -> Result<NativeTermFrame, String> {
    let inst_arc = state.get(&id)?;
    let mut inst = inst_arc.lock().map_err(|e| e.to_string())?;
    inst.term.scroll_display(Scroll::Delta(delta_lines));
    Ok(inst.snapshot())
}

#[tauri::command]
pub fn native_term_snap_bottom(
    state: tauri::State<'_, NativeTermState>,
    id: String,
) -> Result<NativeTermFrame, String> {
    let inst_arc = state.get(&id)?;
    let mut inst = inst_arc.lock().map_err(|e| e.to_string())?;
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
    let inst_arc = state.get(&id)?;
    let inst = inst_arc.lock().map_err(|e| e.to_string())?;
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
