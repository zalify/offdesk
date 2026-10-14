// Checks the built site in dist/ for what the translations rely on:
//
//   node scripts/check-dist.mjs        (after `pnpm build`)
//
// - every page has the right <html lang>, a self-referencing canonical,
//   og:locale, and the full, reciprocal hreflang set (every language plus
//   x-default), and JSON-LD that parses;
// - every internal link lands on a built page, a static file or a route
//   worker.js answers, and every #fragment exists on the page it points at;
// - sitemap.xml lists every page in every language with its alternates, and
//   robots.txt points at it.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const origin = "https://offdesk.dev";
const langs = { en: "en", zh: "zh-CN", de: "de", fr: "fr", ja: "ja", ko: "ko", es: "es" };
const ogs = { en: "en_US", zh: "zh_CN", de: "de_DE", fr: "fr_FR", ja: "ja_JP", ko: "ko_KR", es: "es_ES" };
const pages = ["/", "/tunnel/", "/docs/mac/"];
// Paths worker.js answers itself (see site/worker.js).
const workerRoute = /^\/(apk(\/(arm64-v8a|universal|x86_64|release))?|mac|windows|linux|desktop)\/?$/;

const problems = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}
const files = walk(dist);
const htmlFiles = files.filter((f) => f.endsWith(".html"));
/** "/zh/docs/mac/index.html" -> "/zh/docs/mac/" */
const urlPath = (file) => "/" + relative(dist, file).replace(/index\.html$/, "");
const html = new Map(htmlFiles.map((f) => [urlPath(f), readFileSync(f, "utf8")]));

function resolves(path) {
  if (workerRoute.test(path)) return true;
  if (html.has(path)) return true;
  const file = join(dist, path);
  return existsSync(file) && statSync(file).isFile();
}
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
const tags = (doc, name) => doc.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const ids = (doc) => new Set([...doc.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]));
const decode = (s) => s.replace(/&amp;/g, "&");

const expected = Object.keys(langs).flatMap((code) => pages.map((p) => (code === "en" ? p : `/${code}${p}`)));
for (const path of expected) if (!html.has(path)) fail(path, "not built");
for (const path of html.keys()) if (!expected.includes(path)) fail(path, "built, but not a known page in a known language");

const hreflangs = new Map();
for (const [path, doc] of html) {
  const code = /^\/(zh|de|fr|ja|ko|es)\//.exec(path)?.[1] ?? "en";
  const lang = /<html[^>]*\slang="([^"]*)"/.exec(doc)?.[1];
  if (lang !== langs[code]) fail(path, `<html lang="${lang}">, want ${langs[code]}`);

  const canonical = tags(doc, "link").filter((t) => attr(t, "rel") === "canonical");
  if (canonical.length !== 1 || attr(canonical[0], "href") !== origin + path) {
    fail(path, `canonical ${canonical.map((t) => attr(t, "href")).join(", ") || "missing"}, want ${origin + path}`);
  }

  const alternates = Object.fromEntries(
    tags(doc, "link").filter((t) => attr(t, "rel") === "alternate" && attr(t, "hreflang")).map((t) => [attr(t, "hreflang"), attr(t, "href")]),
  );
  hreflangs.set(path, alternates);
  for (const want of [...Object.values(langs), "x-default"]) {
    if (!alternates[want]) fail(path, `no hreflang="${want}"`);
  }
  if (Object.keys(alternates).length !== 8) fail(path, `${Object.keys(alternates).length} hreflang links, want 8`);
  if (alternates[langs[code]] !== origin + path) fail(path, "its own hreflang is not itself");

  const og = tags(doc, "meta").filter((t) => attr(t, "property") === "og:locale").map((t) => attr(t, "content"));
  const ogAlt = tags(doc, "meta").filter((t) => attr(t, "property") === "og:locale:alternate").map((t) => attr(t, "content"));
  if (og.length !== 1 || og[0] !== ogs[code]) fail(path, `og:locale ${og}, want ${ogs[code]}`);
  if (ogAlt.length !== 6 || ogAlt.includes(ogs[code])) fail(path, `og:locale:alternate ${ogAlt}`);

  const title = /<title>([^<]*)<\/title>/.exec(doc)?.[1];
  const description = tags(doc, "meta").find((t) => attr(t, "name") === "description");
  if (!title?.trim()) fail(path, "no <title>");
  if (!description || !attr(description, "content")?.trim()) fail(path, "no meta description");

  const ld = [...doc.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (ld.length !== 1) fail(path, `${ld.length} JSON-LD blocks`);
  for (const [, json] of ld) {
    try {
      const graph = JSON.parse(json)["@graph"] ?? [];
      const app = graph.find((n) => n["@type"] === "SoftwareApplication");
      if (!app?.description || app.applicationCategory !== "DeveloperApplication" || app.offers?.price !== "0") {
        fail(path, "JSON-LD SoftwareApplication is incomplete");
      }
      if (!graph.some((n) => n["@type"] === "WebSite") || !graph.some((n) => n["@type"] === "Organization")) {
        fail(path, "JSON-LD lacks WebSite or Organization");
      }
    } catch (error) {
      fail(path, `JSON-LD does not parse: ${error.message}`);
    }
  }

  for (const tag of [...tags(doc, "a"), ...tags(doc, "link"), ...tags(doc, "img"), ...tags(doc, "script")]) {
    const raw = attr(tag, "href") ?? attr(tag, "src");
    if (!raw) continue;
    let href = decode(raw);
    if (href.startsWith(origin)) href = href.slice(origin.length) || "/";
    if (href.startsWith("#")) href = path + href;
    if (!href.startsWith("/")) continue;
    const [target, fragment] = href.split("#");
    const clean = target.split("?")[0];
    if (!resolves(clean)) fail(path, `link to ${raw} does not resolve`);
    else if (fragment && html.has(clean) && !ids(html.get(clean)).has(fragment)) fail(path, `link to ${raw}: no #${fragment} there`);
  }
}

// Reciprocity: every page a page names as its translation names it back.
for (const [path, alternates] of hreflangs) {
  for (const [lang, href] of Object.entries(alternates)) {
    if (lang === "x-default") continue;
    const other = hreflangs.get(href.slice(origin.length));
    if (!other) fail(path, `hreflang ${lang} -> ${href}, which is not a built page`);
    else if (!Object.values(other).includes(origin + path)) fail(path, `${href} does not link back`);
  }
}

const sitemap = existsSync(join(dist, "sitemap.xml")) ? readFileSync(join(dist, "sitemap.xml"), "utf8") : "";
const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
if (locs.length !== expected.length) fail("sitemap.xml", `${locs.length} URLs, want ${expected.length}`);
for (const path of expected) if (!locs.includes(origin + path)) fail("sitemap.xml", `missing ${path}`);
for (const block of sitemap.split("<url>").slice(1)) {
  const n = (block.match(/<xhtml:link /g) ?? []).length;
  if (n !== 8) fail("sitemap.xml", `${/<loc>([^<]*)/.exec(block)?.[1]} has ${n} alternates, want 8`);
}
const robots = existsSync(join(dist, "robots.txt")) ? readFileSync(join(dist, "robots.txt"), "utf8") : "";
if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) fail("robots.txt", "does not point at the sitemap");

if (problems.length) {
  console.error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`ok: ${html.size} pages in ${Object.keys(langs).length} languages; lang, canonical, og:locale, ${html.size * 8} hreflang links (reciprocal), JSON-LD, internal links and #fragments, sitemap (${locs.length} URLs) and robots.txt`);
