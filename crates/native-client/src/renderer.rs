use crate::terminal::{RenderFrame, BG_DEFAULT, CURSOR_COLOR};
use bytemuck::{Pod, Zeroable};
use glyphon::{
    Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, Style,
    SwashCache, TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
};
use std::sync::Arc;
use wgpu::util::DeviceExt;
use winit::window::Window;

pub const SIDEBAR_WIDTH: f32 = 240.0;
pub const TOPBAR_HEIGHT: f32 = 34.0;
pub const STATUSBAR_HEIGHT: f32 = 26.0;

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

pub struct SidebarRow {
    pub label: String,
    pub subtitle: String,
    pub active: bool,
    pub waiting: bool,
}

pub struct PaletteOverlay<'a> {
    pub query: &'a str,
    pub rows: &'a [(String, String, bool)],
    pub selected: usize,
}

pub struct UiSnapshot<'a> {
    pub sidebar_rows: &'a [SidebarRow],
    pub header_title: &'a str,
    pub status_left: &'a str,
    pub status_right: &'a str,
    pub frame: Option<&'a RenderFrame>,
    pub palette: Option<PaletteOverlay<'a>>,
}

pub struct GpuRenderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    quad_pipeline: wgpu::RenderPipeline,
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
    pub fn new(window: Arc<Window>, font_size: f32) -> Result<Self, String> {
        let size = window.inner_size();
        let instance = wgpu::Instance::default();
        let surface = instance
            .create_surface(window)
            .map_err(|e| format!("create_surface: {e}"))?;
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
                required_limits: wgpu::Limits::downlevel_defaults(),
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
            width: size.width.max(1),
            height: size.height.max(1),
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

        Ok(Self {
            surface,
            device,
            queue,
            config,
            quad_pipeline,
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
        self.font_size = font_size.clamp(10.0, 28.0);
        let (cw, ch) = measure_mono_cell(&mut self.font_system, self.font_size);
        self.cell_width = cw;
        self.cell_height = ch;
    }

    /// Compute exact terminal (cols, rows) that fit inside the terminal pane.
    pub fn terminal_grid_size(&self) -> (u16, u16) {
        let term_w = (self.config.width as f32 - SIDEBAR_WIDTH - 16.0).max(160.0);
        let term_h =
            (self.config.height as f32 - TOPBAR_HEIGHT - STATUSBAR_HEIGHT - 12.0).max(100.0);
        let cols = (term_w / self.cell_width).floor().max(20.0) as u16;
        let rows = (term_h / self.cell_height).floor().max(8.0) as u16;
        (cols, rows)
    }

    pub fn render(&mut self, ui: UiSnapshot<'_>) -> Result<(), String> {
        let w = self.config.width as f32;
        let h = self.config.height as f32;

        let mut quads: Vec<QuadVertex> = Vec::with_capacity(2048);
        let push_rect = |quads: &mut Vec<QuadVertex>, x: f32, y: f32, rw: f32, rh: f32, c: [f32; 4]| {
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
        };

        // Sidebar, topbar, statusbar chrome backgrounds.
        push_rect(&mut quads, 0.0, 0.0, SIDEBAR_WIDTH, h - STATUSBAR_HEIGHT, [0.095, 0.098, 0.105, 1.0]);
        push_rect(&mut quads, SIDEBAR_WIDTH, 0.0, 1.0, h - STATUSBAR_HEIGHT, [0.18, 0.19, 0.21, 1.0]);
        push_rect(&mut quads, SIDEBAR_WIDTH + 1.0, 0.0, w - SIDEBAR_WIDTH, TOPBAR_HEIGHT, [0.09, 0.093, 0.10, 1.0]);
        push_rect(&mut quads, SIDEBAR_WIDTH + 1.0, TOPBAR_HEIGHT, w - SIDEBAR_WIDTH, 1.0, [0.18, 0.19, 0.21, 1.0]);
        push_rect(&mut quads, 0.0, h - STATUSBAR_HEIGHT, w, STATUSBAR_HEIGHT, [0.085, 0.088, 0.095, 1.0]);
        push_rect(&mut quads, 0.0, h - STATUSBAR_HEIGHT, w, 1.0, [0.18, 0.19, 0.21, 1.0]);

        // Sidebar active/waiting highlights.
        for (idx, row) in ui.sidebar_rows.iter().enumerate() {
            let y = 38.0 + idx as f32 * 30.0;
            if y + 28.0 > h - STATUSBAR_HEIGHT {
                break;
            }
            if row.active {
                push_rect(&mut quads, 6.0, y, SIDEBAR_WIDTH - 12.0, 26.0, [0.18, 0.20, 0.24, 1.0]);
            }
            if row.waiting {
                push_rect(&mut quads, 12.0, y + 9.0, 7.0, 7.0, [0.95, 0.65, 0.20, 1.0]);
            } else if row.active {
                push_rect(&mut quads, 12.0, y + 9.0, 7.0, 7.0, [0.30, 0.82, 0.45, 1.0]);
            }
        }

        let term_x = SIDEBAR_WIDTH + 8.0;
        let term_y = TOPBAR_HEIGHT + 6.0;

        // Terminal cell backgrounds + cursor.
        if let Some(frame) = ui.frame {
            for run in &frame.bg_runs {
                let rx = term_x + run.col as f32 * self.cell_width;
                let ry = term_y + run.row as f32 * self.cell_height;
                push_rect(
                    &mut quads,
                    rx,
                    ry,
                    run.len as f32 * self.cell_width,
                    self.cell_height,
                    run.color,
                );
            }
            if let Some((cx, cy)) = frame.cursor {
                push_rect(
                    &mut quads,
                    term_x + cx as f32 * self.cell_width,
                    term_y + cy as f32 * self.cell_height,
                    self.cell_width,
                    self.cell_height,
                    CURSOR_COLOR,
                );
            }
        }

        // Quick Switcher overlay background (Cmd+K).
        if let Some(pal) = &ui.palette {
            push_rect(&mut quads, 0.0, 0.0, w, h, [0.0, 0.0, 0.0, 0.45]);
            let pw = 560.0_f32.min(w - 40.0);
            let ph = (48.0 + pal.rows.len().min(12) as f32 * 30.0 + 16.0).min(h - 80.0);
            let px = (w - pw) * 0.5;
            let py = 72.0;
            push_rect(&mut quads, px, py, pw, ph, [0.12, 0.125, 0.14, 0.98]);
            push_rect(&mut quads, px, py + 42.0, pw, 1.0, [0.24, 0.25, 0.28, 1.0]);
            if pal.selected < pal.rows.len().min(12) {
                push_rect(
                    &mut quads,
                    px + 8.0,
                    py + 48.0 + pal.selected as f32 * 30.0,
                    pw - 16.0,
                    26.0,
                    [0.24, 0.44, 0.78, 0.9],
                );
            }
        }

        // Build glyphon text buffers.
        let mut buffers: Vec<(Buffer, f32, f32, Color, TextBounds)> = Vec::new();
        let ui_metrics = Metrics::new(13.0, 18.0);
        let term_metrics = Metrics::new(self.font_size, self.cell_height);

        // Sidebar title
        buffers.push((
            make_buffer(&mut self.font_system, "OFFDESK NATIVE", ui_metrics, Weight::BOLD, false),
            14.0,
            10.0,
            Color::rgb(150, 155, 165),
            TextBounds { left: 0, top: 0, right: SIDEBAR_WIDTH as i32, bottom: 34 },
        ));

        // Sidebar items
        for (idx, row) in ui.sidebar_rows.iter().enumerate() {
            let y = 42.0 + idx as f32 * 30.0;
            if y + 22.0 > h - STATUSBAR_HEIGHT {
                break;
            }
            let text = if row.subtitle.is_empty() {
                row.label.clone()
            } else {
                format!("{} · {}", row.label, row.subtitle)
            };
            let color = if row.active {
                Color::rgb(245, 245, 250)
            } else if row.waiting {
                Color::rgb(250, 190, 90)
            } else {
                Color::rgb(170, 175, 185)
            };
            buffers.push((
                make_buffer(&mut self.font_system, &text, ui_metrics, if row.active { Weight::SEMIBOLD } else { Weight::NORMAL }, false),
                26.0,
                y,
                color,
                TextBounds {
                    left: 24,
                    top: y as i32,
                    right: (SIDEBAR_WIDTH - 10.0) as i32,
                    bottom: (y + 22.0) as i32,
                },
            ));
        }

        // Top header bar
        buffers.push((
            make_buffer(&mut self.font_system, ui.header_title, ui_metrics, Weight::MEDIUM, false),
            SIDEBAR_WIDTH + 14.0,
            8.0,
            Color::rgb(215, 220, 230),
            TextBounds { left: SIDEBAR_WIDTH as i32, top: 0, right: w as i32 - 12, bottom: TOPBAR_HEIGHT as i32 },
        ));

        // Status bar
        buffers.push((
            make_buffer(&mut self.font_system, ui.status_left, ui_metrics, Weight::NORMAL, false),
            12.0,
            h - STATUSBAR_HEIGHT + 4.0,
            Color::rgb(155, 160, 170),
            TextBounds { left: 8, top: (h - STATUSBAR_HEIGHT) as i32, right: (w * 0.65) as i32, bottom: h as i32 },
        ));
        buffers.push((
            make_buffer(&mut self.font_system, ui.status_right, ui_metrics, Weight::NORMAL, false),
            (w - 280.0).max(SIDEBAR_WIDTH),
            h - STATUSBAR_HEIGHT + 4.0,
            Color::rgb(155, 160, 170),
            TextBounds { left: (w - 290.0).max(SIDEBAR_WIDTH) as i32, top: (h - STATUSBAR_HEIGHT) as i32, right: w as i32 - 8, bottom: h as i32 },
        ));

        // Terminal spans
        let term_bounds = TextBounds {
            left: term_x as i32,
            top: term_y as i32,
            right: w as i32 - 4,
            bottom: (h - STATUSBAR_HEIGHT) as i32,
        };
        if let Some(frame) = ui.frame {
            for (row_idx, spans) in frame.spans_by_row.iter().enumerate() {
                let y = term_y + row_idx as f32 * self.cell_height;
                for span in spans {
                    let x = term_x + span.col as f32 * self.cell_width;
                    let weight = if span.bold { Weight::BOLD } else { Weight::NORMAL };
                    buffers.push((
                        make_buffer(&mut self.font_system, &span.text, term_metrics, weight, span.italic),
                        x,
                        y,
                        Color::rgb(span.fg[0], span.fg[1], span.fg[2]),
                        term_bounds,
                    ));
                }
            }
        }

        // Quick switcher text
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
                make_buffer(&mut self.font_system, &prompt, Metrics::new(15.0, 22.0), Weight::MEDIUM, false),
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
                    make_buffer(&mut self.font_system, &line, ui_metrics, if idx == pal.selected { Weight::BOLD } else { Weight::NORMAL }, false),
                    px + 16.0,
                    ry,
                    if idx == pal.selected { Color::rgb(255, 255, 255) } else { Color::rgb(210, 215, 225) },
                    TextBounds { left: (px + 10.0) as i32, top: ry as i32, right: (px + pw - 12.0) as i32, bottom: (ry + 24.0) as i32 },
                ));
            }
        }

        let text_areas: Vec<TextArea<'_>> = buffers
            .iter()
            .map(|(buf, left, top, color, bounds)| TextArea {
                buffer: buf,
                left: *left,
                top: *top,
                scale: 1.0,
                bounds: *bounds,
                default_color: *color,
                custom_glyphs: &[],
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

        let vertex_buffer = if !quads.is_empty() {
            Some(self.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("quad-vbuf"),
                contents: bytemuck::cast_slice(&quads),
                usage: wgpu::BufferUsages::VERTEX,
            }))
        } else {
            None
        };

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
            if let Some(vb) = &vertex_buffer {
                pass.set_pipeline(&self.quad_pipeline);
                pass.set_vertex_buffer(0, vb.slice(..));
                pass.draw(0..quads.len() as u32, 0..1);
            }
            let _ = self.text_renderer.render(&self.atlas, &self.viewport, &mut pass);
        }

        self.queue.submit(Some(encoder.finish()));
        frame.present();
        self.atlas.trim();
        Ok(())
    }
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
