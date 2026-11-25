use alacritty_terminal::event::{Event as TermEvent, EventListener};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags as CellFlags;
use alacritty_terminal::term::{Config as TermConfig, Term, TermMode};
use alacritty_terminal::vte::ansi::{self, Color as AnsiColor, NamedColor, Rgb};
use std::sync::{Arc, Mutex};

/// Color palette (dark theme matching Offdesk desktop).
pub const BG_DEFAULT: [f32; 4] = [0.075, 0.078, 0.082, 1.0];
pub const FG_DEFAULT: [u8; 3] = [228, 228, 231];
pub const CURSOR_COLOR: [f32; 4] = [0.85, 0.78, 0.45, 0.85];

const ANSI_16: [[u8; 3]; 16] = [
    [24, 24, 27],    // Black
    [239, 68, 68],   // Red
    [34, 197, 94],   // Green
    [234, 179, 8],   // Yellow
    [96, 165, 250],  // Blue
    [192, 132, 252], // Magenta
    [45, 212, 191],  // Cyan
    [212, 212, 216], // White
    [113, 113, 122], // Bright Black
    [248, 113, 113], // Bright Red
    [74, 222, 128],  // Bright Green
    [250, 204, 21],  // Bright Yellow
    [147, 197, 253], // Bright Blue
    [216, 180, 254], // Bright Magenta
    [94, 234, 212],  // Bright Cyan
    [250, 250, 250], // Bright White
];

#[derive(Clone, Default)]
pub struct TerminalEventSink {
    pub title: Arc<Mutex<Option<String>>>,
}

impl EventListener for TerminalEventSink {
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

#[derive(Debug, Clone)]
pub struct StyledSpan {
    pub col: usize,
    pub text: String,
    pub fg: [u8; 3],
    pub bold: bool,
    pub italic: bool,
}

#[derive(Debug, Clone)]
pub struct BgRun {
    pub row: usize,
    pub col: usize,
    pub len: usize,
    pub color: [f32; 4],
}

#[derive(Debug, Clone)]
pub struct RenderFrame {
    pub spans_by_row: Vec<Vec<StyledSpan>>,
    pub bg_runs: Vec<BgRun>,
    pub cursor: Option<(usize, usize)>,
    pub display_offset: usize,
}

/// Pure-Rust terminal state backed by `alacritty_terminal` (10,000-line local scrollback).
pub struct NativeTerminal {
    term: Term<TerminalEventSink>,
    parser: ansi::Processor,
    pub cols: u16,
    pub rows: u16,
}

impl NativeTerminal {
    pub fn new(cols: u16, rows: u16) -> Self {
        let cols = cols.max(2);
        let rows = rows.max(2);
        let sink = TerminalEventSink::default();
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
            cols,
            rows,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.parser.advance(&mut self.term, bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let cols = cols.max(2);
        let rows = rows.max(2);
        if self.cols == cols && self.rows == rows {
            return;
        }
        self.cols = cols;
        self.rows = rows;
        let size = TermSize {
            cols: cols as usize,
            rows: rows as usize,
        };
        self.term.resize(size);
    }

    pub fn wants_mouse(&self) -> bool {
        self.term.mode().intersects(TermMode::MOUSE_MODE)
    }

    pub fn bracketed_paste(&self) -> bool {
        self.term.mode().contains(TermMode::BRACKETED_PASTE)
    }

    /// 0ms local GPU scrollback — never waits for a WAN round-trip.
    pub fn scroll_local(&mut self, delta_lines: i32) {
        self.term.scroll_display(Scroll::Delta(delta_lines));
    }

    pub fn snap_to_bottom(&mut self) {
        if self.term.grid().display_offset() > 0 {
            self.term.scroll_display(Scroll::Bottom);
        }
    }

    pub fn snapshot_frame(&self) -> RenderFrame {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let grid = self.term.grid();
        let display_offset = grid.display_offset();
        let mut spans_by_row = Vec::with_capacity(rows);
        let mut bg_runs = Vec::new();

        for vis_row in 0..rows {
            let line = Line(vis_row as i32 - display_offset as i32);
            let mut row_spans: Vec<StyledSpan> = Vec::new();
            let mut cur_span: Option<StyledSpan> = None;
            let mut cur_bg: Option<(usize, usize, [f32; 4])> = None;

            for col in 0..cols {
                let cell = &grid[line][Column(col)];
                if cell.flags.contains(CellFlags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let inverse = cell.flags.contains(CellFlags::INVERSE);
                let mut fg = resolve_rgb(cell.fg, true);
                let mut bg = resolve_bg(cell.bg);
                if inverse {
                    let old_fg = fg;
                    fg = bg.map(|c| [(c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8])
                        .unwrap_or([20, 20, 22]);
                    bg = Some([
                        old_fg[0] as f32 / 255.0,
                        old_fg[1] as f32 / 255.0,
                        old_fg[2] as f32 / 255.0,
                        1.0,
                    ]);
                }

                let cell_width = if cell.flags.contains(CellFlags::WIDE_CHAR) { 2 } else { 1 };
                if let Some(bg_col) = bg {
                    match &mut cur_bg {
                        Some((start, len, color)) if *start + *len == col && *color == bg_col => {
                            *len += cell_width;
                        }
                        _ => {
                            if let Some((start, len, color)) = cur_bg.take() {
                                bg_runs.push(BgRun { row: vis_row, col: start, len, color });
                            }
                            cur_bg = Some((col, cell_width, bg_col));
                        }
                    }
                } else if let Some((start, len, color)) = cur_bg.take() {
                    bg_runs.push(BgRun { row: vis_row, col: start, len, color });
                }

                let ch = cell.c;
                if ch == ' ' || ch == '\0' {
                    if let Some(span) = cur_span.take() {
                        row_spans.push(span);
                    }
                    continue;
                }
                let bold = cell.flags.contains(CellFlags::BOLD);
                let italic = cell.flags.contains(CellFlags::ITALIC);
                let can_merge = cur_span.as_ref().is_some_and(|s| {
                    s.fg == fg && s.bold == bold && s.italic == italic
                });
                if can_merge {
                    if let Some(span) = &mut cur_span {
                        span.text.push(ch);
                        if let Some(zw) = cell.zerowidth() {
                            for &z in zw {
                                span.text.push(z);
                            }
                        }
                    }
                } else {
                    if let Some(span) = cur_span.take() {
                        row_spans.push(span);
                    }
                    let mut text = String::with_capacity(8);
                    text.push(ch);
                    if let Some(zw) = cell.zerowidth() {
                        for &z in zw {
                            text.push(z);
                        }
                    }
                    cur_span = Some(StyledSpan {
                        col,
                        text,
                        fg,
                        bold,
                        italic,
                    });
                }
            }
            if let Some(span) = cur_span.take() {
                row_spans.push(span);
            }
            if let Some((start, len, color)) = cur_bg.take() {
                bg_runs.push(BgRun { row: vis_row, col: start, len, color });
            }
            spans_by_row.push(row_spans);
        }

        let cursor = if display_offset == 0 && self.term.mode().contains(TermMode::SHOW_CURSOR) {
            let pt = grid.cursor.point;
            if pt.line.0 >= 0 && (pt.line.0 as usize) < rows {
                Some((pt.column.0, pt.line.0 as usize))
            } else {
                None
            }
        } else {
            None
        };

        RenderFrame {
            spans_by_row,
            bg_runs,
            cursor,
            display_offset,
        }
    }
}

fn resolve_rgb(color: AnsiColor, is_fg: bool) -> [u8; 3] {
    match color {
        AnsiColor::Spec(Rgb { r, g, b }) => [r, g, b],
        AnsiColor::Indexed(idx) => indexed_to_rgb(idx),
        AnsiColor::Named(named) => match named {
            NamedColor::Foreground | NamedColor::BrightForeground => FG_DEFAULT,
            NamedColor::Background => [19, 20, 21],
            NamedColor::Black => ANSI_16[0],
            NamedColor::Red => ANSI_16[1],
            NamedColor::Green => ANSI_16[2],
            NamedColor::Yellow => ANSI_16[3],
            NamedColor::Blue => ANSI_16[4],
            NamedColor::Magenta => ANSI_16[5],
            NamedColor::Cyan => ANSI_16[6],
            NamedColor::White => ANSI_16[7],
            NamedColor::BrightBlack | NamedColor::DimBlack => ANSI_16[8],
            NamedColor::BrightRed | NamedColor::DimRed => ANSI_16[9],
            NamedColor::BrightGreen | NamedColor::DimGreen => ANSI_16[10],
            NamedColor::BrightYellow | NamedColor::DimYellow => ANSI_16[11],
            NamedColor::BrightBlue | NamedColor::DimBlue => ANSI_16[12],
            NamedColor::BrightMagenta | NamedColor::DimMagenta => ANSI_16[13],
            NamedColor::BrightCyan | NamedColor::DimCyan => ANSI_16[14],
            NamedColor::BrightWhite | NamedColor::DimWhite => ANSI_16[15],
            _ => {
                if is_fg {
                    FG_DEFAULT
                } else {
                    [19, 20, 21]
                }
            }
        },
    }
}

fn resolve_bg(color: AnsiColor) -> Option<[f32; 4]> {
    match color {
        AnsiColor::Named(NamedColor::Background) => None,
        other => {
            let rgb = resolve_rgb(other, false);
            Some([
                rgb[0] as f32 / 255.0,
                rgb[1] as f32 / 255.0,
                rgb[2] as f32 / 255.0,
                1.0,
            ])
        }
    }
}

fn indexed_to_rgb(idx: u8) -> [u8; 3] {
    if (idx as usize) < 16 {
        return ANSI_16[idx as usize];
    }
    if idx < 232 {
        let n = idx - 16;
        let r = n / 36;
        let g = (n % 36) / 6;
        let b = n % 6;
        let level = |v: u8| if v == 0 { 0 } else { 55 + v * 40 };
        return [level(r), level(g), level(b)];
    }
    let gray = 8 + (idx - 232) * 10;
    [gray, gray, gray]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_terminal_feeds_truecolor_cjk_and_local_scrollback() {
        let mut term = NativeTerminal::new(80, 10);
        for i in 0..30 {
            term.feed(format!("\x1b[38;2;255;128;0m行{}\x1b[0m\r\n", i).as_bytes());
        }
        let live = term.snapshot_frame();
        assert_eq!(live.display_offset, 0);
        assert!(live.spans_by_row.iter().flatten().any(|s| s.text.contains("行29")));

        term.scroll_local(15);
        let scrolled = term.snapshot_frame();
        assert!(scrolled.display_offset > 0);
        assert!(scrolled.spans_by_row.iter().flatten().any(|s| s.text.contains("行10")));

        term.snap_to_bottom();
        assert_eq!(term.snapshot_frame().display_offset, 0);
    }
}
