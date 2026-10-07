# Desktop 0.7.6 — agent browser

Release scope: desktop macOS, Windows, and Linux. Tag: `desktop-v0.7.6`.
The desktop app bundles its interface, so updating a remote Hub alone does not
add the browser controls to an installed desktop app.

## Changes

- Open the agent browser from the globe button in the top bar when the selected
  machine is online. Switch between its browser tabs, watch the agent, and take
  control when a page needs a person.
- Includes browser navigation, iframe interaction, 1Password integration, and
  the agent's ability to take control back after a human handoff.
- Includes the merged to-do, agent handoff, file browsing/download, pane layout,
  terminal recovery, and terminal colour-query fixes since Desktop 0.7.5.
- Includes the bare-address input fix already deployed to the remote Hub.

## Validation and publication

- Run CI on the release preparation, then merge and build the release commit
  with the existing Desktop Build workflow for all three platforms.
- Verify the draft assets, macOS signing/notarization and DMG layout, and the
  updater manifest's version, platform URLs, and signatures before publishing.
- Keep GitHub's global Latest on the standalone Hub release and verify the
  floating `desktop-latest` manifest after publishing Desktop 0.7.6.

The remote Hub and machine node must also support the agent browser. This
release does not separately deploy a remote Hub or replace an existing remote
node. macOS and Linux installers include the current Hub/node sidecars; Windows
remains a desktop client. OS-specific installation and interactive native
runtime checks are separate from container browser checks and CI builds.
