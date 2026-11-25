# Public share viewer assets

Served by the hub at `/s/{token}` and `/s/_assets/{name}` (fixed allowlist, no build step).
`viewer.js` / `viewer.css` / `index.html` are hand-written; the libraries below are vendored
unmodified from the repo's installed packages (pnpm store, versions pinned by `pnpm-lock.yaml`).

| File | Package | Version | Licence | Source path |
|---|---|---|---|---|
| `marked.min.js` | marked | 18.1.0 | MIT | `marked/lib/marked.umd.js` (only the trailing `sourceMappingURL` comment removed) |
| `purify.min.js` | dompurify | 3.5.0 | MPL-2.0 OR Apache-2.0 | `dompurify/dist/purify.min.js` (trailing `sourceMappingURL` comment removed) |
| `mermaid.min.js` | mermaid | 12.3.0 | MIT | `mermaid/dist/mermaid.min.js` (single-file IIFE, sets `globalThis.mermaid`) |

`mermaid.min.js` is ~5.5 MB and is only loaded by the viewer when a draft contains a mermaid block.
To refresh: copy the same files from `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/...`.
