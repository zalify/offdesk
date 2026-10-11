# HTML file previews

The file browser can show an `.html` file of a machine as a web page: open the
file, then **Preview**. The page is drawn on your device, so it scrolls and
zooms like any page, and its scripts run.

Available in the desktop app and the Android app. iOS and a plain browser show
the file's source only.

## How it works

- The page gets a WebView of its own: a separate window on the desktop, a
  full-screen dialog on Android (✕ closes it, ↻ reloads, Back goes back).
- It is served at the file's absolute path. Relative links (`react.js`) and
  absolute ones written for the machine itself (`file:///Users/me/app/a.css`)
  both resolve: `file://` URLs in HTML, CSS, scripts and SVG are rewritten to
  plain absolute paths.
- Each file the page asks for is read from the machine through the app's
  existing connection (LAN, public Hub or the encrypted Cloud route), like a
  download. Nothing new is exposed on the Hub. Up to 20 MB per file.
- Links to other sites open in your browser. Scripts, styles and fonts from
  other sites (a CDN) load as usual, straight from the device.
- Reload to see changes; nothing is cached.

## What the page can read

Only files inside the git checkout that holds the previewed file (or the
file's own folder, outside a checkout), and never hidden files or folders
such as `.env` or `.git/`. Anything else gets a 403.

The page cannot call the app: the preview WebView has no access to Offdesk's
commands. It is never put inside the app's own WebView, because on Android
every frame there can reach them.

Treat a preview like opening the file in a browser on the machine: its scripts
run and can make network requests, so only preview files you trust.
