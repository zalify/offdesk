# Finder-like file manager

Status: implemented (branch `feat/finder-files`). This doc describes what shipped.

Decisions (owner, 2026-11-17):
- Do both phases: file operations **and** a Finder-style interface.
- Delete = move to the node's trash (recoverable). No "empty trash" in webmux.
- Keep the existing overlay (desktop) / full-screen surface (phone); make it
  larger and Finder-shaped. No new workspace tab/pane type.

## Phase 1 — operations (protocol, node, hub, app API)

New capability `fs-ops-v1` (`FS_OPS_CAPABILITY`). A hub talking to a node
without it answers HTTP 409 `{"error":"machine_outdated"}`, as `fs/read` does.
The app does not know node capabilities up front; it shows the actions and
turns a 409 `machine_outdated` into "update this machine" notice.

The view-only lock is enforced in the UI the same way editing is
(`canEdit = !viewOnlyLocked`): every mutating action is hidden when locked.

### Error shape

All new routes return errors as `{"error": <code>, "message": <text>, "path"?: <path>}`.

| code | HTTP | meaning |
|---|---|---|
| `not_found` | 404 | source/parent missing |
| `exists` | 409 | target exists and `on_conflict` = `error` |
| `permission_denied` | 403 | |
| `invalid` | 400 | bad name (empty, contains `/`, `.`/`..`, NUL), moving a folder into itself, etc. |
| `too_large` | 413 | |
| `no_space` | 507 | |
| `io` | 502 | anything else |
| `machine_outdated` | 409 | node lacks `fs-ops-v1` |
| `machine_not_found` / `machine_disconnected` / `timeout` | 404 / 502 / 504 | as fs/read |

Machine-side code enum: `FsOpErrorCode { NotFound, Exists, PermissionDenied, Invalid, TooLarge, NoSpace, Io }`.

### `POST /api/machines/{id}/fs/op`

Body is one op, tagged by `op`. Paths are absolute or `~`-prefixed (the node
expands `~`). Response `{"paths": [<resulting absolute path>, ...]}`, one per
created / renamed / copied / moved / trashed item, in input order.

| op | body | behaviour |
|---|---|---|
| `mkdir` | `{op, path}` | create one directory (parent must exist); `exists` if taken |
| `create_file` | `{op, path}` | create an empty file, never overwrite; `exists` if taken |
| `rename` | `{op, path, new_name}` | rename within the same directory; `new_name` is a bare name; `exists` if taken |
| `trash` | `{op, paths: [..]}` | move each to the node's trash (see below); stops at the first failure, reporting `path` |
| `copy` | `{op, sources: [..], dest_dir, on_conflict}` | recursive copy into `dest_dir` |
| `move` | `{op, sources: [..], dest_dir, on_conflict}` | `rename(2)`; across filesystems fall back to copy then remove the source |

`on_conflict`: `"error"` (default) | `"keep_both"` | `"replace"`.
- `keep_both` picks a Finder-style free name: `name copy.ext`, `name copy 2.ext`, …
  (copy into the *same* directory always behaves as `keep_both`, so "duplicate"
  is `copy` with `dest_dir` = the source's own directory).
- `replace` moves the existing target to the trash first, then proceeds.
- Copying/moving a directory into itself or a descendant → `invalid`.
- Symlinks are copied as symlinks, not followed.

Trash:
- Use the `trash` crate. On macOS use the `NsFileManager` delete method (not
  the Finder/AppleScript one, which needs automation permission and a GUI
  session). On Linux it follows the freedesktop trash spec.
- If the platform trash fails (e.g. a path on a volume without a trash dir), the
  op fails with `io` and a clear message; it never falls back to permanent delete.

Hub timeout for `fs/op`: 10 minutes for `copy`/`move`/`trash`, the normal fs
timeout for the rest. Node runs ops on a blocking task so the hub loop never stalls.

### Transfers

Upload into a directory (no terminal needed), chunked like the attach upload
(docs/plans/2026-11-04-chunked-uploads.md), but over HTTP:

- `POST /api/machines/{id}/fs/upload/begin` `{dest_dir, filename, size, on_conflict}` → `{"upload_id"}`
  (hub generates the id; node validates the name, checks free space and, for
  `error`, that the name is free; creates `dest_dir/.<filename>.offdesk-part-<id>`)
- `POST /api/machines/{id}/fs/upload/chunk` `{upload_id, index, data}` (`data` = base64 of ≤ `UPLOAD_CHUNK_MAX_BYTES`, in order) → `{"received"}`
- `POST /api/machines/{id}/fs/upload/end` `{upload_id}` → `{"path","size"}` (node renames the part file into place, applying `on_conflict` here: `keep_both` picks the free name now, `replace` trashes the existing file now, `error` re-checks)
- `POST /api/machines/{id}/fs/upload/abort` `{upload_id}` → 204 (part file removed)
- The node drops uploads idle for > 10 minutes (part file removed).

Download of big files (up to the cap below), and of folders:

- `GET /api/machines/{id}/fs/read_range?path=&offset=&length=` →
  `{"size","data_base64","eof"}`; `length` ≤ 4 MiB. Regular files only.
- `POST /api/machines/{id}/fs/zip` `{paths: [..]}` → `{"path","size","name"}`:
  the node writes a zip of the given files/folders (relative to their common
  parent) into a private temp dir and returns that zip's path; the app then
  pulls it with `read_range` and offers it as `<name>.zip`. The node deletes
  zips it made that are older than 1 hour whenever it makes a new one, and on start.
- Limits. The app holds a download in memory as one base64 string (V8 caps
  strings near 536M chars), so downloads are capped at 256 MiB
  (`MAX_DOWNLOAD_BYTES` in the app, `FS_ZIP_MAX_BYTES` in the protocol): a
  larger file, or a zip the node reports as larger, is refused with
  `too_large` ("Files over 256 MB can't be downloaded here yet"). The node
  refuses to zip more than 1 GiB of input (`too_large`, "Folder is too large
  to zip (over 1 GB)"), needs free space of input size + 16 MiB in the zips
  dir (`no_space`), and aborts and deletes the part file if the zip passes
  256 MiB (`too_large`, "The zip would be over 256 MB").
- A hub that predates these routes answers a bare 404 (no JSON `error`); the
  app reports "Update the hub to manage files".

The existing ≤ 20 MiB `fs/read` stays for preview.

## Phase 2 — interface

Desktop overlay grows to `min(96vw, 1400px) × min(90vh, 900px)` and becomes:

```
┌ sidebar ───┬ toolbar: ‹ › ↑  [path / breadcrumb, ⌘⇧G to type]  filter  ⊞≡  +folder ⇪upload ┐
│ Favorites  │ ┌ Name ▲ ───────────────┬ Size ──┬ Modified ────┬ Kind ─┐                     │
│  ~ Home    │ │ ▸ src/                 │        │ 2 h ago      │ dir   │                     │
│  terminal  │ │   README.md            │ 4 KB   │ just now     │ md    │   (preview pane     │
│   cwd(s)   │ │   ...                  │        │              │       │    when a file is   │
│  pinned…   │ └────────────────────────┴────────┴──────────────┴───────┘    open, as today)  │
│            │ status bar: 3 items selected · 12 MB                                           │
└────────────┴─────────────────────────────────────────────────────────────────────────────────┘
```

- Sidebar: Home, the open terminals' cwds on this machine, user-pinned folders
  (localStorage per machine; "Pin to Sidebar" or the toolbar pin), Trash is
  **not** listed (no browsing of trash in this round).
- Back / forward history; ↑ parent; breadcrumb doubles as an editable path
  field (click empty area or ⌘⇧G / ⌘L).
- List view with sortable columns (Name, Size, Modified, Kind; folders first
  always), and an icon view (grid) with lazy image thumbnails (images ≤ 5 MB
  via `fs/read`, only for visible tiles, downscaled to 192px before caching). View + sort remembered per machine.
- Click selects, double-click / Enter opens (the phone keeps tap-to-open).
- Selection: click, ⌘/Ctrl-click toggle, Shift-click range, ⌘A, arrows,
  Shift+arrows. Status bar shows count and total size.
- Context menu (right-click on item / empty area) and toolbar actions:
  Open, Quick Look (Space), Rename (F2; Enter keeps opening, as today),
  Duplicate, Copy (⌘C), Cut (⌘X), Paste (⌘V), Move to Trash (⌘⌫ / Delete),
  New Folder (⌘⇧N), New File, Download (files; folders and multi-select download as zip),
  Copy Path, Open in Terminal (new terminal with that cwd), Pin to Sidebar.
- Inline rename in the row; Escape cancels, Enter commits.
- Drag & drop: drop OS files onto the list (or onto a folder row) uploads them
  there with a progress strip; drag rows onto a folder row / sidebar entry
  moves them (⌥ copies).
- Paste conflict: a small dialog "An item named X already exists" with
  Keep Both / Replace / Stop (maps to `on_conflict`).
- An open editor with unsaved changes blocks rename/move/trash of that file
  (notice), mirroring the overlay close rule.

Phone (`touch`): same core minus sidebar (a "Places" sheet from the toolbar),
no hover/right-click. Long-press a row enters selection mode with an action bar
(Share/Download, Move, Copy, Rename, Trash, More); a "+" button offers New
Folder / New File / Upload (file picker). Paste target chosen by navigating
then tapping "Paste here" in a sticky bar.

## Slices

1. Rust: protocol + node + hub for `fs/op` (mkdir, create_file, rename, trash, copy, move).
2. Rust: transfers — upload into dir, `read_range`, `zip`.
3. App lib (parallel with 1–2): `api.ts` clients for all routes + pure models
   (selection, sort, history, clipboard, conflict naming, upload/download
   orchestration) with vitest tests.
4. Desktop UI (Finder layout, actions, DnD, keyboard).
5. Phone UI.
6. E2E specs + real-browser verification.
