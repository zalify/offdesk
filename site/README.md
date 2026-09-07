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
