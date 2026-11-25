//! Shared Foreground Stage + Background Shelf layout engine for Desktop & Mobile.
//!
//! Designed around direct manipulation (click / tap / swap / minimize) rather than
//! memorizing keyboard shortcuts or manually managing binary split trees.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageLayout {
    /// 1 full-bleed focused terminal.
    Focus,
    /// 2 terminals side-by-side (50% / 50%).
    Split,
    /// Master (left 65%) + vertical monitor stack (right 35%, up to 2 panes).
    MasterStack,
    /// 2x2 monitoring grid (up to 4 panes).
    Grid2x2,
}

impl StageLayout {
    pub const ALL: [StageLayout; 4] = [
        StageLayout::Focus,
        StageLayout::Split,
        StageLayout::MasterStack,
        StageLayout::Grid2x2,
    ];

    pub fn max_panes(self) -> usize {
        match self {
            StageLayout::Focus => 1,
            StageLayout::Split => 2,
            StageLayout::MasterStack => 3,
            StageLayout::Grid2x2 => 4,
        }
    }

    pub fn icon_label(self) -> &'static str {
        match self {
            StageLayout::Focus => "▢",
            StageLayout::Split => "◫",
            StageLayout::MasterStack => "◧",
            StageLayout::Grid2x2 => "⊞",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl LayoutRect {
    pub fn contains(self, px: f32, py: f32) -> bool {
        px >= self.x && px <= self.x + self.w && py >= self.y && py <= self.y + self.h
    }
}

/// Compute pixel rectangles for `pane_count` panes inside `stage` with a small gap.
pub fn compute_stage_rects(
    layout: StageLayout,
    stage: LayoutRect,
    pane_count: usize,
) -> Vec<LayoutRect> {
    let n = pane_count.min(layout.max_panes());
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![stage];
    }
    let gap = 2.0_f32;
    match layout {
        StageLayout::Focus => vec![stage],
        StageLayout::Split => {
            let half_w = ((stage.w - gap) * 0.5).max(1.0);
            vec![
                LayoutRect { x: stage.x, y: stage.y, w: half_w, h: stage.h },
                LayoutRect { x: stage.x + half_w + gap, y: stage.y, w: stage.w - half_w - gap, h: stage.h },
            ]
        }
        StageLayout::MasterStack => {
            let master_w = ((stage.w - gap) * 0.64).max(1.0);
            let stack_x = stage.x + master_w + gap;
            let stack_w = (stage.w - master_w - gap).max(1.0);
            let stack_count = n - 1;
            let mut out = Vec::with_capacity(n);
            out.push(LayoutRect {
                x: stage.x,
                y: stage.y,
                w: master_w,
                h: stage.h,
            });
            let each_h = ((stage.h - gap * (stack_count as f32 - 1.0)) / stack_count as f32).max(1.0);
            for i in 0..stack_count {
                out.push(LayoutRect {
                    x: stack_x,
                    y: stage.y + i as f32 * (each_h + gap),
                    w: stack_w,
                    h: each_h,
                });
            }
            out
        }
        StageLayout::Grid2x2 => {
            if n == 2 {
                return compute_stage_rects(StageLayout::Split, stage, 2);
            }
            let half_w = ((stage.w - gap) * 0.5).max(1.0);
            let half_h = ((stage.h - gap) * 0.5).max(1.0);
            let mut out = vec![
                LayoutRect { x: stage.x, y: stage.y, w: half_w, h: half_h },
                LayoutRect { x: stage.x + half_w + gap, y: stage.y, w: stage.w - half_w - gap, h: half_h },
                LayoutRect { x: stage.x, y: stage.y + half_h + gap, w: half_w, h: stage.h - half_h - gap },
            ];
            if n >= 4 {
                out.push(LayoutRect {
                    x: stage.x + half_w + gap,
                    y: stage.y + half_h + gap,
                    w: stage.w - half_w - gap,
                    h: stage.h - half_h - gap,
                });
            }
            out
        }
    }
}

/// Manages which terminals are on the foreground Stage vs minimized in the Background Shelf.
#[derive(Debug, Clone)]
pub struct StageState {
    pub layout: StageLayout,
    /// Ordered foreground terminal IDs (`stage_ids[0]` is always the Master pane).
    pub stage_ids: Vec<String>,
    /// Minimized background terminal IDs (shown as clickable pills in the Background Shelf).
    pub shelf_ids: Vec<String>,
    /// Currently focused terminal receiving keyboard input.
    pub active_id: Option<String>,
}

impl Default for StageState {
    fn default() -> Self {
        Self {
            layout: StageLayout::Focus,
            stage_ids: Vec::new(),
            shelf_ids: Vec::new(),
            active_id: None,
        }
    }
}

impl StageState {
    /// Remove closed terminals and ensure stage stays populated when terminals exist.
    pub fn reconcile(&mut self, valid_ids: &[String]) {
        self.stage_ids.retain(|id| valid_ids.iter().any(|v| v == id));
        self.shelf_ids.retain(|id| valid_ids.iter().any(|v| v == id));
        if let Some(active) = &self.active_id {
            if !valid_ids.iter().any(|v| v == active) {
                self.active_id = self.stage_ids.first().cloned();
            }
        }
        if self.stage_ids.is_empty() {
            if let Some(first) = valid_ids.iter().find(|id| !self.shelf_ids.contains(id)) {
                self.stage_ids.push(first.clone());
                self.active_id = Some(first.clone());
            }
        }
    }

    /// Bring a terminal to the foreground stage (restoring from shelf if minimized) and focus it.
    pub fn focus_or_open(&mut self, id: String) {
        self.shelf_ids.retain(|x| x != &id);
        if self.stage_ids.contains(&id) {
            self.active_id = Some(id);
            return;
        }
        let cap = self.layout.max_panes();
        if self.stage_ids.len() < cap {
            self.stage_ids.push(id.clone());
        } else if !self.stage_ids.is_empty() {
            self.stage_ids[0] = id.clone();
        } else {
            self.stage_ids.push(id.clone());
        }
        self.active_id = Some(id);
    }

    /// Minimize a terminal off the foreground stage into the Background Shelf (never kills it).
    pub fn minimize_to_shelf(&mut self, id: &str, all_ids: &[String]) {
        self.stage_ids.retain(|x| x != id);
        if !self.shelf_ids.iter().any(|x| x == id) {
            self.shelf_ids.push(id.to_string());
        }
        if self.active_id.as_deref() == Some(id) {
            self.active_id = self.stage_ids.first().cloned();
        }
        // If stage became empty, bring the next non-minimized terminal forward if one exists.
        if self.stage_ids.is_empty() {
            if let Some(next) = all_ids.iter().find(|cand| !self.shelf_ids.contains(cand)) {
                self.stage_ids.push(next.clone());
                self.active_id = Some(next.clone());
            }
        }
    }

    /// Restore a minimized terminal from the Background Shelf directly into the Master slot.
    pub fn restore_from_shelf(&mut self, id: &str) {
        self.shelf_ids.retain(|x| x != id);
        self.stage_ids.retain(|x| x != id);
        self.stage_ids.insert(0, id.to_string());
        self.stage_ids.truncate(self.layout.max_panes());
        self.active_id = Some(id.to_string());
    }

    /// One-click Swap to Master (e.g. clicking `[↖]` on a secondary pane in Master+Stack).
    pub fn swap_to_master(&mut self, id: &str) {
        if let Some(pos) = self.stage_ids.iter().position(|x| x == id) {
            if pos > 0 {
                self.stage_ids.swap(0, pos);
            }
            self.active_id = Some(id.to_string());
        }
    }

    /// Switch layout template and auto-fill available stage slots from non-minimized terminals.
    pub fn set_layout(&mut self, layout: StageLayout, all_ids: &[String]) {
        self.layout = layout;
        let cap = layout.max_panes();
        // Keep active pane in stage_ids[0] when shrinking to Focus.
        if let Some(active) = self.active_id.clone() {
            if let Some(pos) = self.stage_ids.iter().position(|x| x == &active) {
                if cap == 1 && pos > 0 {
                    self.stage_ids.swap(0, pos);
                }
            }
        }
        self.stage_ids.truncate(cap);
        for cand in all_ids {
            if self.stage_ids.len() >= cap {
                break;
            }
            if !self.stage_ids.contains(cand) && !self.shelf_ids.contains(cand) {
                self.stage_ids.push(cand.clone());
            }
        }
        if self.active_id.is_none() || !self.stage_ids.iter().any(|x| Some(x) == self.active_id.as_ref()) {
            self.active_id = self.stage_ids.first().cloned();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn master_stack_rects_and_minimize_restore_flow() {
        let stage = LayoutRect { x: 240.0, y: 34.0, w: 1000.0, h: 700.0 };
        let rects = compute_stage_rects(StageLayout::MasterStack, stage, 3);
        assert_eq!(rects.len(), 3);
        assert!(rects[0].w > rects[1].w);
        assert!((rects[1].h - rects[2].h).abs() < 1.0);

        let all = vec!["t1".into(), "t2".into(), "t3".into(), "t4".into()];
        let mut state = StageState::default();
        state.focus_or_open("t1".into());
        state.set_layout(StageLayout::MasterStack, &all);
        assert_eq!(state.stage_ids, vec!["t1", "t2", "t3"]);

        // Swap t2 into Master slot.
        state.swap_to_master("t2");
        assert_eq!(state.stage_ids[0], "t2");
        assert_eq!(state.active_id.as_deref(), Some("t2"));

        // Minimize t2 to Background Shelf.
        state.minimize_to_shelf("t2", &all);
        assert_eq!(state.shelf_ids, vec!["t2"]);
        assert!(!state.stage_ids.contains(&"t2".to_string()));

        // Restore t2 from Shelf -> returns straight to Master slot.
        state.restore_from_shelf("t2");
        assert!(state.shelf_ids.is_empty());
        assert_eq!(state.stage_ids[0], "t2");
    }
}
