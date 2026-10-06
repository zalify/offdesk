//! Live screencast fan-out for agent browsers.
//!
//! The node sends at most one JPEG frame per browser until the hub acks it.
//! Each viewer has a latest-wins slot and a "waiting for ack" flag, so a slow
//! viewer skips frames instead of stalling the others. The hub acks the node
//! when the FIRST viewer acks a given frame.
//!
//! `Fanout` is pure state: every call returns the `NodeAction`s the caller
//! must send to the node. `Streams` keeps one `Fanout` per (machine, browser).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::mpsc;

pub const DEFAULT_WIDTH: u32 = 1280;
pub const DEFAULT_HEIGHT: u32 = 800;
pub const DEFAULT_QUALITY: u32 = 60;

/// Screencast parameters a viewer asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Params {
    pub max_width: u32,
    pub max_height: u32,
    pub quality: u32,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            max_width: DEFAULT_WIDTH,
            max_height: DEFAULT_HEIGHT,
            quality: DEFAULT_QUALITY,
        }
    }
}

impl Params {
    /// Clamp client-supplied values: width/height 200..=1920, quality 20..=90.
    pub fn clamped(max_width: u32, max_height: u32, quality: u32) -> Self {
        Self {
            max_width: max_width.clamp(200, 1920),
            max_height: max_height.clamp(200, 1920),
            quality: quality.clamp(20, 90),
        }
    }

    fn max(self, other: Params) -> Params {
        Params {
            max_width: self.max_width.max(other.max_width),
            max_height: self.max_height.max(other.max_height),
            quality: self.quality.max(other.quality),
        }
    }
}

/// One screencast frame: CDP metadata JSON plus the JPEG.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub meta: Bytes,
    pub jpeg: Bytes,
}

/// What a viewer connection receives.
#[derive(Debug)]
pub enum ViewerMsg {
    Frame(Arc<Frame>),
    Destroyed,
}

/// What the caller must tell the node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeAction {
    /// Start/restart the screencast; the `u64` is the epoch that orders
    /// this against other Start/Stop messages for the same browser.
    Start(Params, u64),
    Stop(u64),
    Ack,
}

struct Viewer {
    tx: mpsc::UnboundedSender<ViewerMsg>,
    params: Params,
    /// A frame was sent and the viewer has not acked it yet.
    waiting: bool,
    /// Sequence number of the frame last sent to this viewer.
    sent_seq: u64,
    /// Newest frame that arrived while the viewer was waiting.
    slot: Option<(u64, Arc<Frame>)>,
}

#[derive(Default)]
pub struct Fanout {
    viewers: HashMap<u64, Viewer>,
    /// Parameters the node is currently running with.
    started: Option<Params>,
    seq: u64,
    /// Highest frame sequence the node has been told about (acked).
    node_acked: u64,
    last_frame: Option<(u64, Arc<Frame>)>,
    /// Epoch of the latest Start/Stop sent to the node.
    epoch: u64,
}

impl Fanout {
    pub fn is_empty(&self) -> bool {
        self.viewers.is_empty()
    }

    fn effective(&self) -> Option<Params> {
        self.viewers
            .values()
            .map(|v| v.params)
            .reduce(|a, b| a.max(b))
    }

    /// Start/restart/stop the node screencast so it matches the viewers.
    fn reconcile(&mut self) -> Vec<NodeAction> {
        let wanted = self.effective();
        if wanted == self.started {
            return Vec::new();
        }
        self.started = wanted;
        self.epoch += 1;
        vec![match wanted {
            Some(p) => NodeAction::Start(p, self.epoch),
            None => NodeAction::Stop(self.epoch),
        }]
    }

    pub fn add_viewer(
        &mut self,
        id: u64,
        params: Params,
        tx: mpsc::UnboundedSender<ViewerMsg>,
    ) -> Vec<NodeAction> {
        let mut viewer = Viewer {
            tx,
            params,
            waiting: false,
            sent_seq: 0,
            slot: None,
        };
        // A static page produces no new frames; show the latest one now.
        if let Some((seq, frame)) = &self.last_frame {
            if viewer.tx.send(ViewerMsg::Frame(frame.clone())).is_ok() {
                viewer.waiting = true;
                viewer.sent_seq = *seq;
            }
        }
        self.viewers.insert(id, viewer);
        self.reconcile()
    }

    pub fn remove_viewer(&mut self, id: u64) -> Vec<NodeAction> {
        if self.viewers.remove(&id).is_none() {
            return Vec::new();
        }
        if self.viewers.is_empty() {
            self.last_frame = None;
        }
        // The removed viewer may have been the one that would have acked the
        // frame in flight; remaining viewers ack it themselves, and the node
        // times the frame out otherwise.
        self.reconcile()
    }

    pub fn set_params(&mut self, id: u64, params: Params) -> Vec<NodeAction> {
        match self.viewers.get_mut(&id) {
            Some(viewer) => viewer.params = params,
            None => return Vec::new(),
        }
        self.reconcile()
    }

    /// A frame arrived from the node.
    pub fn on_frame(&mut self, frame: Frame) -> Vec<NodeAction> {
        self.seq += 1;
        let seq = self.seq;
        let frame = Arc::new(frame);
        if self.viewers.is_empty() {
            self.node_acked = seq;
            return vec![NodeAction::Ack];
        }
        self.last_frame = Some((seq, frame.clone()));
        for viewer in self.viewers.values_mut() {
            if viewer.waiting {
                viewer.slot = Some((seq, frame.clone()));
            } else if viewer.tx.send(ViewerMsg::Frame(frame.clone())).is_ok() {
                viewer.waiting = true;
                viewer.sent_seq = seq;
            }
        }
        Vec::new()
    }

    /// A viewer drew the frame it was sent.
    pub fn viewer_ack(&mut self, id: u64) -> Vec<NodeAction> {
        let Some(viewer) = self.viewers.get_mut(&id) else {
            return Vec::new();
        };
        if !viewer.waiting {
            return Vec::new();
        }
        viewer.waiting = false;
        let sent_seq = viewer.sent_seq;
        if let Some((seq, frame)) = viewer.slot.take() {
            if viewer.tx.send(ViewerMsg::Frame(frame)).is_ok() {
                viewer.waiting = true;
                viewer.sent_seq = seq;
            }
        }
        if sent_seq > self.node_acked {
            self.node_acked = sent_seq;
            return vec![NodeAction::Ack];
        }
        Vec::new()
    }

    /// The browser is gone: tell every viewer.
    pub fn destroy(&mut self) {
        for viewer in self.viewers.values() {
            let _ = viewer.tx.send(ViewerMsg::Destroyed);
        }
    }

    /// After the node reconnected: the screencast there is not running.
    fn restart_action(&mut self) -> Option<NodeAction> {
        self.started = None;
        self.node_acked = self.seq;
        self.reconcile().into_iter().next()
    }
}

/// Fan-outs keyed by (machine id, browser id).
#[derive(Default)]
pub struct Streams {
    inner: Mutex<StreamsInner>,
}

struct StreamsInner {
    next_viewer: u64,
    fanouts: HashMap<(String, String), Fanout>,
    /// Highest epoch ever issued. New fan-outs start from it, so epochs stay
    /// increasing per browser across fan-out removal, and (seeded from the
    /// clock) across hub restarts: a node that outlives the hub has seen
    /// older epochs only.
    epoch_clock: u64,
    /// Last epoch of fan-outs that ended because their viewers left, for a
    /// straggler frame's Stop.
    last_epochs: HashMap<(String, String), u64>,
}

impl Default for StreamsInner {
    fn default() -> Self {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Self {
            next_viewer: 0,
            fanouts: HashMap::new(),
            epoch_clock: millis,
            last_epochs: HashMap::new(),
        }
    }
}

impl StreamsInner {
    /// A fan-out ended; keep its epoch ordering.
    fn retire(&mut self, key: &(String, String), fanout: &Fanout, remember: bool) {
        self.epoch_clock = self.epoch_clock.max(fanout.epoch);
        if remember {
            self.last_epochs.insert(key.clone(), fanout.epoch);
        } else {
            self.last_epochs.remove(key);
        }
    }
}

impl Streams {
    pub fn add_viewer(
        &self,
        machine_id: &str,
        browser_id: &str,
        params: Params,
    ) -> (u64, mpsc::UnboundedReceiver<ViewerMsg>, Vec<NodeAction>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut inner = self.inner.lock().unwrap();
        inner.next_viewer += 1;
        let id = inner.next_viewer;
        let key = (machine_id.to_string(), browser_id.to_string());
        let seed = inner
            .last_epochs
            .remove(&key)
            .unwrap_or(0)
            .max(inner.epoch_clock);
        let actions = inner
            .fanouts
            .entry(key)
            .or_insert_with(|| Fanout {
                epoch: seed,
                ..Fanout::default()
            })
            .add_viewer(id, params, tx);
        (id, rx, actions)
    }

    fn with<R: Default>(
        &self,
        machine_id: &str,
        browser_id: &str,
        f: impl FnOnce(&mut Fanout) -> R,
    ) -> R {
        let mut inner = self.inner.lock().unwrap();
        let key = (machine_id.to_string(), browser_id.to_string());
        let Some(fanout) = inner.fanouts.get_mut(&key) else {
            return R::default();
        };
        let result = f(fanout);
        if fanout.is_empty() {
            if let Some(fanout) = inner.fanouts.remove(&key) {
                inner.retire(&key, &fanout, true);
            }
        }
        result
    }

    pub fn remove_viewer(&self, machine_id: &str, browser_id: &str, id: u64) -> Vec<NodeAction> {
        self.with(machine_id, browser_id, |f| f.remove_viewer(id))
    }

    pub fn set_params(
        &self,
        machine_id: &str,
        browser_id: &str,
        id: u64,
        params: Params,
    ) -> Vec<NodeAction> {
        self.with(machine_id, browser_id, |f| f.set_params(id, params))
    }

    pub fn viewer_ack(&self, machine_id: &str, browser_id: &str, id: u64) -> Vec<NodeAction> {
        self.with(machine_id, browser_id, |f| f.viewer_ack(id))
    }

    /// A frame from the node. With nobody watching, the node should not be
    /// streaming at all, so tell it to stop.
    pub fn on_frame(&self, machine_id: &str, browser_id: &str, frame: Frame) -> Vec<NodeAction> {
        let mut inner = self.inner.lock().unwrap();
        let key = (machine_id.to_string(), browser_id.to_string());
        if let Some(fanout) = inner.fanouts.get_mut(&key) {
            return fanout.on_frame(frame);
        }
        // Reuse (do not advance) the last epoch: a newer Start still wins.
        let epoch = inner
            .last_epochs
            .get(&key)
            .copied()
            .unwrap_or(inner.epoch_clock);
        vec![NodeAction::Stop(epoch)]
    }

    /// The browser went away: viewers get `Destroyed` and the fan-out ends.
    pub fn destroy(&self, machine_id: &str, browser_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let key = (machine_id.to_string(), browser_id.to_string());
        if let Some(mut fanout) = inner.fanouts.remove(&key) {
            fanout.destroy();
            inner.retire(&key, &fanout, false);
        }
        inner.last_epochs.remove(&key);
    }

    /// Every browser of a machine went away (it disconnected).
    pub fn destroy_machine(&self, machine_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        let keys: Vec<_> = inner
            .fanouts
            .keys()
            .filter(|(m, _)| m == machine_id)
            .cloned()
            .collect();
        for key in keys {
            if let Some(mut fanout) = inner.fanouts.remove(&key) {
                fanout.destroy();
                inner.retire(&key, &fanout, false);
            }
        }
        inner.last_epochs.retain(|(m, _), _| m != machine_id);
    }

    /// The node (re)connected and reported which browsers it has: viewers of
    /// the ones that survived need their screencast started again, viewers of
    /// the ones that did not are told they are gone.
    pub fn resync_machine(
        &self,
        machine_id: &str,
        present: &dyn Fn(&str) -> bool,
    ) -> Vec<(String, NodeAction)> {
        let mut inner = self.inner.lock().unwrap();
        let keys: Vec<_> = inner
            .fanouts
            .keys()
            .filter(|(m, _)| m == machine_id)
            .cloned()
            .collect();
        let mut actions = Vec::new();
        for key in keys {
            if present(&key.1) {
                if let Some(action) = inner.fanouts.get_mut(&key).and_then(Fanout::restart_action) {
                    actions.push((key.1.clone(), action));
                }
            } else if let Some(mut fanout) = inner.fanouts.remove(&key) {
                fanout.destroy();
                inner.retire(&key, &fanout, false);
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(n: u8) -> Frame {
        Frame {
            meta: Bytes::from_static(b"{}"),
            jpeg: Bytes::from(vec![0xFF, 0xD8, n]),
        }
    }

    fn jpeg_of(msg: ViewerMsg) -> u8 {
        match msg {
            ViewerMsg::Frame(f) => f.jpeg[2],
            ViewerMsg::Destroyed => panic!("unexpected destroyed"),
        }
    }

    #[test]
    fn clamps_params() {
        assert_eq!(
            Params::clamped(10, 99999, 5),
            Params {
                max_width: 200,
                max_height: 1920,
                quality: 20
            }
        );
        assert_eq!(Params::clamped(640, 480, 99).quality, 90);
    }

    #[test]
    fn viewer_gets_one_frame_until_it_acks_and_node_is_acked_once() {
        let mut f = Fanout::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        assert_eq!(
            f.add_viewer(1, Params::default(), tx),
            vec![NodeAction::Start(Params::default(), 1)]
        );
        assert!(f.on_frame(frame(1)).is_empty());
        assert_eq!(jpeg_of(rx.try_recv().unwrap()), 1);
        // Frame 2 arrives (node got no ack yet in reality, but the fan-out
        // must still hold it back): the viewer has not acked frame 1.
        assert!(f.on_frame(frame(2)).is_empty());
        assert!(rx.try_recv().is_err(), "second frame sent before ack");
        // Ack: the node is acked, and the held frame goes out.
        assert_eq!(f.viewer_ack(1), vec![NodeAction::Ack]);
        assert_eq!(jpeg_of(rx.try_recv().unwrap()), 2);
        // Acking the held frame acks it at the node too; a further ack with
        // nothing outstanding changes nothing.
        assert_eq!(f.viewer_ack(1), vec![NodeAction::Ack]);
        assert!(f.viewer_ack(1).is_empty());
    }

    #[test]
    fn slow_viewer_skips_frames_and_does_not_stall_the_fast_one() {
        let mut f = Fanout::default();
        let (fast_tx, mut fast) = mpsc::unbounded_channel();
        let (slow_tx, mut slow) = mpsc::unbounded_channel();
        f.add_viewer(1, Params::default(), fast_tx);
        f.add_viewer(2, Params::default(), slow_tx);
        f.on_frame(frame(1));
        assert_eq!(jpeg_of(fast.try_recv().unwrap()), 1);
        assert_eq!(jpeg_of(slow.try_recv().unwrap()), 1);
        // The fast viewer acks: the node is acked even though the slow one has not.
        assert_eq!(f.viewer_ack(1), vec![NodeAction::Ack]);
        f.on_frame(frame(2));
        assert_eq!(jpeg_of(fast.try_recv().unwrap()), 2);
        assert!(slow.try_recv().is_err());
        assert_eq!(f.viewer_ack(1), vec![NodeAction::Ack]);
        f.on_frame(frame(3));
        assert_eq!(jpeg_of(fast.try_recv().unwrap()), 3);
        // The slow viewer finally acks frame 1: no node ack (already acked),
        // and it jumps to the newest frame, skipping 2.
        assert!(f.viewer_ack(2).is_empty());
        assert_eq!(jpeg_of(slow.try_recv().unwrap()), 3);
        assert!(slow.try_recv().is_err());
    }

    #[test]
    fn params_follow_the_largest_viewer_and_stop_follows_the_last() {
        let mut f = Fanout::default();
        let small = Params::clamped(640, 400, 40);
        let big = Params::clamped(1600, 900, 80);
        let (a_tx, _a) = mpsc::unbounded_channel();
        let (b_tx, _b) = mpsc::unbounded_channel();
        assert_eq!(
            f.add_viewer(1, small, a_tx),
            vec![NodeAction::Start(small, 1)]
        );
        assert_eq!(f.add_viewer(2, big, b_tx), vec![NodeAction::Start(big, 2)]);
        // Dropping the big one falls back to the small one's parameters.
        assert_eq!(f.remove_viewer(2), vec![NodeAction::Start(small, 3)]);
        assert_eq!(f.set_params(1, big), vec![NodeAction::Start(big, 4)]);
        assert!(f.set_params(1, big).is_empty());
        assert_eq!(f.remove_viewer(1), vec![NodeAction::Stop(5)]);
        assert!(f.remove_viewer(1).is_empty());
    }

    #[test]
    fn new_viewer_sees_the_latest_frame_of_a_static_page() {
        let mut f = Fanout::default();
        let (a_tx, _a) = mpsc::unbounded_channel();
        f.add_viewer(1, Params::default(), a_tx);
        f.on_frame(frame(7));
        f.viewer_ack(1);
        let (b_tx, mut b) = mpsc::unbounded_channel();
        f.add_viewer(2, Params::default(), b_tx);
        assert_eq!(jpeg_of(b.try_recv().unwrap()), 7);
        // That replay was already acked at the node: no second ack.
        assert!(f.viewer_ack(2).is_empty());
    }

    #[test]
    fn streams_stop_on_last_viewer_and_destroy_notifies() {
        let streams = Streams::default();
        let (a, mut a_rx, actions) = streams.add_viewer("m", "b", Params::default());
        let NodeAction::Start(_, e1) = actions[0] else {
            panic!("{actions:?}")
        };
        let (b, _b_rx, actions) = streams.add_viewer("m", "b", Params::default());
        assert!(actions.is_empty());
        assert!(streams.remove_viewer("m", "b", a).is_empty());
        let stop = streams.remove_viewer("m", "b", b);
        assert_eq!(stop, vec![NodeAction::Stop(e1 + 1)]);
        // The fan-out is gone; a straggler frame makes us tell the node to
        // stop, with the last epoch.
        assert_eq!(
            streams.on_frame("m", "b", frame(1)),
            vec![NodeAction::Stop(e1 + 1)]
        );

        let (_c, mut c_rx, _) = streams.add_viewer("m", "b2", Params::default());
        streams.destroy("m", "b2");
        assert!(matches!(c_rx.try_recv().unwrap(), ViewerMsg::Destroyed));
        assert!(a_rx.try_recv().is_err());
    }

    #[test]
    fn frames_without_viewers_are_acked_to_the_node() {
        let mut f = Fanout::default();
        assert_eq!(f.on_frame(frame(1)), vec![NodeAction::Ack]);
    }

    #[test]
    fn resync_restarts_survivors_and_destroys_the_rest() {
        let streams = Streams::default();
        let p = Params::default();
        let (_a, _a_rx, _) = streams.add_viewer("m", "kept", p);
        let (_b, mut b_rx, _) = streams.add_viewer("m", "lost", p);
        let actions = streams.resync_machine("m", &|id| id == "kept");
        assert!(matches!(
            actions.as_slice(),
            [(id, NodeAction::Start(q, _))] if id == "kept" && *q == p
        ));
        assert!(matches!(b_rx.try_recv().unwrap(), ViewerMsg::Destroyed));
    }

    fn epoch_of(action: &NodeAction) -> u64 {
        match action {
            NodeAction::Start(_, e) | NodeAction::Stop(e) => *e,
            NodeAction::Ack => panic!("ack has no epoch"),
        }
    }

    #[test]
    fn start_stop_start_epochs_strictly_increase_across_fanout_removal() {
        let streams = Streams::default();
        let p = Params::default();
        let (a, _a_rx, start1) = streams.add_viewer("m", "b", p);
        let stop = streams.remove_viewer("m", "b", a);
        let (_c, _c_rx, start2) = streams.add_viewer("m", "b", p);
        let epochs = [&start1[0], &stop[0], &start2[0]].map(epoch_of);
        assert!(epochs[0] < epochs[1] && epochs[1] < epochs[2], "{epochs:?}");
    }

    #[test]
    fn straggler_stop_reuses_last_epoch_and_loses_to_a_newer_start() {
        let streams = Streams::default();
        let p = Params::default();
        let (a, _a_rx, _) = streams.add_viewer("m", "b", p);
        let stop = streams.remove_viewer("m", "b", a);
        let straggler = streams.on_frame("m", "b", frame(1));
        assert_eq!(epoch_of(&straggler[0]), epoch_of(&stop[0]));
        // Repeated stragglers do not advance it either.
        assert_eq!(streams.on_frame("m", "b", frame(2)), straggler);
        // A viewer joins afterwards; a straggler Stop sent before it (lower
        // epoch) is older than the Start.
        let (_c, _c_rx, start) = streams.add_viewer("m", "b", p);
        assert!(epoch_of(&straggler[0]) < epoch_of(&start[0]));
    }

    #[test]
    fn epochs_stay_ahead_after_the_browser_is_destroyed() {
        let streams = Streams::default();
        let p = Params::default();
        let (_a, _rx, start1) = streams.add_viewer("m", "b", p);
        streams.destroy("m", "b");
        let (_b, _rx2, start2) = streams.add_viewer("m", "b", p);
        assert!(epoch_of(&start1[0]) < epoch_of(&start2[0]));
    }
}
