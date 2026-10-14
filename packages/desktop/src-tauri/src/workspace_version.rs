//! The hub/node version of the checkout an app is built from.
//!
//! build.rs reads it out of the repo's Cargo.toml so the phone app can tell
//! when a hub is older than the one it was built alongside. App versions
//! (tauri.conf.json) are a different numbering line and never compared with
//! it. Shared with build.rs by `#[path]`, so it stays free of dependencies.

/// `version` under `[workspace.package]`, or `None` if the manifest has none.
pub fn workspace_version(manifest: &str) -> Option<String> {
    let mut in_section = false;
    for line in manifest.lines() {
        // Versions never contain `#`, so anything after one is a comment.
        let line = line.split('#').next().unwrap_or_default().trim();
        if line.starts_with('[') {
            in_section = line == "[workspace.package]";
            continue;
        }
        if !in_section {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        if key.trim() != "version" {
            continue;
        }
        let value = value.trim();
        let value = ['"', '\'']
            .iter()
            .find_map(|quote| value.strip_prefix(*quote)?.strip_suffix(*quote))?;
        return (!value.is_empty()).then(|| value.to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::workspace_version;

    #[test]
    fn reads_the_workspace_package_version() {
        let manifest = "[workspace]\nmembers = [\"crates/hub\"]\n\n[workspace.package]\n# What `offdesk --version` prints.\nversion = \"0.23.0\" # bump with releases\nedition = \"2021\"\n\n[workspace.dependencies]\nserde = { version = \"1\" }\n";
        assert_eq!(workspace_version(manifest).as_deref(), Some("0.23.0"));
    }

    #[test]
    fn tolerates_comments_on_the_header_and_single_quotes() {
        let manifest = "[workspace.package] # shared by every crate\nversion = '0.23.1'\n";
        assert_eq!(workspace_version(manifest).as_deref(), Some("0.23.1"));
    }

    #[test]
    fn an_unquoted_or_empty_value_is_no_version() {
        assert_eq!(workspace_version("[workspace.package]\nversion = 0.23\n"), None);
        assert_eq!(workspace_version("[workspace.package]\nversion = \"\"\n"), None);
    }

    #[test]
    fn ignores_versions_in_other_sections() {
        let manifest = "[package]\nversion = \"0.1.0\"\n\n[workspace.dependencies]\nversion = \"9\"\n";
        assert_eq!(workspace_version(manifest), None);
    }

    #[test]
    fn the_repo_manifest_has_one() {
        let manifest = include_str!("../../../../Cargo.toml");
        assert!(workspace_version(manifest).is_some());
    }
}
