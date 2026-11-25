mod input;

use clap::Parser;
use input::{key_event_to_terminal_bytes, match_shortcut, AppShortcut};
use offdesk_term::config::ClientConfig;
use offdesk_term::hub::{self, HubCommand, HubEvent, MachineEntry, TerminalEntry};
use offdesk_term::layout::{compute_stage_rects, LayoutRect, StageLayout, StageState};
use offdesk_term::renderer::{
    GpuRenderer, PaletteOverlay, PaneHitAction, PaneSnapshot, ShelfPill, SidebarHitAction,
    SidebarItem, UiSnapshot,
};
use offdesk_term::terminal::{NativeTerminal, RenderFrame};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::mpsc;
use winit::application::ApplicationHandler;
use winit::dpi::LogicalSize;
use winit::event::{ElementState, Ime, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop, EventLoopProxy};
use winit::keyboard::{Key, ModifiersState, NamedKey};
use winit::window::{Window, WindowId};

#[derive(Parser)]
#[command(name = "offdesk-native", about = "Pure-Rust GPU native desktop client for Offdesk")]
struct Args {
    /// Hub base URL (defaults to ~/.config/offdesk/config.toml)
    #[arg(long)]
    hub_url: Option<String>,
    /// Auth token (defaults to ~/.config/offdesk/config.toml)
    #[arg(long)]
    token: Option<String>,
    /// Terminal font size in pixels
    #[arg(long, default_value_t = 14.0)]
    font_size: f32,
    /// Headless smoke test: connect to Hub, attach to first terminal, verify live alacritty_terminal render
    #[arg(long, default_value_t = false)]
    smoke: bool,
}

struct NativeApp {
    cfg: ClientConfig,
    hub_tx: mpsc::UnboundedSender<HubCommand>,
    window: Option<Arc<Window>>,
    renderer: Option<GpuRenderer>,
    machines: Vec<MachineEntry>,
    terminals: Vec<TerminalEntry>,
    /// Every visited terminal stays hot in memory (zero WebGL context limit!).
    live_terms: HashMap<String, NativeTerminal>,
    /// Foreground Stage + Background Shelf state.
    stage: StageState,
    /// Collapsed project groups in the sidebar.
    collapsed_groups: HashSet<String>,
    /// Currently focused project group (highlighted in sidebar).
    focused_group: Option<String>,
    mru_ids: Vec<String>,
    modifiers: ModifiersState,
    cursor_pos: (f64, f64),
    palette_open: bool,
    palette_query: String,
    palette_selected: usize,
    status_error: Option<String>,
}

impl NativeApp {
    fn new(cfg: ClientConfig, hub_tx: mpsc::UnboundedSender<HubCommand>) -> Self {
        Self {
            cfg,
            hub_tx,
            window: None,
            renderer: None,
            machines: Vec::new(),
            terminals: Vec::new(),
            live_terms: HashMap::new(),
            stage: StageState::default(),
            collapsed_groups: HashSet::new(),
            focused_group: None,
            mru_ids: Vec::new(),
            modifiers: ModifiersState::empty(),
            cursor_pos: (0.0, 0.0),
            palette_open: false,
            palette_query: String::new(),
            palette_selected: 0,
            status_error: None,
        }
    }

    fn request_redraw(&self) {
        if let Some(w) = &self.window {
            w.request_redraw();
        }
    }

    fn machine_name(&self, id: &str) -> String {
        self.machines
            .iter()
            .find(|m| m.id == id)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| id.chars().take(8).collect())
    }

    fn all_terminal_ids(&self) -> Vec<String> {
        self.terminals.iter().map(|t| t.id.clone()).collect()
    }

    fn build_shelf_pills(&self) -> Vec<ShelfPill> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let mut pills: Vec<ShelfPill> = self
            .stage
            .shelf_ids
            .iter()
            .filter_map(|id| {
                let t = self.terminals.iter().find(|t| &t.id == id)?;
                let working = t
                    .last_activity_ms
                    .is_some_and(|ms| now_ms.saturating_sub(ms) < 15_000);
                Some(ShelfPill {
                    terminal_id: t.id.clone(),
                    label: t.display_name(),
                    waiting: t.is_waiting(),
                    working,
                })
            })
            .collect();
        pills.sort_by(|a, b| {
            b.waiting
                .cmp(&a.waiting)
                .then_with(|| b.working.cmp(&a.working))
        });
        pills
    }

    fn build_sidebar_items(&self) -> Vec<SidebarItem> {
        // Group terminals by project_group (derived from cwd, collapsing git worktrees).
        let mut groups: BTreeMap<String, Vec<&TerminalEntry>> = BTreeMap::new();
        for t in &self.terminals {
            groups.entry(t.project_group()).or_default().push(t);
        }

        let mut ordered_groups: Vec<(String, Vec<&TerminalEntry>)> = groups.into_iter().collect();
        ordered_groups.sort_by(|(ga, ta), (gb, tb)| {
            let wa = ta.iter().any(|t| t.is_waiting());
            let wb = tb.iter().any(|t| t.is_waiting());
            let fa = self.focused_group.as_deref() == Some(ga.as_str());
            let fb = self.focused_group.as_deref() == Some(gb.as_str());
            wb.cmp(&wa)
                .then_with(|| fb.cmp(&fa))
                .then_with(|| ga.cmp(gb))
        });

        let mut rows = Vec::new();
        for (group, mut members) in ordered_groups {
            let waiting_count = members.iter().filter(|t| t.is_waiting()).count();
            let collapsed = self.collapsed_groups.contains(&group);
            let focused = self.focused_group.as_deref() == Some(group.as_str());
            rows.push(SidebarItem::GroupHeader {
                group: group.clone(),
                count: members.len(),
                waiting_count,
                collapsed,
                focused,
            });
            if !collapsed {
                members.sort_by(|a, b| {
                    b.is_waiting()
                        .cmp(&a.is_waiting())
                        .then_with(|| {
                            b.last_activity_ms
                                .unwrap_or(0)
                                .cmp(&a.last_activity_ms.unwrap_or(0))
                        })
                });
                for t in members {
                    rows.push(SidebarItem::Terminal {
                        id: t.id.clone(),
                        label: t.display_name(),
                        subtitle: self.machine_name(&t.machine_id),
                        active: self.stage.active_id.as_deref() == Some(t.id.as_str()),
                        waiting: t.is_waiting(),
                        minimized: self.stage.shelf_ids.contains(&t.id),
                    });
                }
            }
        }
        rows
    }

    fn current_pane_rects(&self) -> Vec<(String, LayoutRect, bool)> {
        let Some(r) = &self.renderer else {
            return Vec::new();
        };
        let stage_rect = r.stage_rect(!self.stage.shelf_ids.is_empty());
        let rects = compute_stage_rects(self.stage.layout, stage_rect, self.stage.stage_ids.len());
        self.stage
            .stage_ids
            .iter()
            .zip(rects)
            .enumerate()
            .map(|(idx, (id, rect))| (id.clone(), rect, idx == 0))
            .collect()
    }

    /// Ensure every terminal currently on the foreground stage is attached and sized to its exact pane.
    fn sync_stage_panes(&mut self, claim_and_fit: bool) {
        let pane_rects = self.current_pane_rects();
        let active_id = self.stage.active_id.clone();

        for (tid, rect, _) in pane_rects {
            let Some(entry) = self.terminals.iter().find(|t| t.id == tid).cloned() else {
                continue;
            };
            let (cols, rows) = self
                .renderer
                .as_ref()
                .map(|r| r.pane_grid_size(rect))
                .unwrap_or((entry.cols, entry.rows));

            self.live_terms
                .entry(tid.clone())
                .or_insert_with(|| NativeTerminal::new(entry.cols, entry.rows));

            let _ = self.hub_tx.send(HubCommand::EnsureAttach {
                machine_id: entry.machine_id.clone(),
                terminal_id: tid.clone(),
            });

            if claim_and_fit {
                if active_id.as_deref() == Some(tid.as_str()) {
                    let _ = self.hub_tx.send(HubCommand::ClaimControl {
                        machine_id: entry.machine_id,
                    });
                }
                if let Some(t) = self.live_terms.get_mut(&tid) {
                    if t.cols != cols || t.rows != rows {
                        t.resize(cols, rows);
                        let _ = self.hub_tx.send(HubCommand::Resize {
                            terminal_id: tid,
                            cols,
                            rows,
                        });
                    }
                }
            }
        }
        self.request_redraw();
    }

    fn select_terminal(&mut self, terminal_id: String, claim_and_fit: bool) {
        if let Some(entry) = self.terminals.iter().find(|t| t.id == terminal_id) {
            self.focused_group = Some(entry.project_group());
        }
        self.stage.focus_or_open(terminal_id.clone());
        self.mru_ids.retain(|id| id != &terminal_id);
        self.mru_ids.insert(0, terminal_id);
        self.sync_stage_panes(claim_and_fit);
    }

    /// Bring a whole project group's agents onto the Foreground Stage in one click!
    fn focus_project_group(&mut self, group: &str) {
        self.focused_group = Some(group.to_string());
        self.collapsed_groups.remove(group);
        let group_ids: Vec<String> = self
            .terminals
            .iter()
            .filter(|t| t.project_group() == group)
            .map(|t| t.id.clone())
            .collect();
        if group_ids.is_empty() {
            return;
        }
        // Auto-select a fitting layout if currently in Focus and project has multiple agents.
        if self.stage.layout == StageLayout::Focus && group_ids.len() >= 2 {
            self.stage.layout = if group_ids.len() == 2 {
                StageLayout::Split
            } else {
                StageLayout::MasterStack
            };
        }
        let cap = self.stage.layout.max_panes();
        self.stage.stage_ids = group_ids.iter().take(cap).cloned().collect();
        for id in &self.stage.stage_ids {
            self.stage.shelf_ids.retain(|x| x != id);
        }
        self.stage.active_id = self.stage.stage_ids.first().cloned();
        self.sync_stage_panes(true);
    }

    fn send_to_active(&mut self, data: String) {
        let Some(tid) = self.stage.active_id.clone() else {
            return;
        };
        if let Some(entry) = self.terminals.iter().find(|t| t.id == tid) {
            let _ = self.hub_tx.send(HubCommand::ClaimControl {
                machine_id: entry.machine_id.clone(),
            });
        }
        // Implicit focus handoff: snap back to live bottom & fit pane on first interaction.
        let pane_rect = self
            .current_pane_rects()
            .into_iter()
            .find(|(id, _, _)| id == &tid)
            .map(|(_, rect, _)| rect);
        if let Some(term) = self.live_terms.get_mut(&tid) {
            term.snap_to_bottom();
            if let (Some(r), Some(rect)) = (&self.renderer, pane_rect) {
                let (cols, rows) = r.pane_grid_size(rect);
                if term.cols != cols || term.rows != rows {
                    term.resize(cols, rows);
                    let _ = self.hub_tx.send(HubCommand::Resize {
                        terminal_id: tid.clone(),
                        cols,
                        rows,
                    });
                }
            }
        }
        let _ = self.hub_tx.send(HubCommand::SendInput {
            terminal_id: tid,
            data,
        });
    }

    fn filtered_palette_rows(&self) -> Vec<(String, String, String, bool)> {
        let q = self.palette_query.trim().to_lowercase();
        let mut items: Vec<&TerminalEntry> = self.terminals.iter().collect();
        items.sort_by(|a, b| {
            b.is_waiting()
                .cmp(&a.is_waiting())
                .then_with(|| {
                    let ra = self.mru_ids.iter().position(|id| id == &a.id).unwrap_or(usize::MAX);
                    let rb = self.mru_ids.iter().position(|id| id == &b.id).unwrap_or(usize::MAX);
                    ra.cmp(&rb)
                })
                .then_with(|| b.last_activity_ms.unwrap_or(0).cmp(&a.last_activity_ms.unwrap_or(0)))
        });
        items
            .into_iter()
            .filter_map(|t| {
                let group = t.project_group();
                let mname = self.machine_name(&t.machine_id);
                let label = format!("[{group}] {}", t.display_name());
                let hay = format!("{} {} {} {}", group, t.display_name(), t.cwd, mname).to_lowercase();
                if !q.is_empty() && !hay.contains(&q) {
                    return None;
                }
                Some((t.id.clone(), label, mname, t.is_waiting()))
            })
            .collect()
    }

    fn handle_shortcut(&mut self, sc: AppShortcut) {
        match sc {
            AppShortcut::ToggleQuickSwitcher => {
                self.palette_open = !self.palette_open;
                self.palette_query.clear();
                self.palette_selected = 0;
                self.request_redraw();
            }
            AppShortcut::LastTerminal => {
                if let Some(prev) = self
                    .mru_ids
                    .iter()
                    .find(|id| Some(*id) != self.stage.active_id.as_ref())
                    .cloned()
                {
                    self.select_terminal(prev, true);
                }
            }
            AppShortcut::NextWaitingAgent => {
                let waiting: Vec<String> = self
                    .terminals
                    .iter()
                    .filter(|t| t.is_waiting())
                    .map(|t| t.id.clone())
                    .collect();
                if !waiting.is_empty() {
                    let cur = self
                        .stage
                        .active_id
                        .as_ref()
                        .and_then(|id| waiting.iter().position(|w| w == id));
                    let next = waiting[(cur.map(|i| i + 1).unwrap_or(0)) % waiting.len()].clone();
                    self.select_terminal(next, true);
                }
            }
            AppShortcut::PasteClipboard => {
                if let Ok(mut cb) = arboard::Clipboard::new() {
                    if let Ok(text) = cb.get_text() {
                        let bracketed = self
                            .stage
                            .active_id
                            .as_ref()
                            .and_then(|id| self.live_terms.get(id))
                            .is_some_and(|t| t.bracketed_paste());
                        let payload = if bracketed {
                            format!("\x1b[200~{}\x1b[201~", text)
                        } else {
                            text
                        };
                        self.send_to_active(payload);
                    }
                }
            }
            AppShortcut::FontZoomIn | AppShortcut::FontZoomOut | AppShortcut::FontZoomReset => {
                if let Some(r) = &mut self.renderer {
                    let next = match sc {
                        AppShortcut::FontZoomIn => r.font_size + 1.0,
                        AppShortcut::FontZoomOut => r.font_size - 1.0,
                        _ => self.cfg.font_size,
                    };
                    r.set_font_size(next);
                }
                self.sync_stage_panes(true);
            }
            AppShortcut::NewTerminal => {
                let target_machine = self
                    .stage
                    .active_id
                    .as_ref()
                    .and_then(|id| self.terminals.iter().find(|t| &t.id == id))
                    .map(|t| t.machine_id.clone())
                    .or_else(|| self.machines.iter().find(|m| m.online).map(|m| m.id.clone()));
                if let Some(machine_id) = target_machine {
                    let cwd = self
                        .stage
                        .active_id
                        .as_ref()
                        .and_then(|id| self.terminals.iter().find(|t| &t.id == id))
                        .map(|t| t.cwd.clone())
                        .filter(|c| !c.is_empty())
                        .or_else(|| {
                            self.machines
                                .iter()
                                .find(|m| m.id == machine_id)
                                .and_then(|m| m.home_dir.clone())
                        })
                        .unwrap_or_else(|| "~".to_string());
                    let (cols, rows) = self
                        .renderer
                        .as_ref()
                        .map(|r| r.terminal_grid_size())
                        .unwrap_or((120, 40));
                    let _ = self.hub_tx.send(HubCommand::CreateTerminal {
                        machine_id,
                        cwd,
                        cols,
                        rows,
                    });
                }
            }
            AppShortcut::RefreshList => {
                let _ = self.hub_tx.send(HubCommand::RefreshInventory);
            }
        }
    }
}

impl ApplicationHandler<HubEvent> for NativeApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }
        let attrs = Window::default_attributes()
            .with_title("Offdesk Native (wgpu + alacritty)")
            .with_inner_size(LogicalSize::new(1280.0, 820.0));
        let window = Arc::new(event_loop.create_window(attrs).expect("create window"));
        window.set_ime_allowed(true);
        let size = window.inner_size();
        let instance = wgpu::Instance::default();
        let surface = instance
            .create_surface(Arc::clone(&window))
            .expect("create wgpu surface");
        let renderer = GpuRenderer::from_surface(
            instance,
            surface,
            size.width,
            size.height,
            self.cfg.font_size,
        )
        .expect("init wgpu renderer");
        self.window = Some(window);
        self.renderer = Some(renderer);
        self.request_redraw();
    }

    fn user_event(&mut self, _event_loop: &ActiveEventLoop, event: HubEvent) {
        match event {
            HubEvent::Inventory {
                machines,
                terminals,
            } => {
                self.machines = machines;
                self.terminals = terminals;
                self.status_error = None;
                let valid_ids = self.all_terminal_ids();
                let was_empty = self.stage.stage_ids.is_empty();
                self.stage.reconcile(&valid_ids);
                if was_empty && !self.stage.stage_ids.is_empty() {
                    if let Some(first_id) = self.stage.stage_ids.first() {
                        if let Some(entry) = self.terminals.iter().find(|t| &t.id == first_id) {
                            self.focused_group = Some(entry.project_group());
                        }
                    }
                    self.sync_stage_panes(false);
                } else {
                    self.request_redraw();
                }
            }
            HubEvent::TerminalOutput { terminal_id, bytes } => {
                let term = self
                    .live_terms
                    .entry(terminal_id.clone())
                    .or_insert_with(|| NativeTerminal::new(120, 40));
                term.feed(&bytes);
                if self.stage.stage_ids.iter().any(|id| id == &terminal_id) {
                    self.request_redraw();
                }
            }
            HubEvent::TerminalResized {
                terminal_id,
                cols,
                rows,
            } => {
                if let Some(term) = self.live_terms.get_mut(&terminal_id) {
                    term.resize(cols, rows);
                    if self.stage.stage_ids.iter().any(|id| id == &terminal_id) {
                        self.request_redraw();
                    }
                }
            }
            HubEvent::TerminalCreated(term) => {
                let id = term.id.clone();
                if !self.terminals.iter().any(|t| t.id == id) {
                    self.terminals.insert(0, term);
                }
                self.select_terminal(id, true);
            }
            HubEvent::Error(e) => {
                self.status_error = Some(e);
                self.request_redraw();
            }
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::ModifiersChanged(m) => self.modifiers = m.state(),
            WindowEvent::CursorMoved { position, .. } => {
                self.cursor_pos = (position.x, position.y);
            }
            WindowEvent::Resized(new_size) => {
                if let Some(r) = &mut self.renderer {
                    r.resize(new_size.width, new_size.height);
                }
                self.sync_stage_panes(true);
            }
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Left,
                ..
            } => {
                let (x, y) = (self.cursor_pos.0 as f32, self.cursor_pos.1 as f32);

                // 1. Topbar clickable layout switcher ([▢] [◫] [◧] [⊞])
                if let Some(layout) = self
                    .renderer
                    .as_ref()
                    .and_then(|r| r.hit_test_layout_button(x, y))
                {
                    let all_ids = self.all_terminal_ids();
                    self.stage.set_layout(layout, &all_ids);
                    self.sync_stage_panes(true);
                    return;
                }

                // 2. Sidebar (project group collapse/expand, [▶] focus group, or terminal select)
                let sidebar_items = self.build_sidebar_items();
                if let Some(action) = self
                    .renderer
                    .as_ref()
                    .and_then(|r| r.hit_test_sidebar(x, y, &sidebar_items))
                {
                    self.palette_open = false;
                    match action {
                        SidebarHitAction::ToggleGroup(group) => {
                            if !self.collapsed_groups.remove(&group) {
                                self.collapsed_groups.insert(group);
                            }
                            self.request_redraw();
                        }
                        SidebarHitAction::FocusGroup(group) => {
                            self.focus_project_group(&group);
                        }
                        SidebarHitAction::SelectTerminal(id) => {
                            self.select_terminal(id, true);
                        }
                    }
                    return;
                }

                // 3. Dismiss Cmd+K palette if open
                if self.palette_open {
                    self.palette_open = false;
                    self.request_redraw();
                    return;
                }

                // 4. Bottom Background Shelf pills (click to restore straight to Master)
                let shelf_pills = self.build_shelf_pills();
                if let Some(id) = self
                    .renderer
                    .as_ref()
                    .and_then(|r| r.hit_test_shelf_pill(x, y, &shelf_pills))
                {
                    self.stage.restore_from_shelf(&id);
                    self.sync_stage_panes(true);
                    return;
                }

                // 5. Stage panes: [—] minimize to shelf, [↖] swap to master, or click pane to focus
                let pane_rects = self.current_pane_rects();
                if let Some(hit) = self
                    .renderer
                    .as_ref()
                    .and_then(|r| r.hit_test_pane(x, y, &pane_rects))
                {
                    match hit {
                        PaneHitAction::Minimize(id) => {
                            let all_ids = self.all_terminal_ids();
                            self.stage.minimize_to_shelf(&id, &all_ids);
                            self.sync_stage_panes(true);
                        }
                        PaneHitAction::SwapToMaster(id) => {
                            self.stage.swap_to_master(&id);
                            self.sync_stage_panes(true);
                        }
                        PaneHitAction::Focus(id) => {
                            self.select_terminal(id, true);
                        }
                    }
                }
            }
            WindowEvent::MouseWheel { delta, .. } => {
                let lines = match delta {
                    MouseScrollDelta::LineDelta(_, y) => (y * 3.0).round() as i32,
                    MouseScrollDelta::PixelDelta(p) => (p.y / 14.0).round() as i32,
                };
                if lines == 0 {
                    return;
                }
                // Scroll whichever pane the cursor is hovering over (fallback to active pane).
                let (x, y) = (self.cursor_pos.0 as f32, self.cursor_pos.1 as f32);
                let target_id = self
                    .current_pane_rects()
                    .into_iter()
                    .find(|(_, rect, _)| rect.contains(x, y))
                    .map(|(id, _, _)| id)
                    .or_else(|| self.stage.active_id.clone());
                let Some(tid) = target_id else {
                    return;
                };
                if let Some(term) = self.live_terms.get_mut(&tid) {
                    if term.wants_mouse() {
                        let btn = if lines > 0 { 64 } else { 65 };
                        let count = lines.unsigned_abs().clamp(1, 5);
                        let mut seq = String::new();
                        for _ in 0..count {
                            seq.push_str(&format!("\x1b[<{btn};1;1M"));
                        }
                        let _ = self.hub_tx.send(HubCommand::SendInput {
                            terminal_id: tid,
                            data: seq,
                        });
                    } else {
                        term.scroll_local(lines);
                        self.request_redraw();
                    }
                }
            }
            WindowEvent::Ime(Ime::Commit(text)) => {
                if self.palette_open {
                    self.palette_query.push_str(&text);
                    self.palette_selected = 0;
                    self.request_redraw();
                } else if !text.is_empty() {
                    self.send_to_active(text);
                }
            }
            WindowEvent::KeyboardInput { event, .. } if event.state == ElementState::Pressed => {
                if let Some(sc) = match_shortcut(&event, self.modifiers) {
                    self.handle_shortcut(sc);
                    return;
                }
                if self.palette_open {
                    let rows = self.filtered_palette_rows();
                    match &event.logical_key {
                        Key::Named(NamedKey::Escape) => {
                            self.palette_open = false;
                        }
                        Key::Named(NamedKey::ArrowDown) => {
                            if !rows.is_empty() {
                                self.palette_selected = (self.palette_selected + 1) % rows.len().min(12);
                            }
                        }
                        Key::Named(NamedKey::ArrowUp) => {
                            let n = rows.len().min(12);
                            if n > 0 {
                                self.palette_selected = (self.palette_selected + n - 1) % n;
                            }
                        }
                        Key::Named(NamedKey::Backspace) => {
                            self.palette_query.pop();
                            self.palette_selected = 0;
                        }
                        Key::Named(NamedKey::Enter) => {
                            if let Some((id, _, _, _)) = rows.get(self.palette_selected) {
                                let id = id.clone();
                                self.palette_open = false;
                                self.select_terminal(id, true);
                            }
                        }
                        _ => {
                            if let Some(t) = event.text.as_deref() {
                                if !t.chars().any(|c| c.is_control()) {
                                    self.palette_query.push_str(t);
                                    self.palette_selected = 0;
                                }
                            }
                        }
                    }
                    self.request_redraw();
                    return;
                }

                if let Some(bytes) = key_event_to_terminal_bytes(&event, self.modifiers) {
                    self.send_to_active(bytes);
                }
            }
            WindowEvent::RedrawRequested => {
                let sidebar_rows = self.build_sidebar_items();
                let shelf_pills = self.build_shelf_pills();
                let pane_rects = self.current_pane_rects();

                let pane_data: Vec<(String, String, LayoutRect, bool, bool, Option<RenderFrame>)> =
                    pane_rects
                        .into_iter()
                        .map(|(id, rect, is_master)| {
                            let title = self
                                .terminals
                                .iter()
                                .find(|t| t.id == id)
                                .map(|t| {
                                    format!(
                                        "{}  ·  {}",
                                        t.display_name(),
                                        self.machine_name(&t.machine_id)
                                    )
                                })
                                .unwrap_or_else(|| id.chars().take(8).collect());
                            let active = self.stage.active_id.as_deref() == Some(id.as_str());
                            let frame = self.live_terms.get(&id).map(|t| t.snapshot_frame());
                            (id, title, rect, active, is_master, frame)
                        })
                        .collect();

                let panes: Vec<PaneSnapshot<'_>> = pane_data
                    .iter()
                    .map(|(id, title, rect, active, is_master, frame)| PaneSnapshot {
                        terminal_id: id.as_str(),
                        title: title.as_str(),
                        rect: *rect,
                        active: *active,
                        is_master: *is_master,
                        frame: frame.as_ref(),
                    })
                    .collect();

                let active_entry = self
                    .stage
                    .active_id
                    .as_ref()
                    .and_then(|id| self.terminals.iter().find(|t| &t.id == id));

                let header_title = match active_entry {
                    Some(e) => format!(
                        "[{}]  {}  ·  {}  ({})",
                        e.project_group(),
                        e.display_name(),
                        e.cwd,
                        self.machine_name(&e.machine_id)
                    ),
                    None => format!("Connecting to {}…", self.cfg.hub_url),
                };

                let active_scrollback = pane_data
                    .iter()
                    .find(|(_, _, _, active, _, _)| *active)
                    .and_then(|(_, _, _, _, _, f)| f.as_ref())
                    .filter(|f| f.display_offset > 0)
                    .map(|f| format!("  ·  scrollback +{}", f.display_offset))
                    .unwrap_or_default();

                let status_left = if let Some(err) = &self.status_error {
                    format!("error: {}", err)
                } else {
                    format!(
                        "{} machines · {} terminals · {} on stage · {} on shelf{}",
                        self.machines.len(),
                        self.terminals.len(),
                        self.stage.stage_ids.len(),
                        self.stage.shelf_ids.len(),
                        active_scrollback
                    )
                };
                let status_right = "Click group ▶ to focus · — minimize · ↖ swap master";

                let pal_raw = if self.palette_open {
                    Some(self.filtered_palette_rows())
                } else {
                    None
                };
                let pal_view: Option<Vec<(String, String, bool)>> = pal_raw
                    .as_ref()
                    .map(|rows| rows.iter().map(|(_, l, m, w)| (l.clone(), m.clone(), *w)).collect());

                let palette = pal_view.as_ref().map(|rows| PaletteOverlay {
                    query: &self.palette_query,
                    rows,
                    selected: self.palette_selected,
                });

                if let Some(r) = &mut self.renderer {
                    let _ = r.render(UiSnapshot {
                        sidebar_rows: &sidebar_rows,
                        header_title: &header_title,
                        layout: self.stage.layout,
                        panes: &panes,
                        shelf_pills: &shelf_pills,
                        status_left: &status_left,
                        status_right,
                        palette,
                    });
                }
            }
            _ => {}
        }
    }
}

fn main() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tracing_subscriber::fmt::init();

    let args = Args::parse();
    let cfg = match ClientConfig::load(args.hub_url, args.token, args.font_size) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    if args.smoke {
        rt.block_on(run_headless_smoke(cfg));
        return;
    }

    let event_loop = EventLoop::<HubEvent>::with_user_event()
        .build()
        .expect("winit event loop");
    let proxy: EventLoopProxy<HubEvent> = event_loop.create_proxy();

    let (hub_tx, hub_rx) = mpsc::unbounded_channel();
    {
        let _guard = rt.enter();
        hub::spawn_hub_worker(
            cfg.clone(),
            hub_rx,
            Arc::new(move |ev| {
                let _ = proxy.send_event(ev);
            }),
        );
    }

    let mut app = NativeApp::new(cfg, hub_tx);
    event_loop.run_app(&mut app).expect("run app");
}

async fn run_headless_smoke(cfg: ClientConfig) {
    let (hub_tx, hub_rx) = mpsc::unbounded_channel();
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
    hub::spawn_hub_worker(
        cfg.clone(),
        hub_rx,
        Arc::new(move |ev| {
            let _ = ev_tx.send(ev);
        }),
    );

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    let mut term: Option<NativeTerminal> = None;
    let mut attached_id: Option<String> = None;
    let mut total_bytes = 0usize;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, ev_rx.recv()).await {
            Ok(Some(HubEvent::Inventory { machines, terminals })) => {
                println!(
                    "[smoke] Connected to {}: {} machines, {} terminals",
                    cfg.hub_url,
                    machines.len(),
                    terminals.len()
                );
                if attached_id.is_none() {
                    if let Some(first) = terminals.iter().find(|t| t.reachable) {
                        attached_id = Some(first.id.clone());
                        term = Some(NativeTerminal::new(first.cols, first.rows));
                        let _ = hub_tx.send(HubCommand::EnsureAttach {
                            machine_id: first.machine_id.clone(),
                            terminal_id: first.id.clone(),
                        });
                    } else {
                        println!("[smoke] No reachable terminals to attach");
                        return;
                    }
                }
            }
            Ok(Some(HubEvent::TerminalOutput { terminal_id, bytes })) => {
                if attached_id.as_deref() == Some(terminal_id.as_str()) {
                    total_bytes += bytes.len();
                    if let Some(t) = &mut term {
                        t.feed(&bytes);
                        let frame = t.snapshot_frame();
                        let non_empty_rows = frame
                            .spans_by_row
                            .iter()
                            .filter(|r| !r.is_empty())
                            .count();
                        if non_empty_rows > 0 {
                            println!(
                                "[smoke] Live stream OK: terminal={} bytes={} painted_rows={} bg_runs={} cursor={:?}",
                                &terminal_id[..8],
                                total_bytes,
                                non_empty_rows,
                                frame.bg_runs.len(),
                                frame.cursor
                            );
                            return;
                        }
                    }
                }
            }
            Ok(Some(HubEvent::Error(e))) => {
                eprintln!("[smoke] Hub error: {}", e);
                std::process::exit(1);
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }
    eprintln!("[smoke] Timed out waiting for terminal output (bytes={})", total_bytes);
    std::process::exit(1);
}
