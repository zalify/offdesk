//! Shared pure-Rust GPU terminal engine for Offdesk Desktop, Android, and iOS.
//!
//! - [`hub`]: Async Hub REST + `deflate-raw-v1` WebSocket transport
//! - [`terminal`]: `alacritty_terminal` VT state machine + 10,000-line local scrollback
//! - [`renderer`]: `wgpu + glyphon` GPU renderer supporting both desktop chrome and
//!   full-bleed mobile surfaces (`ANativeWindow` on Android, `CAMetalLayer` on iOS)
//! - [`ffi`]: C-ABI & Android JNI entrypoints (`include/offdesk_term.h`)

pub mod config;
pub mod ffi;
pub mod hub;
pub mod renderer;
pub mod terminal;
