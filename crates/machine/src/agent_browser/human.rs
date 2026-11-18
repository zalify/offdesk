//! Human-like input for the agent's clicks and typing.
//!
//! Bot detection's behavioural layer looks for clicks with no mouse travel
//! and text that appears all at once. Everything here is a pure function of
//! an [`Rng`], so the shapes (paths, delays, plans) are unit-testable with a
//! fixed seed; `frames.rs` only plays the results back over CDP.
//!
//! `OFFDESK_BROWSER_HUMAN_INPUT=0` in the node's environment switches all of
//! it off (instant click at the centre, one `Input.insertText`).

use super::{VIEWPORT_HEIGHT, VIEWPORT_WIDTH};

/// Whether the agent's input imitates a person (default); `=0` turns it off.
pub fn enabled() -> bool {
    std::env::var("OFFDESK_BROWSER_HUMAN_INPUT").map_or(true, |v| v.trim() != "0")
}

/// A tiny splitmix64 generator. Not for secrets: it only has to make timing
/// and paths irregular, and a dependency for that would be heavier than it.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    /// Seeded from a random UUID.
    pub fn from_entropy() -> Self {
        Rng::new(uuid::Uuid::new_v4().as_u128() as u64)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)`.
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in `[lo, hi]`.
    pub fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.f64()
    }

    /// Uniform integer in `[lo, hi]`.
    pub fn int(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next_u64() % (hi - lo + 1)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        self.f64() < p
    }
}

fn max_x() -> f64 {
    VIEWPORT_WIDTH as f64 - 1.0
}

fn max_y() -> f64 {
    VIEWPORT_HEIGHT as f64 - 1.0
}

/// A plausible place for the pointer to be before its first move.
pub fn start_point(rng: &mut Rng) -> (f64, f64) {
    (
        (rng.range(0.15, 0.85) * max_x()).round(),
        (rng.range(0.15, 0.85) * max_y()).round(),
    )
}

/// A point inside the box `(x, y, w, h)` near its centre: up to 25% of the
/// width / height away from it. A side of 6px or less is not jittered.
pub fn click_point(rng: &mut Rng, (x, y, w, h): (f64, f64, f64, f64)) -> (f64, f64) {
    let axis = |rng: &mut Rng, start: f64, len: f64| {
        let center = start + len / 2.0;
        if len <= 6.0 {
            return center;
        }
        let j = len * 0.25;
        (center + rng.range(-j, j)).clamp(start, start + len)
    };
    (axis(rng, x, w), axis(rng, y, h))
}

/// Mouse positions from `from` to `to` along a slightly curved, ease-in-out
/// path of 10 to 25 steps. Starts at `from`'s neighbourhood (the first
/// point is the first step, not `from` itself), ends exactly on `to` and
/// stays inside the viewport on the way.
pub fn mouse_path(rng: &mut Rng, from: (f64, f64), to: (f64, f64)) -> Vec<(f64, f64)> {
    let steps = rng.int(10, 25) as usize;
    let (dx, dy) = (to.0 - from.0, to.1 - from.1);
    let dist = (dx * dx + dy * dy).sqrt();
    // A control point off the straight line, to one side.
    let bend = if dist > 1.0 {
        rng.range(-0.25, 0.25) * dist
    } else {
        0.0
    };
    let (nx, ny) = if dist > 1.0 {
        (-dy / dist, dx / dist)
    } else {
        (0.0, 0.0)
    };
    let t_ctrl = rng.range(0.3, 0.7);
    let ctrl = (
        from.0 + dx * t_ctrl + nx * bend,
        from.1 + dy * t_ctrl + ny * bend,
    );
    let mut path = Vec::with_capacity(steps);
    for i in 1..=steps {
        if i == steps {
            path.push(to);
            break;
        }
        let t = i as f64 / steps as f64;
        let t = t * t * (3.0 - 2.0 * t); // smoothstep: slow, fast, slow
        let u = 1.0 - t;
        let px = u * u * from.0 + 2.0 * u * t * ctrl.0 + t * t * to.0;
        let py = u * u * from.1 + 2.0 * u * t * ctrl.1 + t * t * to.1;
        path.push((
            px.clamp(0.0, max_x()).round(),
            py.clamp(0.0, max_y()).round(),
        ));
    }
    path
}

/// Pauses of one click, in milliseconds.
pub struct ClickTiming {
    /// Between each `mouseMoved` of the path.
    pub step_ms: Vec<u64>,
    /// After arriving, before pressing.
    pub settle_ms: u64,
    /// Between press and release.
    pub hold_ms: u64,
}

pub fn click_timing(rng: &mut Rng, steps: usize) -> ClickTiming {
    ClickTiming {
        step_ms: (0..steps).map(|_| rng.int(6, 16)).collect(),
        settle_ms: rng.int(40, 120),
        hold_ms: rng.int(50, 130),
    }
}

/// One unit of typing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeStep {
    /// A printable ASCII key: down, wait `hold_ms`, up, then wait `gap_ms`.
    Key { ch: char, hold_ms: u64, gap_ms: u64 },
    /// Text with no key of its own on a US layout (CJK, emoji, accents,
    /// `\n`, `\t`) or a chunk of a long text: `Input.insertText`, then wait.
    Insert { text: String, gap_ms: u64 },
}

/// Longest the human-like part of a typing plan takes.
pub const TYPING_BUDGET_MS: u64 = 6000;
/// Characters typed key by key before the rest is inserted in chunks.
const HUMAN_HEAD: usize = 40;
/// Below this per-character delay, typing key by key is not worth it.
const MIN_DELAY_MS: f64 = 4.0;
const TAIL_CHUNKS: usize = 4;

/// Does `ch` have a key on a US keyboard (so it is typed, not inserted)?
pub fn is_typed_key(ch: char) -> bool {
    super::keys::ascii_key(ch).is_some()
}

fn sample_delay(rng: &mut Rng) -> f64 {
    if rng.chance(0.05) {
        rng.range(150.0, 350.0)
    } else {
        rng.range(35.0, 120.0)
    }
}

/// How to type `text`: per-key delays of about 35-120ms (now and then a
/// 150-350ms pause), scaled down so the whole takes at most
/// [`TYPING_BUDGET_MS`]. A text too long for that (per-key delay under 4ms)
/// has its first 40 characters typed and the rest inserted in a few chunks.
pub fn plan_typing(rng: &mut Rng, text: &str) -> Vec<TypeStep> {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }
    let budget = TYPING_BUDGET_MS as f64;
    let (head, tail) = if chars.len() as f64 * MIN_DELAY_MS > budget {
        chars.split_at(HUMAN_HEAD.min(chars.len()))
    } else {
        (&chars[..], &chars[..0])
    };
    // The head may use the whole budget when nothing follows, else half.
    let head_budget = if tail.is_empty() {
        budget
    } else {
        budget / 2.0
    };
    let delays: Vec<f64> = head.iter().map(|_| sample_delay(rng)).collect();
    let total: f64 = delays.iter().sum();
    let scale = if total > head_budget {
        head_budget / total
    } else {
        1.0
    };
    let mut plan: Vec<TypeStep> = head
        .iter()
        .zip(&delays)
        .map(|(&ch, &d)| {
            let delay = (d * scale).round().max(1.0) as u64;
            if is_typed_key(ch) {
                // The hold sits inside this key's slot when it can.
                let hold_ms = (rng.range(20.0, 60.0) * scale).round().max(1.0) as u64;
                let hold_ms = hold_ms.min(delay);
                TypeStep::Key {
                    ch,
                    hold_ms,
                    gap_ms: delay - hold_ms,
                }
            } else {
                TypeStep::Insert {
                    text: ch.to_string(),
                    gap_ms: delay,
                }
            }
        })
        .collect();
    if !tail.is_empty() {
        let per = tail.len().div_ceil(TAIL_CHUNKS);
        for chunk in tail.chunks(per) {
            plan.push(TypeStep::Insert {
                text: chunk.iter().collect(),
                gap_ms: rng.int(30, 80),
            });
        }
    }
    // Nothing to wait for after the last step.
    match plan.last_mut() {
        Some(TypeStep::Key { gap_ms, .. } | TypeStep::Insert { gap_ms, .. }) => *gap_ms = 0,
        None => {}
    }
    plan
}

/// Total time a plan takes, in milliseconds.
#[cfg(test)]
pub fn plan_duration_ms(plan: &[TypeStep]) -> u64 {
    plan.iter()
        .map(|s| match s {
            TypeStep::Key {
                hold_ms, gap_ms, ..
            } => hold_ms + gap_ms,
            TypeStep::Insert { gap_ms, .. } => *gap_ms,
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rng_is_deterministic_and_in_range() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        for _ in 0..100 {
            let v = a.range(3.0, 4.0);
            assert_eq!(v, b.range(3.0, 4.0));
            assert!((3.0..=4.0).contains(&v));
            let n = a.int(5, 9);
            assert_eq!(n, b.int(5, 9));
            assert!((5..=9).contains(&n));
        }
    }

    #[test]
    fn path_ends_on_target_and_stays_inside() {
        for seed in 0..200 {
            let mut rng = Rng::new(seed);
            let from = start_point(&mut rng);
            let to = (
                rng.range(0.0, max_x()).round(),
                rng.range(0.0, max_y()).round(),
            );
            let path = mouse_path(&mut rng, from, to);
            assert!((10..=25).contains(&path.len()), "{}", path.len());
            assert_eq!(*path.last().unwrap(), to);
            for (x, y) in &path {
                assert!((0.0..=max_x()).contains(x) && (0.0..=max_y()).contains(y));
            }
            // It travels: the first step is not already there.
            if (from.0 - to.0).abs() + (from.1 - to.1).abs() > 50.0 {
                assert!(path[0] != to);
            }
        }
    }

    #[test]
    fn path_to_the_same_point_still_ends_there() {
        let mut rng = Rng::new(1);
        let path = mouse_path(&mut rng, (100.0, 100.0), (100.0, 100.0));
        assert_eq!(*path.last().unwrap(), (100.0, 100.0));
    }

    #[test]
    fn click_point_stays_in_the_box_near_the_centre() {
        for seed in 0..500 {
            let mut rng = Rng::new(seed);
            let (x, y, w, h) = (100.0, 200.0, 80.0, 40.0);
            let (px, py) = click_point(&mut rng, (x, y, w, h));
            assert!((x + w * 0.25..=x + w * 0.75).contains(&px), "{px}");
            assert!((y + h * 0.25..=y + h * 0.75).contains(&py), "{py}");
        }
        let mut rng = Rng::new(3);
        assert_eq!(click_point(&mut rng, (10.0, 10.0, 6.0, 4.0)), (13.0, 12.0));
        // One tiny side does not stop the other from varying.
        let (_, py) = click_point(&mut rng, (10.0, 10.0, 4.0, 100.0));
        assert!((35.0..=65.0).contains(&py));
    }

    #[test]
    fn click_timing_is_in_range() {
        let mut rng = Rng::new(5);
        let t = click_timing(&mut rng, 12);
        assert_eq!(t.step_ms.len(), 12);
        assert!(t.step_ms.iter().all(|m| (6..=16).contains(m)));
        assert!((40..=120).contains(&t.settle_ms));
        assert!((50..=130).contains(&t.hold_ms));
    }

    #[test]
    fn short_text_is_typed_key_by_key() {
        let mut rng = Rng::new(11);
        let plan = plan_typing(&mut rng, "Hello, World! 世界");
        assert_eq!(plan.len(), "Hello, World! 世界".chars().count());
        assert!(plan_duration_ms(&plan) <= TYPING_BUDGET_MS);
        assert!(matches!(plan[0], TypeStep::Key { ch: 'H', .. }));
        assert!(matches!(&plan[plan.len() - 1], TypeStep::Insert { text, .. } if text == "界"));
        // Typical pace: tens of ms per key, never zero-delay.
        let slot = |s: &TypeStep| match s {
            TypeStep::Key {
                hold_ms, gap_ms, ..
            } => hold_ms + gap_ms,
            TypeStep::Insert { gap_ms, .. } => *gap_ms,
        };
        for s in &plan[..plan.len() - 1] {
            assert!(slot(s) >= 35, "{s:?}");
        }
    }

    #[test]
    fn medium_text_is_scaled_to_the_budget() {
        for seed in 0..20 {
            let mut rng = Rng::new(seed);
            let text = "abc def ".repeat(60); // 480 chars: ~40s unscaled
            let plan = plan_typing(&mut rng, &text);
            assert_eq!(plan.len(), 480);
            assert!(plan.iter().all(|s| matches!(s, TypeStep::Key { .. })));
            let d = plan_duration_ms(&plan);
            assert!(d <= TYPING_BUDGET_MS + 480, "{d}"); // rounding slack
            assert!(d >= TYPING_BUDGET_MS / 2, "{d}");
        }
    }

    #[test]
    fn long_text_falls_back_to_chunks() {
        let mut rng = Rng::new(9);
        let text: String = (0..2000)
            .map(|i| if i % 50 == 49 { '\n' } else { 'x' })
            .collect();
        let plan = plan_typing(&mut rng, &text);
        assert!(plan.len() < HUMAN_HEAD + 10, "{}", plan.len());
        assert!(plan_duration_ms(&plan) <= TYPING_BUDGET_MS);
        assert!(plan[..HUMAN_HEAD]
            .iter()
            .all(|s| !matches!(s, TypeStep::Insert { text, .. } if text.chars().count() > 1)));
        // Nothing is lost or reordered.
        let mut got = String::new();
        for s in &plan {
            match s {
                TypeStep::Key { ch, .. } => got.push(*ch),
                TypeStep::Insert { text, .. } => got.push_str(text),
            }
        }
        assert_eq!(got, text);
    }

    #[test]
    fn classification_of_characters() {
        for c in ['A', 'a', '!', '?', '5', ' ', '~', '"'] {
            assert!(is_typed_key(c), "{c}");
        }
        for c in ['世', 'é', '\n', '\t', '😀'] {
            assert!(!is_typed_key(c), "{c:?}");
        }
        let mut rng = Rng::new(2);
        let plan = plan_typing(&mut rng, "a\n世");
        assert!(matches!(plan[0], TypeStep::Key { ch: 'a', .. }));
        assert!(matches!(&plan[1], TypeStep::Insert { text, .. } if text == "\n"));
        assert!(matches!(&plan[2], TypeStep::Insert { text, .. } if text == "世"));
    }

    #[test]
    fn empty_text_has_an_empty_plan() {
        assert!(plan_typing(&mut Rng::new(1), "").is_empty());
    }
}
