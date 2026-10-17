import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  apkTarget, contentTypeFor, desktopTarget, isSafeSegment, newestAppRelease, newestDesktopRelease, parseRange,
} from "./worker.js";

const releases = [
  { tag_name: "v0.18.1", html_url: "https://github.com/zalify/offdesk/releases/tag/v0.18.1", assets: [] },
  {
    tag_name: "app-v0.4.2",
    html_url: "https://github.com/zalify/offdesk/releases/tag/app-v0.4.2",
    assets: [
      { name: "offdesk-0.4.2-arm64-v8a.apk", browser_download_url: "https://github.com/zalify/offdesk/releases/download/app-v0.4.2/offdesk-0.4.2-arm64-v8a.apk" },
      { name: "offdesk-0.4.2-universal.apk", browser_download_url: "https://github.com/zalify/offdesk/releases/download/app-v0.4.2/offdesk-0.4.2-universal.apk" },
    ],
  },
  { tag_name: "app-v0.4.10", draft: true, html_url: "draft", assets: [] },
  { tag_name: "desktop-v0.3.16", html_url: "desktop-old", assets: [] },
  {
    tag_name: "desktop-v0.5.0",
    html_url: "https://github.com/zalify/offdesk/releases/tag/desktop-v0.5.0",
    assets: [
      { name: "offdesk_0.5.0_universal.dmg", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.5.0/offdesk_0.5.0_universal.dmg" },
      { name: "offdesk_0.5.0_x64_en-US.msi", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.5.0/offdesk_0.5.0_x64_en-US.msi" },
      { name: "offdesk_0.5.0_amd64.AppImage", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.5.0/offdesk_0.5.0_amd64.AppImage" },
    ],
  },
  { tag_name: "desktop-v0.5.1", draft: true, html_url: "draft", assets: [] },
  {
    tag_name: "app-v0.4.1",
    html_url: "https://github.com/zalify/offdesk/releases/tag/app-v0.4.1",
    assets: [{ name: "offdesk-0.4.1-arm64-v8a.apk", browser_download_url: "old" }],
  },
];

test("the newest app-v release wins, by version and not by listing order", () => {
  assert.equal(newestAppRelease(releases).tag_name, "app-v0.4.2");
});

test("drafts, prereleases and the hub's own releases are never the APK", () => {
  assert.equal(newestAppRelease([releases[0], releases[2], releases[3]]), null);
});

test("/apk is the arm64 file; /apk/universal the universal one; /apk/release the page", () => {
  assert.match(apkTarget(releases, "arm64-v8a"), /0\.4\.2-arm64-v8a\.apk$/);
  assert.match(apkTarget(releases, "universal"), /0\.4\.2-universal\.apk$/);
  assert.equal(apkTarget(releases, "release"), releases[1].html_url);
});

test("the newest desktop-v release wins, and a draft never does", () => {
  assert.equal(newestDesktopRelease(releases).tag_name, "desktop-v0.5.0");
});

test("/mac is the dmg, /windows the msi, /linux the AppImage, /desktop the page", () => {
  assert.match(desktopTarget(releases, "mac"), /0\.5\.0_universal\.dmg$/);
  assert.match(desktopTarget(releases, "windows"), /\.msi$/);
  assert.match(desktopTarget(releases, "linux"), /\.AppImage$/);
  assert.equal(desktopTarget(releases, "release"), releases[4].html_url);
});

test("a flavour the release does not carry falls back to the release page", () => {
  assert.equal(apkTarget(releases, "x86_64"), releases[1].html_url);
});

test("the worker redirects /apk and leaves every other path to the static assets", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(releases), { status: 200 });
  try {
    const env = { ASSETS: { fetch: async () => new Response("static") } };
    const redirect = await worker.fetch(new Request("https://offdesk.dev/apk"), env);
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location"), /arm64-v8a\.apk$/);
    const page = await worker.fetch(new Request("https://offdesk.dev/apk/release"), env);
    assert.equal(page.headers.get("location"), releases[1].html_url);
    const nope = await worker.fetch(new Request("https://offdesk.dev/apk/ios"), env);
    assert.equal(nope.status, 404);
    const mac = await worker.fetch(new Request("https://offdesk.dev/mac"), env);
    assert.equal(mac.status, 302);
    assert.match(mac.headers.get("location"), /_universal\.dmg$/);
    const site = await worker.fetch(new Request("https://offdesk.dev/"), env);
    assert.equal(await site.text(), "static");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the translated pages, the sitemap and robots.txt are static files, not redirects", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(releases), { status: 200 });
  try {
    const env = { ASSETS: { fetch: async (request) => new Response(`static ${new URL(request.url).pathname}`) } };
    for (const path of [
      "/zh/", "/de/", "/fr/", "/ja/", "/ko/", "/es/",
      "/zh/docs/mac/", "/zh/docs/mac", "/de/tunnel/", "/es/docs/mac/",
      "/sitemap.xml", "/robots.txt",
    ]) {
      const response = await worker.fetch(new Request(`https://offdesk.dev${path}`), env);
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), `static ${path}`, path);
    }
    // The download redirects live at the root only, in every language.
    const mac = await worker.fetch(new Request("https://offdesk.dev/mac"), env);
    assert.equal(mac.status, 302);
    const apk = await worker.fetch(new Request("https://offdesk.dev/apk/universal"), env);
    assert.equal(apk.status, 302);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GitHub being down still lands on the releases list, not an error page", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("rate limited", { status: 403 });
  try {
    const env = { ASSETS: { fetch: async () => new Response("static") } };
    const response = await worker.fetch(new Request("https://offdesk.dev/apk"), env);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://github.com/zalify/offdesk/releases");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("downloads still resolve once the app is named Offdesk DEV (GitHub turns the space into a dot)", () => {
  const renamed = [{
    tag_name: "desktop-v0.7.12",
    html_url: "https://github.com/zalify/offdesk/releases/tag/desktop-v0.7.12",
    assets: [
      { name: "Offdesk.DEV_0.7.12_universal.dmg", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.7.12/Offdesk.DEV_0.7.12_universal.dmg" },
      { name: "Offdesk.DEV_0.7.12_x64_en-US.msi", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.7.12/Offdesk.DEV_0.7.12_x64_en-US.msi" },
      { name: "Offdesk.DEV_0.7.12_amd64.AppImage", browser_download_url: "https://github.com/zalify/offdesk/releases/download/desktop-v0.7.12/Offdesk.DEV_0.7.12_amd64.AppImage" },
    ],
  }, ...releases];
  assert.match(desktopTarget(renamed, "mac"), /Offdesk\.DEV_0\.7\.12_universal\.dmg$/);
  assert.match(desktopTarget(renamed, "windows"), /Offdesk\.DEV_0\.7\.12_x64_en-US\.msi$/);
  assert.match(desktopTarget(renamed, "linux"), /Offdesk\.DEV_0\.7\.12_amd64\.AppImage$/);
});

test("downloads resolve after the rename to Offdesk Dev too (Offdesk.Dev_…)", () => {
  const url = (name) => `https://github.com/zalify/offdesk/releases/download/v0.25.0/${name}`;
  const release = { tag_name: "v0.25.0", html_url: "https://github.com/zalify/offdesk/releases/tag/v0.25.0",
    assets: ["Offdesk.Dev_0.25.0_universal.dmg", "Offdesk.Dev_0.25.0_x64_en-US.msi", "Offdesk.Dev_0.25.0_amd64.AppImage"]
      .map((name) => ({ name, browser_download_url: url(name) })) };
  assert.match(desktopTarget([release, ...releases], "mac"), /Offdesk\.Dev_0\.25\.0_universal\.dmg$/);
  assert.match(desktopTarget([release, ...releases], "windows"), /Offdesk\.Dev_0\.25\.0_x64_en-US\.msi$/);
  assert.match(desktopTarget([release, ...releases], "linux"), /Offdesk\.Dev_0\.25\.0_amd64\.AppImage$/);
});

test("from 0.23.0 one release carries everything, and it wins over its transitional app-v copy", () => {
  const url = (tag, name) => `https://github.com/zalify/offdesk/releases/download/${tag}/${name}`;
  const files = (tag, version) => [
    `offdesk-hub-linux-x64`, `offdesk-${version}-arm64-v8a.apk`, `offdesk-${version}-universal.apk`,
    `Offdesk.DEV_${version}_universal.dmg`, `Offdesk.DEV_${version}_x64_en-US.msi`, `Offdesk.DEV_${version}_amd64.AppImage`,
  ].map((name) => ({ name, browser_download_url: url(tag, name) }));
  const unified = { tag_name: "v0.23.0", html_url: "https://github.com/zalify/offdesk/releases/tag/v0.23.0", assets: files("v0.23.0", "0.23.0") };
  const copy = { tag_name: "app-v0.23.0", html_url: "copy", assets: files("app-v0.23.0", "0.23.0").filter((a) => a.name.endsWith(".apk")) };
  // The Hub's own v0.22.0 carries neither, so it is never a download.
  const hubOnly = { tag_name: "v0.22.0", html_url: "hub", assets: [{ name: "offdesk-hub-linux-x64", browser_download_url: "hub" }] };
  const listing = [hubOnly, copy, unified, ...releases];
  assert.equal(newestAppRelease(listing).tag_name, "v0.23.0");
  assert.equal(newestAppRelease([copy, unified]).tag_name, "v0.23.0");
  assert.match(apkTarget(listing, "arm64-v8a"), /\/v0\.23\.0\/offdesk-0\.23\.0-arm64-v8a\.apk$/);
  assert.match(desktopTarget(listing, "mac"), /\/v0\.23\.0\/Offdesk\.DEV_0\.23\.0_universal\.dmg$/);
  assert.equal(desktopTarget(listing, "release"), unified.html_url);
  assert.equal(newestAppRelease([hubOnly, ...releases]).tag_name, "app-v0.4.2");
});

// ── the release mirror ───────────────────────────────────────────────

/** A stand-in for the R2 binding: just the calls worker.js makes. */
function bucket(files) {
  const store = new Map(Object.entries(files).map(([key, text]) => [key, new TextEncoder().encode(text)]));
  const calls = [];
  const meta = (key) => ({ size: store.get(key).length, httpEtag: `"etag-${key.length}"` });
  return {
    calls,
    async head(key) {
      calls.push(["head", key]);
      return store.has(key) ? meta(key) : null;
    },
    async get(key, options) {
      calls.push(["get", key, options]);
      if (!store.has(key)) return null;
      let bytes = store.get(key);
      if (options?.range) bytes = bytes.slice(options.range.offset, options.range.offset + options.range.length);
      return { ...meta(key), body: bytes, json: async () => JSON.parse(new TextDecoder().decode(bytes)) };
    },
  };
}

const assets = () => ({ ASSETS: { fetch: async () => new Response("static") } });
const get = (path, env, init) => worker.fetch(new Request(`https://offdesk.dev${path}`, init), env);

test("a mirrored file is served from R2, with its type, length, ETag and a long cache", async () => {
  const env = { ...assets(), RELEASES: bucket({ "download/v0.24.0/offdesk-0.24.0-arm64-v8a.apk": "apk bytes" }) };
  const response = await get("/download/v0.24.0/offdesk-0.24.0-arm64-v8a.apk", env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "apk bytes");
  assert.equal(response.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.equal(response.headers.get("content-length"), "9");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.match(response.headers.get("etag"), /^"etag-/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="offdesk-0.24.0-arm64-v8a.apk"');
  assert.equal(response.headers.get("access-control-allow-origin"), "*");

  const head = await get("/download/v0.24.0/offdesk-0.24.0-arm64-v8a.apk", env, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "9");
  assert.equal(await head.text(), "");
});

test("a range request gets 206 and just those bytes; a resumed download keeps going", async () => {
  const env = { ...assets(), RELEASES: bucket({ "download/v0.24.0/offdesk-hub-linux-x64": "0123456789" }) };
  const part = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(part.headers.get("content-length"), "4");
  assert.equal(await part.text(), "2345");
  assert.deepEqual(env.RELEASES.calls.at(-1), ["get", "download/v0.24.0/offdesk-hub-linux-x64", { range: { offset: 2, length: 4 } }]);

  const rest = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { range: "bytes=7-" } });
  assert.equal(await rest.text(), "789");
  const tail = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { range: "bytes=-3" } });
  assert.equal(tail.headers.get("content-range"), "bytes 7-9/10");

  const beyond = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { range: "bytes=10-" } });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), "bytes */10");

  // If-Range naming another version of the file: the whole file, not a part.
  const stale = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { range: "bytes=2-5", "if-range": '"old"' } });
  assert.equal(stale.status, 200);
  assert.equal(await stale.text(), "0123456789");

  const etag = part.headers.get("etag");
  const cached = await get("/download/v0.24.0/offdesk-hub-linux-x64", env, { headers: { "if-none-match": etag } });
  assert.equal(cached.status, 304);
});

test("ranges parse like HTTP says, and odd ones mean the whole file", () => {
  assert.deepEqual(parseRange("bytes=0-0", 10), { offset: 0, length: 1 });
  assert.deepEqual(parseRange("bytes=5-100", 10), { offset: 5, length: 5 });
  assert.deepEqual(parseRange("bytes=-20", 10), { offset: 0, length: 10 });
  assert.equal(parseRange("bytes=5-2", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
  assert.equal(parseRange("bytes=0-1,4-5", 10), null);
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange(null, 10), null);
});

test("a file the mirror lacks, or a worker without the bucket, goes to GitHub", async () => {
  const github = "https://github.com/zalify/offdesk/releases/download/v0.24.0/Offdesk.DEV_0.24.0_universal.dmg";
  const missing = await get("/download/v0.24.0/Offdesk.DEV_0.24.0_universal.dmg", { ...assets(), RELEASES: bucket({}) });
  assert.equal(missing.status, 302);
  assert.equal(missing.headers.get("location"), github);
  const unbound = await get("/download/v0.24.0/Offdesk.DEV_0.24.0_universal.dmg", assets());
  assert.equal(unbound.headers.get("location"), github);
  const broken = { head: async () => { throw new Error("R2 is having a day"); } };
  const failing = await get("/download/v0.24.0/Offdesk.DEV_0.24.0_universal.dmg", { ...assets(), RELEASES: broken });
  assert.equal(failing.headers.get("location"), github);
});

test("only plain tag and file names are looked up, never another part of the bucket", async () => {
  const env = { ...assets(), RELEASES: bucket({ "updates/releases.json": "[]", "download/v1/.mirrored.json": "{}" }) };
  for (const path of [
    "/download/v1/.mirrored.json",
    // (A literal "/../" never arrives: URLs resolve it before the worker.)
    "/download/v1%2F..%2F..%2Fupdates/releases.json",
    "/download/v1/..%2Fsecret",
    "/download/v1/a%20b",
    "/download/v1/a..b",
    "/download/v1",
    "/download/v1/a/b",
    "/download/-v1/file",
  ]) {
    const response = await get(path, env);
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(env.RELEASES.calls, []);
  assert.equal(isSafeSegment("Offdesk.DEV_0.24.0_x64_en-US.msi"), true);
  assert.equal(isSafeSegment("ui-stable"), true);
  assert.equal(isSafeSegment(".mirrored.json"), false);
  assert.equal(isSafeSegment("a..b"), false);
});

test("channel pointers and desktop-latest change under one name, so they cache briefly", async () => {
  const env = { ...assets(), RELEASES: bucket({
    "download/ui-stable/latest.json": "{}",
    "download/ui-stable/bundle-stable-1-1.json": "{}",
  }) };
  const pointer = await get("/download/ui-stable/latest.json", env);
  assert.equal(pointer.headers.get("cache-control"), "public, max-age=60");
  assert.equal(pointer.headers.get("content-type"), "application/json");
  assert.equal(pointer.headers.get("content-disposition"), null);
  const bundle = await get("/download/ui-stable/bundle-stable-1-1.json", env);
  assert.equal(bundle.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("update metadata is served from R2 as JSON with a one-minute cache", async () => {
  const listing = [{ tag_name: "v0.24.0" }];
  const env = { ...assets(), RELEASES: bucket({
    "updates/releases.json": JSON.stringify(listing),
    "updates/desktop/latest.json": '{"version":"0.24.0"}',
    "updates/ui/stable/latest.json": '{"payload":"{}","signature":""}',
  }) };
  for (const [path, body] of [
    ["/updates/releases.json", JSON.stringify(listing)],
    ["/updates/desktop/latest.json", '{"version":"0.24.0"}'],
    ["/updates/ui/stable/latest.json", '{"payload":"{}","signature":""}'],
  ]) {
    const response = await get(path, env);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    // The iPhone app reads the listing from its WebView.
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  }
  const preflight = await get("/updates/releases.json", env, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  const post = await get("/updates/releases.json", env, { method: "POST" });
  assert.equal(post.status, 405);
  for (const path of ["/updates/..%2Fdownload/v1/x.json", "/updates/a..b.json", "/updates/releases.txt", "/updates/", "/updates/.hidden.json"]) {
    assert.equal((await get(path, env)).status, 404, path);
  }
});

test("update metadata the mirror lacks falls back to what the apps used before", async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(releases), { status: 200 });
  };
  try {
    const env = { ...assets(), RELEASES: bucket({}) };
    const desktop = await get("/updates/desktop/latest.json", env);
    assert.equal(desktop.status, 302);
    assert.equal(desktop.headers.get("location"), "https://github.com/zalify/offdesk/releases/download/desktop-latest/latest.json");

    const listing = await get("/updates/releases.json", env);
    assert.equal(listing.status, 200);
    assert.deepEqual(await listing.json(), releases);
    assert.equal(listing.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(asked, ["https://api.github.com/repos/zalify/offdesk/releases?per_page=100"]);

    // The Web UI pointer has to be signed for offdesk.dev; the apps fall back
    // to GitHub's pointer themselves.
    assert.equal((await get("/updates/ui/stable/latest.json", env)).status, 404);
    assert.equal((await get("/updates/ui/stable/latest.json", assets())).status, 404);

    globalThis.fetch = async () => new Response("rate limited", { status: 403 });
    assert.equal((await get("/updates/releases.json", env)).status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("/apk and /mac follow the mirror's listing, so they link to offdesk.dev once it has the files", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("GitHub should not be asked"); };
  try {
    const mirrored = (name) => ({ name, browser_download_url: `https://offdesk.dev/download/v0.24.0/${name}` });
    const listing = [{
      tag_name: "v0.24.0", html_url: "https://github.com/zalify/offdesk/releases/tag/v0.24.0",
      assets: [mirrored("offdesk-0.24.0-arm64-v8a.apk"), mirrored("Offdesk.DEV_0.24.0_universal.dmg")],
    }];
    const env = { ...assets(), RELEASES: bucket({ "updates/releases.json": JSON.stringify(listing) }) };
    const apk = await get("/apk", env);
    assert.equal(apk.headers.get("location"), "https://offdesk.dev/download/v0.24.0/offdesk-0.24.0-arm64-v8a.apk");
    const mac = await get("/mac", env);
    assert.equal(mac.headers.get("location"), "https://offdesk.dev/download/v0.24.0/Offdesk.DEV_0.24.0_universal.dmg");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("release files get the Content-Type their kind calls for", () => {
  assert.equal(contentTypeFor("offdesk-0.24.0-universal.apk"), "application/vnd.android.package-archive");
  assert.equal(contentTypeFor("latest.json"), "application/json");
  assert.equal(contentTypeFor("Offdesk.DEV_0.24.0_universal.app.tar.gz"), "application/gzip");
  assert.equal(contentTypeFor("Offdesk.DEV_0.24.0_amd64.AppImage"), "application/octet-stream");
  assert.equal(contentTypeFor("offdesk-hub-linux-x64"), "application/octet-stream");
  assert.equal(contentTypeFor("Offdesk.DEV_0.24.0_x64_en-US.msi.sig"), "text/plain; charset=utf-8");
});
