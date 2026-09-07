# offdesk.dev

The public website and illustrated setup guides. Astro, no framework components, no client-side framework.

```bash
pnpm install
pnpm dev      # http://localhost:4321
pnpm build    # -> site/dist
```

`site/public/` is copied to the root of the output, so `public/install` is
served at `https://offdesk.dev/install` and `public/media/hero.gif` at
`/media/hero.gif`.

The Mac setup guide is at `/docs/mac` (English) and `/zh/docs/mac` (Chinese).
Both use `src/components/MacSetupGuide.astro`. Screenshot provenance and refresh
instructions are in `docs/testing/macos-first-install-guide.md` at the repo root.

Deployed by `.github/workflows/site.yml` on push to `main`.

## CI scope

PRs changing only `site/` and documentation run the website build and the
existing download/installer tests on Linux. They do not install the App
workspace, compile Rust or native apps, or start an Android emulator / E2E Docker
stack. Markdown/docs-only changes need just the routing check and final result.

Runtime files, root dependencies, unknown paths, CI routing changes, and the
real installer at `site/public/install` retain the full platform checks. Mixed
changes run both suites. Changes to the deployment workflow validate the site.

The classifier uses the full Git diff (including deleted files and both sides
of renames), with the PR merge base or the push's previous revision. There is
no API changed-file limit. Missing revisions fail CI; unknown events run all
checks. `CI Result` always runs and rejects missing, cancelled or failed
applicable checks. Existing platform check names are retained.

Local routing tests: `node --test scripts/ci/changed-scope.test.mjs` from the
repository root. Browser verification still follows the container commands in
AGENTS.md; this routing change does not switch E2E to a host browser.
