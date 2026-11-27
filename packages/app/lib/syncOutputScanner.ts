// DEC Mode 2026 Synchronized Output markers:
// BSU: ESC [ ? 2 0 2 6 h   |   ESU: ESC [ ? 2 0 2 6 l
const SYNC_MARKER_PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36] as const;

/**
 * Scans a stream chunk for DEC Mode 2026 Begin/End Synchronized Update markers
 * across chunk boundaries. Returns the updated `inSync` state and the trailing
 * 7 bytes to carry into the next chunk.
 */
export function scanSyncUpdateMarkers(
  tail: Uint8Array,
  chunk: Uint8Array,
  inSync: boolean,
): { inSync: boolean; nextTail: Uint8Array } {
  let combined: Uint8Array;
  if (tail.length > 0) {
    combined = new Uint8Array(tail.length + chunk.length);
    combined.set(tail, 0);
    combined.set(chunk, tail.length);
  } else {
    combined = chunk;
  }
  let state = inSync;
  const limit = combined.length - 8;
  for (let i = 0; i <= limit; i++) {
    if (
      combined[i] === SYNC_MARKER_PREFIX[0] &&
      combined[i + 1] === SYNC_MARKER_PREFIX[1] &&
      combined[i + 2] === SYNC_MARKER_PREFIX[2] &&
      combined[i + 3] === SYNC_MARKER_PREFIX[3] &&
      combined[i + 4] === SYNC_MARKER_PREFIX[4] &&
      combined[i + 5] === SYNC_MARKER_PREFIX[5] &&
      combined[i + 6] === SYNC_MARKER_PREFIX[6]
    ) {
      const code = combined[i + 7];
      if (code === 0x68 /* 'h' */) {
        state = true;
        i += 7;
      } else if (code === 0x6c /* 'l' */) {
        state = false;
        i += 7;
      }
    }
  }
  const keep = Math.min(7, combined.length);
  const nextTail = keep > 0 ? combined.slice(combined.length - keep) : new Uint8Array(0);
  return { inSync: state, nextTail };
}
