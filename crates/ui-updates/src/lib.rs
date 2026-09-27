//! Signed UI releases, immutable asset snapshots and crash-safe activation.
//! No networking, WebView, credentials or Hub state belongs in this module.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

pub const BRIDGE_VERSION: u32 = 1;
pub const MAX_MANIFEST: usize = 32 * 1024;
pub const MAX_BUNDLE: usize = 48 * 1024 * 1024;
pub const MAX_FILES: usize = 4096;
const MAX_DECODED: usize = 36 * 1024 * 1024;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub sequence: u64,
    pub version: String,
    pub channel: String,
    pub min_bridge: u32,
    pub max_bridge: u32,
    pub platforms: Vec<String>,
    pub url: String,
    pub sha256: String,
    pub size: usize,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bundle {
    pub format: u32,
    pub version: String,
    pub files: BTreeMap<String, String>,
}
pub struct Loaded {
    pub manifest: Manifest,
    pub files: BTreeMap<String, Vec<u8>>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Release {
    manifest: Manifest,
    envelope: Envelope,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct State {
    current: Option<Release>,
    previous: Option<Release>,
    pending: Option<Release>,
    booting: bool,
    highest_sequence: u64,
}
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub bridge_version: u32,
    pub channel: String,
    pub current_version: Option<String>,
    pub pending_version: Option<String>,
    pub highest_sequence: u64,
}
pub struct Store {
    root: PathBuf,
    key: [u8; 32],
    channel: String,
    platform: String,
    state: State,
}

pub fn verify(
    envelope: &Envelope,
    key: &[u8; 32],
    channel: &str,
    platform: &str,
) -> Result<Manifest> {
    if envelope.payload.len() > MAX_MANIFEST {
        return Err("UI manifest is too large".into());
    }
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "Invalid UI signature")?;
    let signature = Signature::from_slice(&signature).map_err(|_| "Invalid UI signature")?;
    VerifyingKey::from_bytes(key)
        .map_err(|_| "Invalid UI release key")?
        .verify_strict(envelope.payload.as_bytes(), &signature)
        .map_err(|_| "UI signature verification failed")?;
    let manifest: Manifest = serde_json::from_str(&envelope.payload).map_err(|e| e.to_string())?;
    if manifest.format != 1
        || manifest.sequence == 0
        || manifest.version.is_empty()
        || manifest.version.len() > 100
        || manifest.channel != channel
        || !manifest.platforms.iter().any(|p| p == platform)
        || manifest.min_bridge > BRIDGE_VERSION
        || manifest.max_bridge < BRIDGE_VERSION
        || manifest.size == 0
        || manifest.size > MAX_BUNDLE
        || manifest.sha256.len() != 64
        || !manifest
            .sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("UI release is incompatible with this shell".into());
    }
    // A signed manifest can select only immutable assets in the official repository.
    if !manifest
        .url
        .starts_with("https://github.com/zalify/offdesk/releases/download/ui-")
        || manifest.url.contains(['?', '#', '\\'])
        || manifest.url.contains("..")
    {
        return Err("UI release has an unsupported download address".into());
    }
    Ok(manifest)
}

pub fn decode(manifest: Manifest, bytes: &[u8]) -> Result<Loaded> {
    if bytes.len() != manifest.size
        || bytes.len() > MAX_BUNDLE
        || hex::encode(Sha256::digest(bytes)) != manifest.sha256
    {
        return Err("UI bundle integrity check failed".into());
    }
    let bundle: Bundle = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if bundle.format != 1 || bundle.version != manifest.version || bundle.files.len() > MAX_FILES {
        return Err("Invalid UI bundle".into());
    }
    let mut files = BTreeMap::new();
    let mut total = 0usize;
    for (path, contents) in bundle.files {
        if !valid_path(&path) {
            return Err("Invalid UI asset path".into());
        }
        let bytes = STANDARD
            .decode(contents)
            .map_err(|_| "Invalid UI asset encoding")?;
        total = total
            .checked_add(bytes.len())
            .ok_or("UI bundle is too large")?;
        if total > MAX_DECODED {
            return Err("UI bundle is too large".into());
        }
        files.insert(path, bytes);
    }
    if files.get("index.html").is_none_or(|b| b.is_empty()) {
        return Err("UI bundle has no entry page".into());
    }
    Ok(Loaded { manifest, files })
}
fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() < 1024
        && !path.contains(['\\', ':', '\0', '?', '#', '%'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn read_limited(path: &Path, limit: usize) -> Result<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("UI file exceeds size limit".into());
    }
    Ok(bytes)
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    fs::File::open(path.parent().ok_or("Missing UI directory")?)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
impl Store {
    pub fn open(root: PathBuf, key: [u8; 32], channel: &str, platform: &str) -> Result<Self> {
        fs::create_dir_all(root.join("releases")).map_err(|e| e.to_string())?;
        let path = root.join("state.json");
        // Corrupt state fails closed; never reset the replay counter implicitly.
        let state = if path.exists() {
            serde_json::from_slice(&read_limited(&path, MAX_MANIFEST * 8)?)
                .map_err(|e| e.to_string())?
        } else {
            State::default()
        };
        Ok(Self {
            root,
            key,
            channel: channel.into(),
            platform: platform.into(),
            state,
        })
    }
    fn save(&self) -> Result<()> {
        atomic_write(
            &self.root.join("state.json"),
            &serde_json::to_vec(&self.state).map_err(|e| e.to_string())?,
        )
    }
    pub fn status(&self) -> Status {
        Status {
            bridge_version: BRIDGE_VERSION,
            channel: self.channel.clone(),
            current_version: self
                .state
                .current
                .as_ref()
                .map(|r| r.manifest.version.clone()),
            pending_version: self
                .state
                .pending
                .as_ref()
                .map(|r| r.manifest.version.clone()),
            highest_sequence: self.state.highest_sequence,
        }
    }
    pub fn verify_manifest(&self, envelope: &Envelope) -> Result<Manifest> {
        verify(envelope, &self.key, &self.channel, &self.platform)
    }
    fn load(&self, release: &Release) -> Result<Loaded> {
        let manifest = self.verify_manifest(&release.envelope)?;
        // Never derive a filesystem path from unsigned saved metadata.
        decode(
            manifest.clone(),
            &read_limited(
                &self
                    .root
                    .join("releases")
                    .join(format!("{}.json", manifest.sha256)),
                MAX_BUNDLE,
            )?,
        )
    }
    pub fn stage(&mut self, envelope: Envelope, bytes: &[u8]) -> Result<bool> {
        let manifest = self.verify_manifest(&envelope)?;
        if manifest.sequence <= self.state.highest_sequence {
            return Ok(false);
        }
        let loaded = decode(manifest.clone(), bytes)?;
        drop(loaded);
        atomic_write(
            &self
                .root
                .join("releases")
                .join(format!("{}.json", manifest.sha256)),
            bytes,
        )?;
        self.state.highest_sequence = manifest.sequence;
        self.state.pending = Some(Release { manifest, envelope });
        self.save()?;
        Ok(true)
    }
    /// Called once before creating a WebView. An unfinished prior boot falls back.
    pub fn begin_boot(&mut self) -> Result<Option<Loaded>> {
        if self.state.booting {
            self.state.current = self.state.previous.take();
        }
        if let Some(pending) = self.state.pending.take() {
            self.state.previous = self.state.current.take();
            self.state.current = Some(pending);
        }
        let loaded = self
            .state
            .current
            .as_ref()
            .and_then(|release| self.load(release).ok());
        let loaded = if loaded.is_none() && self.state.current.is_some() {
            self.state.current = self.state.previous.take();
            self.state
                .current
                .as_ref()
                .and_then(|release| self.load(release).ok())
        } else {
            loaded
        };
        if loaded.is_none() {
            self.state.current = None;
        }
        self.state.booting = loaded.is_some();
        self.save()?;
        self.prune();
        Ok(loaded)
    }
    pub fn ready(&mut self, version: &str) -> Result<()> {
        if self
            .state
            .current
            .as_ref()
            .map(|r| r.manifest.version.as_str())
            != Some(version)
        {
            return Err("UI ready version does not match running release".into());
        }
        self.state.booting = false;
        self.save()
    }
    /// Used before reloading only when startup has failed, or explicit recovery.
    pub fn rollback(&mut self) -> Result<Option<Loaded>> {
        self.state.current = self.state.previous.take();
        self.state.pending = None;
        self.state.booting = false;
        self.begin_boot()
    }
    fn prune(&self) {
        let keep: Vec<_> = [
            &self.state.current,
            &self.state.previous,
            &self.state.pending,
        ]
        .into_iter()
        .flatten()
        .map(|r| format!("{}.json", r.manifest.sha256))
        .collect();
        if let Ok(entries) = fs::read_dir(self.root.join("releases")) {
            for entry in entries.flatten() {
                if !keep.iter().any(|name| entry.file_name() == name.as_str()) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn fixture(sequence: u64) -> (Envelope, Vec<u8>, [u8; 32]) {
        let key = SigningKey::from_bytes(&[7; 32]);
        let version = format!("test-{sequence}");
        let bytes = serde_json::to_vec(&Bundle {
            format: 1,
            version: version.clone(),
            files: BTreeMap::from([
                (
                    "index.html".into(),
                    STANDARD.encode(format!("<html>{version}</html>")),
                ),
                (
                    "assets/test.js".into(),
                    STANDARD.encode("console.log('你好')"),
                ),
            ]),
        })
        .unwrap();
        let manifest = Manifest { format: 1, sequence, version, channel: "rc".into(), min_bridge: 1, max_bridge: 1,
            platforms: vec!["macos".into(), "android".into()], url: format!("https://github.com/zalify/offdesk/releases/download/ui-test-{sequence}/bundle.json"),
            sha256: hex::encode(Sha256::digest(&bytes)), size: bytes.len() };
        let payload = serde_json::to_string(&manifest).unwrap();
        let signature = STANDARD.encode(key.sign(payload.as_bytes()).to_bytes());
        (
            Envelope { payload, signature },
            bytes,
            key.verifying_key().to_bytes(),
        )
    }
    fn resign(envelope: &mut Envelope, mutate: impl FnOnce(&mut Manifest)) {
        let mut manifest: Manifest = serde_json::from_str(&envelope.payload).unwrap();
        mutate(&mut manifest);
        envelope.payload = serde_json::to_string(&manifest).unwrap();
        envelope.signature = STANDARD.encode(
            SigningKey::from_bytes(&[7; 32])
                .sign(envelope.payload.as_bytes())
                .to_bytes(),
        );
    }
    #[test]
    fn signature_and_bundle_tampering_fail() {
        let (mut envelope, mut bytes, key) = fixture(1);
        let manifest = verify(&envelope, &key, "rc", "android").unwrap();
        assert!(decode(manifest.clone(), &bytes).is_ok());
        bytes[5] ^= 1;
        assert!(decode(manifest, &bytes).is_err());
        envelope.payload.push(' ');
        assert!(verify(&envelope, &key, "rc", "android").is_err());
        assert!(verify(&fixture(1).0, &[8; 32], "rc", "android").is_err());
    }
    #[test]
    fn incompatible_release_and_external_urls_fail() {
        let (env, _, key) = fixture(1);
        assert!(verify(&env, &key, "stable", "android").is_err());
        assert!(verify(&env, &key, "rc", "ios").is_err());
        for change in [
            (
                2,
                2,
                "https://github.com/zalify/offdesk/releases/download/ui-x/bundle.json",
            ),
            (
                0,
                0,
                "https://github.com/zalify/offdesk/releases/download/ui-x/bundle.json",
            ),
            (1, 1, "https://attacker.invalid/ui.json"),
            (
                1,
                1,
                "https://github.com/zalify/offdesk/releases/download/ui-x/../evil",
            ),
        ] {
            let mut env = env.clone();
            resign(&mut env, |m| {
                m.min_bridge = change.0;
                m.max_bridge = change.1;
                m.url = change.2.into();
            });
            assert!(verify(&env, &key, "rc", "android").is_err());
        }
    }
    #[test]
    fn unsafe_paths_and_missing_entry_fail_even_when_signed() {
        for path in [
            "../index.html",
            "/index.html",
            "a/../b",
            "a\\b",
            "a%2fb",
            "a//b",
            "a:b",
            "safe.js",
        ] {
            let (mut envelope, _, key) = fixture(1);
            let bytes = serde_json::to_vec(&Bundle {
                format: 1,
                version: "test-1".into(),
                files: BTreeMap::from([(path.into(), STANDARD.encode("x"))]),
            })
            .unwrap();
            resign(&mut envelope, |m| {
                m.size = bytes.len();
                m.sha256 = hex::encode(Sha256::digest(&bytes));
            });
            assert!(
                decode(verify(&envelope, &key, "rc", "macos").unwrap(), &bytes).is_err(),
                "{path}"
            );
        }
    }
    #[test]
    fn update_only_activates_at_next_boot_and_retains_last_good() {
        let dir = tempfile::tempdir().unwrap();
        let (env, bytes, key) = fixture(1);
        let mut store = Store::open(dir.path().into(), key, "rc", "macos").unwrap();
        assert!(store.begin_boot().unwrap().is_none());
        assert!(store.stage(env, &bytes).unwrap());
        assert_eq!(store.status().current_version, None);
        assert_eq!(store.status().pending_version, Some("test-1".into()));
        assert_eq!(
            store.begin_boot().unwrap().unwrap().manifest.version,
            "test-1"
        );
        assert!(store.ready("wrong-version").is_err());
        store.ready("test-1").unwrap();
        let (env, bytes, _) = fixture(2);
        store.stage(env, &bytes).unwrap();
        assert_eq!(
            store.begin_boot().unwrap().unwrap().manifest.version,
            "test-2"
        );
        // Simulate process death before the UI is ready.
        drop(store);
        let mut store = Store::open(dir.path().into(), key, "rc", "macos").unwrap();
        assert_eq!(
            store.begin_boot().unwrap().unwrap().manifest.version,
            "test-1"
        );
        store.ready("test-1").unwrap();
        assert_eq!(store.status().highest_sequence, 2);
    }
    #[test]
    fn failed_first_update_returns_to_bundled_and_is_not_replayed() {
        let dir = tempfile::tempdir().unwrap();
        let (env, bytes, key) = fixture(1);
        let mut store = Store::open(dir.path().into(), key, "rc", "android").unwrap();
        store.stage(env.clone(), &bytes).unwrap();
        store.begin_boot().unwrap();
        assert!(store.rollback().unwrap().is_none());
        assert!(!store.stage(env, &bytes).unwrap());
        assert_eq!(store.status().highest_sequence, 1);
    }
    #[test]
    fn interrupted_or_corrupt_download_preserves_pending_and_current() {
        let dir = tempfile::tempdir().unwrap();
        let (env, bytes, key) = fixture(1);
        let mut store = Store::open(dir.path().into(), key, "rc", "macos").unwrap();
        store.stage(env, &bytes).unwrap();
        store.begin_boot().unwrap();
        store.ready("test-1").unwrap();
        let (env, bytes, _) = fixture(2);
        assert!(store.stage(env, &bytes[..bytes.len() - 1]).is_err());
        assert_eq!(store.status().current_version, Some("test-1".into()));
        assert_eq!(store.status().highest_sequence, 1);
        assert!(store.status().pending_version.is_none());
    }
    #[test]
    fn on_disk_tampering_falls_back_without_loading_mixed_assets() {
        let dir = tempfile::tempdir().unwrap();
        let (env, bytes, key) = fixture(1);
        let mut store = Store::open(dir.path().into(), key, "rc", "macos").unwrap();
        let hash = verify(&env, &key, "rc", "macos").unwrap().sha256;
        store.stage(env, &bytes).unwrap();
        fs::write(
            dir.path().join("releases").join(format!("{hash}.json")),
            "corrupt",
        )
        .unwrap();
        assert!(store.begin_boot().unwrap().is_none());
        assert_eq!(store.status().highest_sequence, 1);
    }
    #[test]
    fn corrupt_state_never_resets_replay_protection() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("state.json"), "broken").unwrap();
        assert!(Store::open(dir.path().into(), [7; 32], "rc", "macos").is_err());
    }
    #[test]
    fn newer_sequence_can_restore_an_older_known_ui() {
        let dir = tempfile::tempdir().unwrap();
        let (env, bytes, key) = fixture(2);
        let mut store = Store::open(dir.path().into(), key, "rc", "macos").unwrap();
        store.stage(env, &bytes).unwrap();
        store.begin_boot().unwrap();
        store.ready("test-2").unwrap();
        let (mut env, bytes, _) = fixture(1);
        resign(&mut env, |m| m.sequence = 3);
        assert!(store.stage(env, &bytes).unwrap());
        assert_eq!(
            store.begin_boot().unwrap().unwrap().manifest.version,
            "test-1"
        );
    }
}
