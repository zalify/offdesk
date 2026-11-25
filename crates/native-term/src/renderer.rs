use crate::layout::{LayoutRect, StageLayout};
use crate::terminal::{RenderFrame, BG_DEFAULT, CURSOR_COLOR};
use bytemuck::{Pod, Zeroable};
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use std::collections::HashMap;

pub const SIDEBAR_WIDTH: f32 = 240.0;
pub const TOPBAR_HEIGHT: f32 = 34.0;
pub const PANE_HEADER_HEIGHT: f32 = 24.0;
pub const SHELF_HEIGHT: f32 = 28.0;
pub const STATUSBAR_HEIGHT: f32 = 26.0;
pub const LAYOUT_BTN_W: f32 = 28.0;
pub const LAYOUT_BTN_GAP: f32 = 4.0;
pub const SHELF_PILL_W: f32 = 148.0;
pub const SHELF_PILL_GAP: f32 = 6.0;

#[repr(C)]
#[derive(Copy, Clone, Pod, Zeroable)]
struct QuadVertex {
    pos: [f32; 2],
    color: [f32; 4],
}

const QUAD_SHADER: &str = r#"
struct VertexOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec2<f32>, @location(1) color: vec4<f32>) -> VertexOut {
    var out: VertexOut;
    out.pos = vec4<f32>(pos, 0.0, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    return in.color;
}
"#;

pub enum SidebarItem {
    GroupHeader {
        group: String,
        count: usize,
        waiting_count: usize,
        collapsed: bool,
        focused: bool,
    },
    Terminal {
        id: String,
        label: String,
        subtitle: String,
        active: bool,
        waiting: bool,
        minimized: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SidebarHitAction {
    ToggleGroup(String),
    FocusGroup(String),
    SelectTerminal(String),
}

pub struct ShelfPill {
    pub terminal_id: String,
    pub label: String,
    pub waiting: bool,
    pub working: bool,
}

pub struct PaneSnapshot<'a> {
    pub terminal_id: &'a str,
    pub title: &'a str,
    pub rect: LayoutRect,
    pub active: bool,
    pub is_master: bool,
    pub frame: Option<&'a RenderFrame>,
}

pub struct PaletteOverlay<'a> {
    pub query: &'a str,
    pub rows: &'a [(String, String, bool)],
    pub selected: usize,
}

pub struct UiSnapshot<'a> {
    pub sidebar_rows: &'a [SidebarItem],
    pub header_title: &'a str,
    pub layout: StageLayout,
    pub panes: &'a [PaneSnapshot<'a>],
    pub shelf_pills: &'a [ShelfPill],
    pub status_left: &'a str,
    pub status_right: &'a str,
    pub palette: Option<PaletteOverlay<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneHitAction {
    Focus(String),
    Minimize(String),
    SwapToMaster(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SpanCacheKey {
    font_size_tenths: u16,
    line_height_tenths: u16,
    weight: u16,
    italic: bool,
    text: String,
}

struct CachedBuffer {
    buffer: Buffer,
    last_used_frame: u64,
}

/// Generational cache of shaped `glyphon::Buffer` instances so unchanged terminal rows,
/// sidebar rows, pane headers, and status labels skip HarfBuzz/cosmic-text shaping.
struct TextBufferCache {
    entries: HashMap<SpanCacheKey, CachedBuffer>,
    frame_seq: u64,
}

impl TextBufferCache {
    fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(512),
            frame_seq: 0,
        }
    }

    fn begin_frame(&mut self) {
        self.frame_seq = self.frame_seq.wrapping_add(1);
    }

    fn ensure(
        &mut self,
        font_system: &mut FontSystem,
        text: &str,
        metrics: Metrics,
        weight: Weight,
        italic: bool,
    ) -> SpanCacheKey {
        let key = SpanCacheKey {
            font_size_tenths: (metrics.font_size * 10.0).round() as u16,
            line_height_tenths: (metrics.line_height * 10.0).round() as u16,
            weight: weight.0,
            italic,
            text: text.to_string(),
        };
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.last_used_frame = self.frame_seq;
        } else {
            let buffer = make_buffer(font_system, text, metrics, weight, italic);
            self.entries.insert(
                key.clone(),
                CachedBuffer {
                    buffer,
                    last_used_frame: self.frame_seq,
                },
            );
        }
        key
    }

    fn get(&self, key: &SpanCacheKey) -> Option<&Buffer> {
        self.entries.get(key).map(|e| &e.buffer)
    }

    fn evict_stale(&mut self) {
        if self.entries.len() > 512 {
            let cutoff = self.frame_seq.saturating_sub(120);
            self.entries.retain(|_, v| v.last_used_frame >= cutoff);
        }
    }
}

struct DrawTextCmd {
    key: SpanCacheKey,
    left: f32,
    top: f32,
    color: Color,
    bounds: TextBounds,
}

/// Platform-independent GPU renderer backed by `wgpu` + `glyphon`.
///
/// Works identically across:
/// - Desktop (`winit::Window` on macOS Metal / Linux Vulkan / Windows DX12)
/// - Android (`ANativeWindow` from `SurfaceView` via Vulkan/GLES)
/// - iOS (`CAMetalLayer` from `UIView` / SwiftUI via Metal)
pub struct GpuRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    quad_pipeline: wgpu::RenderPipeline,
    quad_buffer: wgpu::Buffer,
    quad_buffer_cap: usize,
    quad_scratch: Vec<QuadVertex>,
    text_cache: TextBufferCache,
    font_system: FontSystem,
    swash_cache: SwashCache,
    atlas: TextAtlas,
    viewport: Viewport,
    text_renderer: TextRenderer,
    pub font_size: f32,
    pub cell_width: f32,
    pub cell_height: f32,
}

impl GpuRenderer {
    /// Create a renderer attached to any `wgpu::Surface<'static>` (desktop window,
    /// Android `ANativeWindow`, or iOS `CAMetalLayer`).
    pub fn from_surface(
        instance: wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
        font_size: f32,
    ) -> Result<Self, String> {
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .ok_or_else(|| "No compatible GPU adapter found".to_string())?;

        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("offdesk-native-gpu"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits()),
                memory_hints: wgpu::MemoryHints::Performance,
            },
            None,
        ))
        .map_err(|e| format!("request_device: {e}"))?;

        let caps = surface.get_capabilities(&adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| !f.is_srgb())
            .unwrap_or(caps.formats[0]);

        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: width.max(1),
            height: height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 1,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("quad-shader"),
            source: wgpu::ShaderSource::Wgsl(QUAD_SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("quad-layout"),
            bind_group_layouts: &[],
            push_constant_ranges: &[],
        });
        let quad_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("quad-pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<QuadVertex>() as wgpu::BufferAddress,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x4],
                }],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(&device);
        let mut viewport = Viewport::new(&device, &cache);
        viewport.update(
            &queue,
            Resolution {
                width: config.width,
                height: config.height,
            },
        );
        let mut atlas = TextAtlas::new(&device, &queue, &cache, format);
        let text_renderer =
            TextRenderer::new(&mut atlas, &device, wgpu::MultisampleState::default(), None);

        let (cell_width, cell_height) = measure_mono_cell(&mut font_system, font_size);
        let initial_quad_cap = 4096usize;
        let quad_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("quad-vbuf"),
            size: (initial_quad_cap * std::mem::size_of::<QuadVertex>()) as u64,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        Ok(Self {
            surface,
            device,
            queue,
            config,
            quad_pipeline,
            quad_buffer,
            quad_buffer_cap: initial_quad_cap,
            quad_scratch: Vec::with_capacity(initial_quad_cap),
            text_cache: TextBufferCache::new(),
            font_system,
            swash_cache,
            atlas,
            viewport,
            text_renderer,
            font_size,
            cell_width,
            cell_height,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        if width == 0 || height == 0 {
            return;
        }
        self.config.width = width;
        self.config.height = height;
        self.surface.configure(&self.device, &self.config);
        self.viewport.update(&self.queue, Resolution { width, height });
    }

    pub fn set_font_size(&mut self, font_size: f32) {
        self.font_size = font_size.clamp(10.0, 40.0);
        let (cw, ch) = measure_mono_cell(&mut self.font_system, self.font_size);
        self.cell_width = cw;
        self.cell_height = ch;
    }

    /// Compute the stage rectangle available for foreground panes.
    pub fn stage_rect(&self, has_shelf: bool) -> LayoutRect {
        let shelf_h = if has_shelf { SHELF_HEIGHT } else { 0.0 };
        LayoutRect {
            x: SIDEBAR_WIDTH + 1.0,
            y: TOPBAR_HEIGHT + 1.0,
            w: (self.config.width as f32 - SIDEBAR_WIDTH - 1.0).max(160.0),
            h: (self.config.height as f32 - TOPBAR_HEIGHT - STATUSBAR_HEIGHT - shelf_h - 2.0)
                .max(100.0),
        }
    }

    /// Compute exact terminal (cols, rows) for a given pane rectangle.
    pub fn pane_grid_size(&self, pane: LayoutRect) -> (u16, u16) {
        let term_w = (pane.w - 14.0).max(80.0);
        let term_h = (pane.h - PANE_HEADER_HEIGHT - 10.0).max(60.0);
        let cols = (term_w / self.cell_width).floor().max(20.0) as u16;
        let rows = (term_h / self.cell_height).floor().max(6.0) as u16;
        (cols, rows)
    }

    /// Compute exact terminal (cols, rows) that fit inside a single full-stage pane.
    pub fn terminal_grid_size(&self) -> (u16, u16) {
        self.pane_grid_size(self.stage_rect(false))
    }

    /// Hit-test the 4 clickable layout switcher icons in the top-right of the topbar.
    pub fn hit_test_layout_button(&self, px: f32, py: f32) -> Option<StageLayout> {
        if py > TOPBAR_HEIGHT {
            return None;
        }
        let w = self.config.width as f32;
        let total_w = StageLayout::ALL.len() as f32 * LAYOUT_BTN_W
            + (StageLayout::ALL.len() as f32 - 1.0) * LAYOUT_BTN_GAP;
        let start_x = w - 10.0 - total_w;
        for (i, layout) in StageLayout::ALL.iter().enumerate() {
            let bx = start_x + i as f32 * (LAYOUT_BTN_W + LAYOUT_BTN_GAP);
            if px >= bx && px <= bx + LAYOUT_BTN_W && py >= 4.0 && py <= TOPBAR_HEIGHT - 4.0 {
                return Some(*layout);
            }
        }
        None
    }

    /// Hit-test a clickable pill in the Background Shelf bar.
    pub fn hit_test_shelf_pill(&self, px: f32, py: f32, pills: &[ShelfPill]) -> Option<String> {
        if pills.is_empty() {
            return None;
        }
        let h = self.config.height as f32;
        let shelf_y = h - STATUSBAR_HEIGHT - SHELF_HEIGHT;
        if py < shelf_y || py > h - STATUSBAR_HEIGHT || px < SIDEBAR_WIDTH {
            return None;
        }
        let mut x = SIDEBAR_WIDTH + 8.0;
        for pill in pills {
            if px >= x && px <= x + SHELF_PILL_W {
                return Some(pill.terminal_id.clone());
            }
            x += SHELF_PILL_W + SHELF_PILL_GAP;
        }
        None
    }

    /// Hit-test sidebar rows (project group toggle, `[▶]` focus-group, or terminal selection).
    pub fn hit_test_sidebar(&self, px: f32, py: f32, rows: &[SidebarItem]) -> Option<SidebarHitAction> {
        if px >= SIDEBAR_WIDTH || py < 38.0 {
            return None;
        }
        let idx = ((py - 38.0) / 28.0).floor() as usize;
        match rows.get(idx)? {
            SidebarItem::GroupHeader { group, .. } => {
                if px >= SIDEBAR_WIDTH - 34.0 {
                    Some(SidebarHitAction::FocusGroup(group.clone()))
                } else {
                    Some(SidebarHitAction::ToggleGroup(group.clone()))
                }
            }
            SidebarItem::Terminal { id, .. } => Some(SidebarHitAction::SelectTerminal(id.clone())),
        }
    }

    /// Hit-test pane headers (`[—]` minimize, `[↖]` swap to master) and pane bodies (focus).
    pub fn hit_test_pane(
        &self,
        px: f32,
        py: f32,
        panes: &[(String, LayoutRect, bool)],
    ) -> Option<PaneHitAction> {
        for (id, rect, is_master) in panes {
            if !rect.contains(px, py) {
                continue;
            }
            if py <= rect.y + PANE_HEADER_HEIGHT {
                let min_x = rect.x + rect.w - 26.0;
                if px >= min_x {
                    return Some(PaneHitAction::Minimize(id.clone()));
                }
                if !*is_master {
                    let swap_x = rect.x + rect.w - 50.0;
                    if px >= swap_x && px < min_x {
                        return Some(PaneHitAction::SwapToMaster(id.clone()));
                    }
                }
            }
            return Some(PaneHitAction::Focus(id.clone()));
        }
        None
    }

    /// Compute exact terminal (cols, rows) for a full-bleed mobile surface
    /// where native UI (SwiftUI / Jetpack Compose) draws the surrounding chrome.
    pub fn full_bleed_grid_size(&self, padding_x: f32, padding_y: f32) -> (u16, u16) {
        let term_w = (self.config.width as f32 - padding_x * 2.0).max(80.0);
        let term_h = (self.config.height as f32 - padding_y * 2.0).max(60.0);
        let cols = (term_w / self.cell_width).floor().max(20.0) as u16;
        let rows = (term_h / self.cell_height).floor().max(6.0) as u16;
        (cols, rows)
    }

    /// Render ONLY the terminal grid full-bleed (for Android `SurfaceView` and
    /// iOS `CAMetalLayer` embedded inside native mobile shells).
    pub fn render_terminal_only(
        &mut self,
        frame: Option<&RenderFrame>,
        padding_x: f32,
        padding_y: f32,
    ) -> Result<(), String> {
        let w = self.config.width as f32;
        let h = self.config.height as f32;
        self.quad_scratch.clear();
        self.text_cache.begin_frame();
        let mut draw_cmds: Vec<DrawTextCmd> = Vec::with_capacity(256);
        let term_metrics = Metrics::new(self.font_size, self.cell_height);
        let term_bounds = TextBounds {
            left: padding_x as i32,
            top: padding_y as i32,
            right: (w - padding_x).max(padding_x) as i32,
            bottom: (h - padding_y).max(padding_y) as i32,
        };

        if let Some(frame) = frame {
            for run in &frame.bg_runs {
                let rx = padding_x + run.col as f32 * self.cell_width;
                let ry = padding_y + run.row as f32 * self.cell_height;
                push_rect(
                    &mut self.quad_scratch,
                    w,
                    h,
                    rx,
                    ry,
                    run.len as f32 * self.cell_width,
                    self.cell_height,
                    run.color,
                );
            }
            if let Some((cx, cy)) = frame.cursor {
                push_rect(
                    &mut self.quad_scratch,
                    w,
                    h,
                    padding_x + cx as f32 * self.cell_width,
                    padding_y + cy as f32 * self.cell_height,
                    self.cell_width,
                    self.cell_height,
                    CURSOR_COLOR,
                );
            }
            for (row_idx, spans) in frame.spans_by_row.iter().enumerate() {
                let y = padding_y + row_idx as f32 * self.cell_height;
                for span in spans {
                    let x = padding_x + span.col as f32 * self.cell_width;
                    let weight = if span.bold { Weight::BOLD } else { Weight::NORMAL };
                    let key = self.text_cache.ensure(
                        &mut self.font_system,
                        &span.text,
                        term_metrics,
                        weight,
                        span.italic,
                    );
                    draw_cmds.push(DrawTextCmd {
                        key,
                        left: x,
                        top: y,
                        color: Color::rgb(span.fg[0], span.fg[1], span.fg[2]),
                        bounds: term_bounds,
                    });
                }
            }
        }

        self.present_pass(&draw_cmds)
    }

    /// Render the full desktop workspace (sidebar, topbar + layout switcher, multi-pane stage,
    /// Background Shelf pills, statusbar, Cmd+K palette).
    pub fn render(&mut self, ui: UiSnapshot<'_>) -> Result<(), String> {
        let w = self.config.width as f32;
        let h = self.config.height as f32;
        let mut quads = std::mem::take(&mut self.quad_scratch);
        quads.clear();
        let has_shelf = !ui.shelf_pills.is_empty();
        let shelf_y = h - STATUSBAR_HEIGHT - SHELF_HEIGHT;

        // Sidebar, topbar, statusbar chrome backgrounds.
        push_rect(&mut quads, w, h, 0.0, 0.0, SIDEBAR_WIDTH, h - STATUSBAR_HEIGHT, [0.095, 0.098, 0.105, 1.0]);
        push_rect(&mut quads, w, h, SIDEBAR_WIDTH, 0.0, 1.0, h - STATUSBAR_HEIGHT, [0.18, 0.19, 0.21, 1.0]);
        push_rect(&mut quads, w, h, SIDEBAR_WIDTH + 1.0, 0.0, w - SIDEBAR_WIDTH, TOPBAR_HEIGHT, [0.09, 0.093, 0.10, 1.0]);
        push_rect(&mut quads, w, h, SIDEBAR_WIDTH + 1.0, TOPBAR_HEIGHT, w - SIDEBAR_WIDTH, 1.0, [0.18, 0.19, 0.21, 1.0]);
        push_rect(&mut quads, w, h, 0.0, h - STATUSBAR_HEIGHT, w, STATUSBAR_HEIGHT, [0.085, 0.088, 0.095, 1.0]);
        push_rect(&mut quads, w, h, 0.0, h - STATUSBAR_HEIGHT, w, 1.0, [0.18, 0.19, 0.21, 1.0]);

        // Topbar clickable layout switcher buttons ([▢] [◫] [◧] [⊞]).
        let total_layout_w = StageLayout::ALL.len() as f32 * LAYOUT_BTN_W
            + (StageLayout::ALL.len() as f32 - 1.0) * LAYOUT_BTN_GAP;
        let layout_start_x = w - 10.0 - total_layout_w;
        for (i, layout) in StageLayout::ALL.iter().enumerate() {
            let bx = layout_start_x + i as f32 * (LAYOUT_BTN_W + LAYOUT_BTN_GAP);
            let bg = if *layout == ui.layout {
                [0.24, 0.34, 0.52, 1.0]
            } else {
                [0.14, 0.15, 0.17, 1.0]
            };
            push_rect(&mut quads, w, h, bx, 5.0, LAYOUT_BTN_W, TOPBAR_HEIGHT - 10.0, bg);
        }

        // Sidebar items background + status dots (grouped by project).
        for (idx, row) in ui.sidebar_rows.iter().enumerate() {
            let y = 38.0 + idx as f32 * 28.0;
            if y + 26.0 > h - STATUSBAR_HEIGHT {
                break;
            }
            match row {
                SidebarItem::GroupHeader {
                    waiting_count,
                    focused,
                    ..
                } => {
                    let hdr_bg = if *focused {
                        [0.145, 0.165, 0.21, 1.0]
                    } else {
                        [0.115, 0.12, 0.132, 1.0]
                    };
                    push_rect(&mut quads, w, h, 4.0, y + 1.0, SIDEBAR_WIDTH - 8.0, 24.0, hdr_bg);
                    // Clickable [▶] focus-group button on right
                    push_rect(&mut quads, w, h, SIDEBAR_WIDTH - 30.0, y + 4.0, 22.0, 18.0, [0.18, 0.20, 0.24, 1.0]);
                    if *waiting_count > 0 {
                        push_rect(&mut quads, w, h, SIDEBAR_WIDTH - 44.0, y + 9.0, 7.0, 7.0, [0.95, 0.40, 0.35, 1.0]);
                    }
                }
                SidebarItem::Terminal {
                    active,
                    waiting,
                    minimized,
                    ..
                } => {
                    if *active {
                        push_rect(&mut quads, w, h, 10.0, y, SIDEBAR_WIDTH - 16.0, 24.0, [0.18, 0.20, 0.24, 1.0]);
                    }
                    if *waiting {
                        push_rect(&mut quads, w, h, 16.0, y + 8.0, 7.0, 7.0, [0.95, 0.42, 0.35, 1.0]);
                    } else if *active {
                        push_rect(&mut quads, w, h, 16.0, y + 8.0, 7.0, 7.0, [0.30, 0.82, 0.45, 1.0]);
                    } else if *minimized {
                        push_rect(&mut quads, w, h, 16.0, y + 10.0, 7.0, 3.0, [0.45, 0.65, 0.95, 1.0]);
                    }
                }
            }
        }

        // Multi-pane headers, active borders, cell backgrounds, and cursors.
        for pane in ui.panes {
            let r = pane.rect;
            // Pane header strip
            let hdr_bg = if pane.active {
                [0.115, 0.125, 0.145, 1.0]
            } else {
                [0.088, 0.092, 0.10, 1.0]
            };
            push_rect(&mut quads, w, h, r.x, r.y, r.w, PANE_HEADER_HEIGHT, hdr_bg);
            push_rect(&mut quads, w, h, r.x, r.y + PANE_HEADER_HEIGHT, r.w, 1.0, [0.16, 0.17, 0.19, 1.0]);
            if pane.active && ui.panes.len() > 1 {
                push_rect(&mut quads, w, h, r.x, r.y, r.w, 2.0, [0.45, 0.72, 0.98, 1.0]);
            }
            // Pane action button backgrounds: [↖] (secondary) and [—] (minimize)
            push_rect(&mut quads, w, h, r.x + r.w - 24.0, r.y + 3.0, 20.0, PANE_HEADER_HEIGHT - 6.0, [0.15, 0.16, 0.18, 1.0]);
            if !pane.is_master {
                push_rect(&mut quads, w, h, r.x + r.w - 48.0, r.y + 3.0, 20.0, PANE_HEADER_HEIGHT - 6.0, [0.15, 0.16, 0.18, 1.0]);
            }

            let term_x = r.x + 7.0;
            let term_y = r.y + PANE_HEADER_HEIGHT + 4.0;
            if let Some(frame) = pane.frame {
                for run in &frame.bg_runs {
                    let rx = term_x + run.col as f32 * self.cell_width;
                    let ry = term_y + run.row as f32 * self.cell_height;
                    if ry + self.cell_height <= r.y + r.h && rx < r.x + r.w {
                        push_rect(
                            &mut quads,
                            w,
                            h,
                            rx,
                            ry,
                            (run.len as f32 * self.cell_width).min(r.x + r.w - rx),
                            self.cell_height,
                            run.color,
                        );
                    }
                }
                if let Some((cx, cy)) = frame.cursor {
                    let rx = term_x + cx as f32 * self.cell_width;
                    let ry = term_y + cy as f32 * self.cell_height;
                    if ry + self.cell_height <= r.y + r.h && rx + self.cell_width <= r.x + r.w {
                        push_rect(
                            &mut quads,
                            w,
                            h,
                            rx,
                            ry,
                            self.cell_width,
                            self.cell_height,
                            if pane.active { CURSOR_COLOR } else { [0.45, 0.45, 0.50, 0.45] },
                        );
                    }
                }
            }
        }

        // Background Shelf bar (auto-hidden when empty).
        if has_shelf {
            push_rect(&mut quads, w, h, SIDEBAR_WIDTH + 1.0, shelf_y, w - SIDEBAR_WIDTH - 1.0, SHELF_HEIGHT, [0.095, 0.10, 0.115, 1.0]);
            push_rect(&mut quads, w, h, SIDEBAR_WIDTH + 1.0, shelf_y, w - SIDEBAR_WIDTH - 1.0, 1.0, [0.18, 0.19, 0.22, 1.0]);
            let mut px = SIDEBAR_WIDTH + 8.0;
            for pill in ui.shelf_pills {
                if px + SHELF_PILL_W > w - 8.0 {
                    break;
                }
                let bg = if pill.waiting {
                    [0.32, 0.14, 0.14, 1.0]
                } else {
                    [0.15, 0.165, 0.195, 1.0]
                };
                push_rect(&mut quads, w, h, px, shelf_y + 4.0, SHELF_PILL_W, SHELF_HEIGHT - 8.0, bg);
                let dot_color = if pill.waiting {
                    [0.95, 0.35, 0.35, 1.0]
                } else if pill.working {
                    [0.30, 0.85, 0.45, 1.0]
                } else {
                    [0.50, 0.54, 0.62, 1.0]
                };
                push_rect(&mut quads, w, h, px + 7.0, shelf_y + 11.0, 6.0, 6.0, dot_color);
                px += SHELF_PILL_W + SHELF_PILL_GAP;
            }
        }

        if let Some(pal) = &ui.palette {
            push_rect(&mut quads, w, h, 0.0, 0.0, w, h, [0.0, 0.0, 0.0, 0.45]);
            let pw = 560.0_f32.min(w - 40.0);
            let ph = (48.0 + pal.rows.len().min(12) as f32 * 30.0 + 16.0).min(h - 80.0);
            let px = (w - pw) * 0.5;
            let py = 72.0;
            push_rect(&mut quads, w, h, px, py, pw, ph, [0.12, 0.125, 0.14, 0.98]);
            push_rect(&mut quads, w, h, px, py + 42.0, pw, 1.0, [0.24, 0.25, 0.28, 1.0]);
            if pal.selected < pal.rows.len().min(12) {
                push_rect(
                    &mut quads,
                    w,
                    h,
                    px + 8.0,
                    py + 48.0 + pal.selected as f32 * 30.0,
                    pw - 16.0,
                    26.0,
                    [0.24, 0.44, 0.78, 0.9],
                );
            }
        }

        self.text_cache.begin_frame();
        let mut buffers: Vec<(SpanCacheKey, f32, f32, Color, TextBounds)> = Vec::with_capacity(512);
        let ui_metrics = Metrics::new(13.0, 18.0);
        let small_metrics = Metrics::new(11.5, 16.0);
        let term_metrics = Metrics::new(self.font_size, self.cell_height);

        buffers.push((
            self.text_cache.ensure(&mut self.font_system, "OFFDESK NATIVE", ui_metrics, Weight::BOLD, false),
            14.0,
            10.0,
            Color::rgb(150, 155, 165),
            TextBounds { left: 0, top: 0, right: SIDEBAR_WIDTH as i32, bottom: 34 },
        ));

        for (idx, row) in ui.sidebar_rows.iter().enumerate() {
            let y = 41.0 + idx as f32 * 28.0;
            if y + 20.0 > h - STATUSBAR_HEIGHT {
                break;
            }
            match row {
                SidebarItem::GroupHeader {
                    group,
                    count,
                    collapsed,
                    focused,
                    ..
                } => {
                    let chevron = if *collapsed { "▸" } else { "▾" };
                    let text = format!("{chevron} {group} ({count})");
                    let color = if *focused {
                        Color::rgb(235, 240, 250)
                    } else {
                        Color::rgb(175, 185, 200)
                    };
                    buffers.push((
                        self.text_cache.ensure(&mut self.font_system, &text, small_metrics, Weight::BOLD, false),
                        10.0,
                        y + 1.0,
                        color,
                        TextBounds {
                            left: 8,
                            top: y as i32,
                            right: (SIDEBAR_WIDTH - 48.0) as i32,
                            bottom: (y + 20.0) as i32,
                        },
                    ));
                    // [▶] focus-group glyph
                    buffers.push((
                        self.text_cache.ensure(&mut self.font_system, "▶", small_metrics, Weight::NORMAL, false),
                        SIDEBAR_WIDTH - 24.0,
                        y + 1.0,
                        Color::rgb(170, 185, 210),
                        TextBounds {
                            left: (SIDEBAR_WIDTH - 30.0) as i32,
                            top: y as i32,
                            right: (SIDEBAR_WIDTH - 8.0) as i32,
                            bottom: (y + 20.0) as i32,
                        },
                    ));
                }
                SidebarItem::Terminal {
                    label,
                    subtitle,
                    active,
                    waiting,
                    minimized,
                    ..
                } => {
                    let text = if subtitle.is_empty() {
                        label.clone()
                    } else {
                        format!("{label} · {subtitle}")
                    };
                    let color = if *active {
                        Color::rgb(245, 245, 250)
                    } else if *waiting {
                        Color::rgb(250, 175, 110)
                    } else if *minimized {
                        Color::rgb(130, 145, 175)
                    } else {
                        Color::rgb(170, 175, 185)
                    };
                    buffers.push((
                        self.text_cache.ensure(&mut self.font_system, &text, ui_metrics, if *active { Weight::SEMIBOLD } else { Weight::NORMAL }, false),
                        30.0,
                        y - 1.0,
                        color,
                        TextBounds {
                            left: 28,
                            top: y as i32,
                            right: (SIDEBAR_WIDTH - 10.0) as i32,
                            bottom: (y + 20.0) as i32,
                        },
                    ));
                }
            }
        }

        // Topbar title + layout icons
        buffers.push((
            self.text_cache.ensure(&mut self.font_system, ui.header_title, ui_metrics, Weight::MEDIUM, false),
            SIDEBAR_WIDTH + 14.0,
            8.0,
            Color::rgb(215, 220, 230),
            TextBounds {
                left: SIDEBAR_WIDTH as i32,
                top: 0,
                right: (layout_start_x - 10.0).max(SIDEBAR_WIDTH) as i32,
                bottom: TOPBAR_HEIGHT as i32,
            },
        ));
        for (i, layout) in StageLayout::ALL.iter().enumerate() {
            let bx = layout_start_x + i as f32 * (LAYOUT_BTN_W + LAYOUT_BTN_GAP);
            buffers.push((
                self.text_cache.ensure(&mut self.font_system, layout.icon_label(), ui_metrics, Weight::MEDIUM, false),
                bx + 8.0,
                8.0,
                if *layout == ui.layout { Color::rgb(255, 255, 255) } else { Color::rgb(155, 160, 170) },
                TextBounds {
                    left: bx as i32,
                    top: 0,
                    right: (bx + LAYOUT_BTN_W) as i32,
                    bottom: TOPBAR_HEIGHT as i32,
                },
            ));
        }

        // Multi-pane headers + terminal text spans
        for pane in ui.panes {
            let r = pane.rect;
            let dot = if pane.active { "● " } else { "○ " };
            let title_str = format!("{}{}", dot, pane.title);
            let action_reserve = if pane.is_master { 30.0 } else { 54.0 };
            buffers.push((
                self.text_cache.ensure(&mut self.font_system, &title_str, small_metrics, if pane.active { Weight::SEMIBOLD } else { Weight::NORMAL }, false),
                r.x + 8.0,
                r.y + 4.0,
                if pane.active { Color::rgb(235, 240, 248) } else { Color::rgb(155, 160, 170) },
                TextBounds {
                    left: r.x as i32,
                    top: r.y as i32,
                    right: (r.x + r.w - action_reserve).max(r.x) as i32,
                    bottom: (r.y + PANE_HEADER_HEIGHT) as i32,
                },
            ));
            // [—] minimize button glyph
            buffers.push((
                self.text_cache.ensure(&mut self.font_system, "—", small_metrics, Weight::BOLD, false),
                r.x + r.w - 19.0,
                r.y + 4.0,
                Color::rgb(185, 190, 200),
                TextBounds {
                    left: (r.x + r.w - 24.0) as i32,
                    top: r.y as i32,
                    right: (r.x + r.w - 4.0) as i32,
                    bottom: (r.y + PANE_HEADER_HEIGHT) as i32,
                },
            ));
            // [↖] swap-to-master button glyph on secondary panes
            if !pane.is_master {
                buffers.push((
                    self.text_cache.ensure(&mut self.font_system, "↖", small_metrics, Weight::BOLD, false),
                    r.x + r.w - 43.0,
                    r.y + 4.0,
                    Color::rgb(185, 190, 200),
                    TextBounds {
                        left: (r.x + r.w - 48.0) as i32,
                        top: r.y as i32,
                        right: (r.x + r.w - 28.0) as i32,
                        bottom: (r.y + PANE_HEADER_HEIGHT) as i32,
                    },
                ));
            }

            let term_x = r.x + 7.0;
            let term_y = r.y + PANE_HEADER_HEIGHT + 4.0;
            let term_bounds = TextBounds {
                left: r.x as i32,
                top: (r.y + PANE_HEADER_HEIGHT) as i32,
                right: (r.x + r.w - 2.0) as i32,
                bottom: (r.y + r.h - 2.0) as i32,
            };
            if let Some(frame) = pane.frame {
                for (row_idx, spans) in frame.spans_by_row.iter().enumerate() {
                    let y = term_y + row_idx as f32 * self.cell_height;
                    if y > r.y + r.h {
                        break;
                    }
                    for span in spans {
                        let x = term_x + span.col as f32 * self.cell_width;
                        let weight = if span.bold { Weight::BOLD } else { Weight::NORMAL };
                        buffers.push((
                            self.text_cache.ensure(&mut self.font_system, &span.text, term_metrics, weight, span.italic),
                            x,
                            y,
                            Color::rgb(span.fg[0], span.fg[1], span.fg[2]),
                            term_bounds,
                        ));
                    }
                }
            }
        }

        // Background Shelf pill labels
        if has_shelf {
            let mut px = SIDEBAR_WIDTH + 8.0;
            for pill in ui.shelf_pills {
                if px + SHELF_PILL_W > w - 8.0 {
                    break;
                }
                buffers.push((
                    self.text_cache.ensure(&mut self.font_system, &pill.label, small_metrics, if pill.waiting { Weight::SEMIBOLD } else { Weight::NORMAL }, false),
                    px + 18.0,
                    shelf_y + 6.0,
                    if pill.waiting { Color::rgb(255, 190, 180) } else { Color::rgb(205, 212, 224) },
                    TextBounds {
                        left: (px + 16.0) as i32,
                        top: shelf_y as i32,
                        right: (px + SHELF_PILL_W - 6.0) as i32,
                        bottom: (shelf_y + SHELF_HEIGHT) as i32,
                    },
                ));
                px += SHELF_PILL_W + SHELF_PILL_GAP;
            }
        }

        // Status bar
        buffers.push((
            self.text_cache.ensure(&mut self.font_system, ui.status_left, ui_metrics, Weight::NORMAL, false),
            12.0,
            h - STATUSBAR_HEIGHT + 4.0,
            Color::rgb(155, 160, 170),
            TextBounds { left: 8, top: (h - STATUSBAR_HEIGHT) as i32, right: (w * 0.65) as i32, bottom: h as i32 },
        ));
        buffers.push((
            self.text_cache.ensure(&mut self.font_system, ui.status_right, ui_metrics, Weight::NORMAL, false),
            (w - 280.0).max(SIDEBAR_WIDTH),
            h - STATUSBAR_HEIGHT + 4.0,
            Color::rgb(155, 160, 170),
            TextBounds { left: (w - 290.0).max(SIDEBAR_WIDTH) as i32, top: (h - STATUSBAR_HEIGHT) as i32, right: w as i32 - 8, bottom: h as i32 },
        ));

        if let Some(pal) = &ui.palette {
            let pw = 560.0_f32.min(w - 40.0);
            let px = (w - pw) * 0.5;
            let py = 72.0;
            let prompt = if pal.query.is_empty() {
                ": search terminals (⌘K)…".to_string()
            } else {
                format!(": {}", pal.query)
            };
            buffers.push((
                self.text_cache.ensure(&mut self.font_system, &prompt, Metrics::new(15.0, 22.0), Weight::MEDIUM, false),
                px + 14.0,
                py + 10.0,
                Color::rgb(245, 245, 250),
                TextBounds { left: px as i32, top: py as i32, right: (px + pw - 12.0) as i32, bottom: (py + 42.0) as i32 },
            ));
            for (idx, (label, meta, waiting)) in pal.rows.iter().take(12).enumerate() {
                let ry = py + 52.0 + idx as f32 * 30.0;
                let line = if *waiting {
                    format!("[waiting] {}  ·  {}", label, meta)
                } else {
                    format!("{}  ·  {}", label, meta)
                };
                buffers.push((
                    self.text_cache.ensure(&mut self.font_system, &line, ui_metrics, if idx == pal.selected { Weight::BOLD } else { Weight::NORMAL }, false),
                    px + 16.0,
                    ry,
                    if idx == pal.selected { Color::rgb(255, 255, 255) } else { Color::rgb(210, 215, 225) },
                    TextBounds { left: (px + 10.0) as i32, top: ry as i32, right: (px + pw - 12.0) as i32, bottom: (ry + 24.0) as i32 },
                ));
            }
        }

        self.quad_scratch = quads;
        let draw_cmds: Vec<DrawTextCmd> = buffers
            .into_iter()
            .map(|(key, left, top, color, bounds)| DrawTextCmd {
                key,
                left,
                top,
                color,
                bounds,
            })
            .collect();
        self.present_pass(&draw_cmds)
    }

    fn present_pass(&mut self, draw_cmds: &[DrawTextCmd]) -> Result<(), String> {
        let text_areas: Vec<TextArea<'_>> = draw_cmds
            .iter()
            .filter_map(|cmd| {
                let buf = self.text_cache.get(&cmd.key)?;
                Some(TextArea {
                    buffer: buf,
                    left: cmd.left,
                    top: cmd.top,
                    scale: 1.0,
                    bounds: cmd.bounds,
                    default_color: cmd.color,
                    custom_glyphs: &[],
                })
            })
            .collect();

        self.text_renderer
            .prepare(
                &self.device,
                &self.queue,
                &mut self.font_system,
                &mut self.atlas,
                &self.viewport,
                text_areas,
                &mut self.swash_cache,
            )
            .map_err(|e| format!("text prepare: {e:?}"))?;

        let frame = self
            .surface
            .get_current_texture()
            .map_err(|e| format!("surface texture: {e}"))?;
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let quad_count = self.quad_scratch.len();
        if quad_count > 0 {
            if quad_count > self.quad_buffer_cap {
                self.quad_buffer_cap = quad_count.next_power_of_two();
                self.quad_buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("quad-vbuf"),
                    size: (self.quad_buffer_cap * std::mem::size_of::<QuadVertex>()) as u64,
                    usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
            }
            self.queue.write_buffer(
                &self.quad_buffer,
                0,
                bytemuck::cast_slice(&self.quad_scratch),
            );
        }

        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: BG_DEFAULT[0] as f64,
                            g: BG_DEFAULT[1] as f64,
                            b: BG_DEFAULT[2] as f64,
                            a: 1.0,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
            });
            if quad_count > 0 {
                pass.set_pipeline(&self.quad_pipeline);
                pass.set_vertex_buffer(0, self.quad_buffer.slice(..));
                pass.draw(0..quad_count as u32, 0..1);
            }
            let _ = self.text_renderer.render(&self.atlas, &self.viewport, &mut pass);
        }

        self.queue.submit(Some(encoder.finish()));
        frame.present();
        self.text_cache.evict_stale();
        if self.text_cache.frame_seq % 60 == 0 {
            self.atlas.trim();
        }
        Ok(())
    }
}

fn push_rect(
    quads: &mut Vec<QuadVertex>,
    w: f32,
    h: f32,
    x: f32,
    y: f32,
    rw: f32,
    rh: f32,
    c: [f32; 4],
) {
    let x0 = (x / w) * 2.0 - 1.0;
    let y0 = 1.0 - (y / h) * 2.0;
    let x1 = ((x + rw) / w) * 2.0 - 1.0;
    let y1 = 1.0 - ((y + rh) / h) * 2.0;
    quads.extend_from_slice(&[
        QuadVertex { pos: [x0, y0], color: c },
        QuadVertex { pos: [x1, y0], color: c },
        QuadVertex { pos: [x1, y1], color: c },
        QuadVertex { pos: [x0, y0], color: c },
        QuadVertex { pos: [x1, y1], color: c },
        QuadVertex { pos: [x0, y1], color: c },
    ]);
}

fn make_buffer(
    font_system: &mut FontSystem,
    text: &str,
    metrics: Metrics,
    weight: Weight,
    italic: bool,
) -> Buffer {
    let mut buf = Buffer::new(font_system, metrics);
    let attrs = Attrs::new()
        .family(Family::Monospace)
        .weight(weight)
        .style(if italic { Style::Italic } else { Style::Normal });
    buf.set_text(font_system, text, attrs, Shaping::Advanced);
    buf.shape_until_scroll(font_system, false);
    buf
}

fn measure_mono_cell(font_system: &mut FontSystem, font_size: f32) -> (f32, f32) {
    let line_height = (font_size * 1.32).round();
    let mut buf = Buffer::new(font_system, Metrics::new(font_size, line_height));
    buf.set_text(
        font_system,
        "MMMMMMMMMM",
        Attrs::new().family(Family::Monospace),
        Shaping::Advanced,
    );
    buf.shape_until_scroll(font_system, false);
    let width = buf
        .layout_runs()
        .next()
        .map(|run| run.line_w / 10.0)
        .filter(|w| *w > 4.0)
        .unwrap_or(font_size * 0.6);
    (width, line_height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_buffer_cache_reuses_shaped_buffers_and_evicts_stale() {
        let mut font_system = FontSystem::new();
        let mut cache = TextBufferCache::new();
        let metrics = Metrics::new(14.0, 18.0);

        cache.begin_frame();
        let t0 = std::time::Instant::now();
        let mut keys = Vec::new();
        for i in 0..80 {
            keys.push(cache.ensure(
                &mut font_system,
                &format!("agent-line-{i}: 构建完成 ✓ 耗时 12ms"),
                metrics,
                Weight::NORMAL,
                false,
            ));
        }
        let cold_us = t0.elapsed().as_micros();
        assert_eq!(cache.entries.len(), 80);

        // Next frame with identical spans: 100% cache hit, zero shaping!
        cache.begin_frame();
        let t1 = std::time::Instant::now();
        for i in 0..80 {
            let k = cache.ensure(
                &mut font_system,
                &format!("agent-line-{i}: 构建完成 ✓ 耗时 12ms"),
                metrics,
                Weight::NORMAL,
                false,
            );
            assert!(cache.get(&k).is_some());
        }
        let warm_us = t1.elapsed().as_micros();
        assert_eq!(cache.entries.len(), 80);
        println!(
            "[perf] TextBufferCache 80 CJK+ASCII spans: cold={cold_us}µs, warm={warm_us}µs ({:.1}x faster)",
            cold_us as f64 / warm_us.max(1) as f64
        );

        // Advance > 120 frames with > 512 entries to verify stale eviction bounds memory.
        for frame in 0..130 {
            cache.begin_frame();
            for j in 0..5 {
                let _ = cache.ensure(
                    &mut font_system,
                    &format!("ephemeral-{frame}-{j}"),
                    metrics,
                    Weight::NORMAL,
                    false,
                );
            }
            cache.evict_stale();
        }
        assert!(cache.get(&keys[0]).is_none(), "stale entries older than 120 frames should be evicted");
    }
}
