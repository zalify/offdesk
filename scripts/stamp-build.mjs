// Stamp a build id into the exported web bundle so every deploy busts caches
// end-to-end and the running frontend can identify itself.
//
// Usage: node scripts/stamp-build.mjs <dist-dir> [build-id]
//
// What it does:
// 1. index.html: append ?v=<id> to every /_expo/static script src (top-level
//    entry chunks) and inject window.__OFFDESK_BUILD__ = "<id>".
// 2. Every .js chunk: append ?v=<id> to every nested "/_expo/static/js/web/…
//    .js" reference. Metro emits async-chunk path maps whose FILENAMES are
//    stable across builds while their contents change (e.g. a lazy wrapper
//    chunk keeps its name but points at a new inner chunk). Those chunks are
//    served with max-age=1y immutable, so without a query-string change any
//    client that ever cached one is pinned to the old code forever — kill and
//    reopen doesn't help. Stamping every reference makes each build a fresh
//    URL graph rooted at the un-cacheable index.html.
import fs from "node:fs";
import path from "node:path";

const distDir = process.argv[2];
// Desktop releases need the same cache invalidation as the standalone Hub.
const buildId = process.argv[3] === "--desktop"
  ? `desktop-v${JSON.parse(fs.readFileSync(new URL("../packages/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8")).version}`
  : process.argv[3] || String(Math.floor(Date.now() / 1000));
if (!distDir) {
  console.error("usage: node scripts/stamp-build.mjs <dist-dir> [build-id]");
  process.exit(1);
}

const v = encodeURIComponent(buildId);

// 1. index.html
const indexPath = path.join(distDir, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const stampedHtml = html.replace(
  /(<script\b[^>]*\bsrc=["'])(\/_expo\/static\/[^"'?]+)(?:\?[^"']*)?(["'])/g,
  (_m, prefix, url, quote) => `${prefix}${url}?v=${v}${quote}`,
);
if (stampedHtml === html) {
  throw new Error("No /_expo/static script src attributes found in index.html");
}
const withBuildGlobal = stampedHtml.replace(
  /<script/,
  `<script>window.__OFFDESK_BUILD__=${JSON.stringify(buildId)};</script><script`,
);
if (withBuildGlobal === stampedHtml) {
  throw new Error("No <script> tag found in index.html to anchor build global");
}
fs.writeFileSync(indexPath, withBuildGlobal);

// 2. nested chunk references inside every emitted js file
const jsDir = path.join(distDir, "_expo", "static", "js", "web");
let stampedRefs = 0;
for (const name of fs.readdirSync(jsDir)) {
  if (!name.endsWith(".js")) continue;
  const p = path.join(jsDir, name);
  const src = fs.readFileSync(p, "utf8");
  const out = src.replace(
    /(\/_expo\/static\/js\/web\/[A-Za-z0-9_.-]+\.js)(?!\?)/g,
    (_m, url) => {
      stampedRefs++;
      return `${url}?v=${v}`;
    },
  );
  if (out !== src) fs.writeFileSync(p, out);
}
console.log(
  `stamped build ${buildId}: index.html + ${stampedRefs} nested chunk refs`,
);
