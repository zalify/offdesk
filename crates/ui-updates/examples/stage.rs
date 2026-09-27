//! Test/support helper. Never called by the application or exposed to WebViews.
use base64::{engine::general_purpose::STANDARD, Engine};
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("stage <private UI store directory> <fixture directory> <public-key-file> <macos|android>".into());
    }
    let key = std::fs::read_to_string(&args[3]).map_err(|e| e.to_string())?;
    let key: [u8; 32] = STANDARD
        .decode(key.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "Invalid key")?;
    let fixture = std::path::Path::new(&args[2]);
    let envelope = serde_json::from_slice(
        &std::fs::read(fixture.join("latest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut store = offdesk_ui_updates::Store::open(args[1].clone().into(), key, "rc", &args[4])?;
    store.stage(
        envelope,
        &std::fs::read(fixture.join("bundle.json")).map_err(|e| e.to_string())?,
    )?;
    println!(
        "{}",
        serde_json::to_string(&store.status()).map_err(|e| e.to_string())?
    );
    Ok(())
}
