//! deflate-raw-v1: in-protocol compression of terminal output streams.
//!
//! Raw DEFLATE (no zlib header), window bits 15 (flate2's default), level 6,
//! context takeover across messages — one long-lived compressor per attach on
//! the machine, one long-lived inflater per attach socket in the browser.
//! Every outgoing WS message ends with `FlushCompress::Sync`; the trailing
//! `00 00 ff ff` stays ON the wire (this is not RFC 7692 framing) so the
//! browser can feed message concatenations straight into one streaming
//! inflater, which keeps hub- and browser-side chunk merging valid.

use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// Capability token negotiated machine→hub→browser. The hub enables
/// compression for an attach only when the browser asked for this exact algo
/// AND the machine declared it in `MachineToHub::Register::capabilities`.
pub const DEFLATE_RAW_V1: &str = "deflate-raw-v1";

/// Compressor for one attach's output stream. Created at OpenAttach with
/// `compress: true`, dropped at CloseAttach.
pub struct AttachCompressor {
    inner: Compress,
}

impl AttachCompressor {
    pub fn new() -> Self {
        // Raw deflate (zlib_header=false), level 3: ~3x faster CPU per
        // SyncFlush frame than level 6 with nearly identical ratio on ANSI
        // terminal streams.
        Self {
            inner: Compress::new(Compression::new(3), false),
        }
    }

    /// Compress one outgoing WS message with a sync flush at the boundary.
    pub fn compress_message(&mut self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + 64);
        let mut input = data;
        // compress_vec writes into spare capacity only. Loop until all input
        // is consumed AND the flush had room to finish (output buffer not
        // filled to capacity). Note "output stalls" is NOT a valid completion
        // signal here: a sync-flush call with empty input re-emits an empty
        // stored block every time, so total_out never stops advancing.
        loop {
            if out.capacity() == out.len() {
                out.reserve(32 * 1024);
            }
            let before_in = self.inner.total_in();
            self.inner
                .compress_vec(input, &mut out, FlushCompress::Sync)
                .expect("deflate compression failed");
            input = &input[(self.inner.total_in() - before_in) as usize..];
            if input.is_empty() && out.len() < out.capacity() {
                break;
            }
        }
        out
    }
}

impl Default for AttachCompressor {
    fn default() -> Self {
        Self::new()
    }
}

/// Streaming inflater for one attach stream; consumes arbitrary splits and
/// concatenations of compressed messages (mirrors the browser's fflate
/// `Inflate` usage in tests and any Rust-side verification).
pub struct AttachInflater {
    inner: Decompress,
}

impl AttachInflater {
    pub fn new() -> Self {
        Self {
            inner: Decompress::new(false),
        }
    }

    /// Feed compressed bytes; returns everything inflated from this input.
    /// Handles arbitrary splits/merges of the compressed message stream.
    pub fn push(&mut self, data: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::with_capacity(data.len() * 3 + 64);
        let mut input = data;
        loop {
            if out.capacity() == out.len() {
                out.reserve(32 * 1024);
            }
            let before_in = self.inner.total_in();
            let before_out = self.inner.total_out();
            let status = self
                .inner
                .decompress_vec(input, &mut out, FlushDecompress::None)
                .map_err(|e| format!("inflate failed: {e}"))?;
            input = &input[(self.inner.total_in() - before_in) as usize..];
            if status == Status::StreamEnd {
                break;
            }
            if input.is_empty() && self.inner.total_out() == before_out {
                break; // needs more input
            }
        }
        Ok(out)
    }
}

impl Default for AttachInflater {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{AttachCompressor, AttachInflater, DEFLATE_RAW_V1};

    /// Realistic-ish ANSI output: colored rows, repeated status lines, and a
    /// tmux-style full-screen redraw.
    fn sample_messages() -> Vec<Vec<u8>> {
        let mut messages = Vec::new();
        for i in 0..8 {
            messages.push(
                format!(
                    "\x1b[38;5;246mdrwxr-xr-x  2 user user 4096 Aug 30 10:{i:02} dir-{i}\x1b[0m\r\n"
                )
                .into_bytes(),
            );
        }
        for _ in 0..4 {
            messages.push(b"\x1b[2K\rbuilding crate offdesk ... 128/256\r\n".to_vec());
        }
        // Full redraw: home + clear + the same screen contents again.
        let mut redraw = b"\x1b[H\x1b[2J".to_vec();
        for i in 0..8 {
            redraw.extend_from_slice(
                format!(
                    "\x1b[38;5;246mdrwxr-xr-x  2 user user 4096 Aug 30 10:{i:02} dir-{i}\x1b[0m\r\n"
                )
                .as_bytes(),
            );
        }
        messages.push(redraw);
        messages
    }

    #[test]
    fn deflate_raw_v1_round_trips_a_message_stream() {
        let messages = sample_messages();
        let mut compressor = AttachCompressor::new();
        let mut wire = Vec::new();
        for message in &messages {
            wire.extend_from_slice(&compressor.compress_message(message));
        }

        let mut inflater = AttachInflater::new();
        let mut output = inflater.push(&wire).unwrap();
        output.extend_from_slice(&inflater.push(&[]).unwrap_or_default());
        let expected: Vec<u8> = messages.concat();
        assert_eq!(output, expected);
    }

    #[test]
    fn inflater_handles_arbitrary_input_splits_and_merges() {
        // Simulate hub/browser-side merging: compressed messages concatenated,
        // then re-split at boundaries unrelated to the original messages.
        let messages = sample_messages();
        let mut compressor = AttachCompressor::new();
        let mut wire = Vec::new();
        for message in &messages {
            wire.extend_from_slice(&compressor.compress_message(message));
        }

        let mut inflater = AttachInflater::new();
        let mut output = Vec::new();
        // Feed in awkward chunk sizes: 1 byte, then 7, then the rest.
        output.extend_from_slice(&inflater.push(&wire[..1]).unwrap());
        let mid = 1 + 7.min(wire.len() - 1);
        output.extend_from_slice(&inflater.push(&wire[1..mid]).unwrap());
        output.extend_from_slice(&inflater.push(&wire[mid..]).unwrap());
        assert_eq!(output, messages.concat());
    }

    #[test]
    fn sync_flush_tail_stays_on_the_wire() {
        let mut compressor = AttachCompressor::new();
        let out = compressor.compress_message(b"hello terminal");
        assert!(
            out.ends_with(&[0x00, 0x00, 0xff, 0xff]),
            "sync flush tail must be kept: {out:02x?}"
        );
    }

    #[test]
    fn context_takeover_compresses_repeated_blocks_well() {
        let block = b"\x1b[38;5;246mdrwxr-xr-x 2 user user 4096 dir\r\n".repeat(16);
        let mut warm = AttachCompressor::new();
        warm.compress_message(&block);
        let second = warm.compress_message(&block);
        // A fresh compressor sees the block for the first time; the warm one
        // must do dramatically better — that only holds if the dictionary
        // survives across messages.
        let mut fresh = AttachCompressor::new();
        let first = fresh.compress_message(&block);
        assert!(
            second.len() * 2 < first.len(),
            "no takeover? first={} second={}",
            first.len(),
            second.len()
        );
    }

    #[test]
    fn algo_token_is_stable() {
        assert_eq!(DEFLATE_RAW_V1, "deflate-raw-v1");
    }
}
