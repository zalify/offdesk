// offdesk.dev on Workers: the static site from ./dist, plus a few dynamic
// paths that follow the newest release carrying a file. From 0.23.0 every
// release is one `vX.Y.Z` with every component; before that the apps had
// their own `app-v*` and `desktop-v*` releases and `v*` was the Hub alone, so
// a release only counts when it has the file asked for. Nothing static can
// follow that, so these resolve at request time.
//
//   /apk            the arm64-v8a build, right for every phone made this decade
//   /apk/universal  every ABI in one file, for the unsure
//   /apk/x86_64     emulators
//   /apk/release    the release page itself, all three files and the notes
//   /mac            the desktop app for macOS, one dmg for both chips
//   /windows        the desktop app for Windows, the .msi
//   /linux          the desktop app for Linux, the AppImage
//   /desktop        the desktop release page, every file and the notes
//
// It also serves the release mirror. In mainland China github.com and its
// download hosts are unreliable without a proxy, and offdesk.dev is not, so
// CI copies releases into the R2 bucket bound as RELEASES
// (scripts/mirror-release.mjs) and the apps, the Hub and the installer ask
// here first and GitHub second:
//
//   /updates/<file>.json     update metadata: releases.json (a GitHub-shaped
//                            listing), desktop/latest.json (the Tauri updater
//                            manifest), ui/<channel>/latest.json (the signed
//                            Web UI pointer)
//   /download/<tag>/<name>   a release asset, byte for byte as on GitHub
//
// Whatever is missing from the bucket falls back to GitHub, so a mirror that
// lags or is empty sends people where they went before it existed.

const REPO = "zalify/offdesk";
const GITHUB_DOWNLOAD = `https://github.com/${REPO}/releases/download`;
const GITHUB_API_RELEASES = `https://api.github.com/repos/${REPO}/releases`;
const APP_TAG = /^(?:app-)?v(\d+)\.(\d+)\.(\d+)$/;
const DESKTOP_TAG = /^(?:desktop-)?v(\d+)\.(\d+)\.(\d+)$/;
const hasAsset = (release, test) => (release.assets ?? []).some((asset) => test(asset.name ?? ""));
const isApk = (name) => name.endsWith(".apk");
const isDesktop = (name) => Object.values(DESKTOP_FILES).some((wanted) => wanted(name));
const ABIS = new Set(["arm64-v8a", "universal", "x86_64"]);
const DESKTOP_FILES = {
  mac: (name) => name.endsWith("_universal.dmg"),
  windows: (name) => name.endsWith(".msi"),
  linux: (name) => name.endsWith(".AppImage"),
};

/** The newest release whose tag matches and that carries a wanted file, in a
 * GitHub releases listing, or null. At the same version the one release
 * (`vX.Y.Z`) wins over a transitional copy (`app-vX.Y.Z`). */
function newestRelease(releases, tag, carries) {
  let best = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const match = tag.exec(release.tag_name ?? "");
    if (!match || !hasAsset(release, carries)) continue;
    const version = match.slice(1).map(Number);
    const order = best ? compare(version, best.version) : 1;
    if (order > 0 || (order === 0 && release.tag_name.startsWith("v"))) {
      best = { version, release };
    }
  }
  return best?.release ?? null;
}

/** The newest release with APKs, or null. */
export function newestAppRelease(releases) {
  return newestRelease(releases, APP_TAG, isApk);
}

/** The newest release with the desktop installers, or null. */
export function newestDesktopRelease(releases) {
  return newestRelease(releases, DESKTOP_TAG, isDesktop);
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Where /apk[/<abi>] should send someone, given the release listing. */
export function apkTarget(releases, abi) {
  const release = newestAppRelease(releases);
  if (!release) return null;
  if (abi === "release") return release.html_url;
  const asset = (release.assets ?? []).find((a) => a.name.endsWith(`-${abi}.apk`));
  return asset?.browser_download_url ?? release.html_url;
}

/** Where /mac, /windows, /linux and /desktop should send someone. */
export function desktopTarget(releases, flavour) {
  const release = newestDesktopRelease(releases);
  if (!release) return null;
  if (flavour === "release") return release.html_url;
  const wanted = DESKTOP_FILES[flavour];
  const asset = wanted && (release.assets ?? []).find((a) => wanted(a.name));
  return asset?.browser_download_url ?? release.html_url;
}

async function githubReleases(perPage) {
  const response = await fetch(`${GITHUB_API_RELEASES}?per_page=${perPage}`, {
    headers: { "user-agent": "offdesk.dev", accept: "application/vnd.github+json" },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  return response.ok ? await response.json() : null;
}

/** The listing for the download redirects: the mirror's own, whose links
 * already point here for every mirrored file, else GitHub's. */
async function releases(env) {
  const object = await env.RELEASES?.get("updates/releases.json").catch(() => null);
  if (object) {
    try {
      const listing = await object.json();
      if (Array.isArray(listing)) return listing;
    } catch {
      // A damaged listing is the same as none.
    }
  }
  return githubReleases(30);
}

// ── the mirror ───────────────────────────────────────────────────────

const CONTENT_TYPES = [
  [".apk", "application/vnd.android.package-archive"],
  [".json", "application/json"],
  [".dmg", "application/x-apple-diskimage"],
  [".msi", "application/x-msi"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".deb", "application/vnd.debian.binary-package"],
  [".rpm", "application/x-rpm"],
  [".tar.gz", "application/gzip"],
  [".gz", "application/gzip"],
  [".zip", "application/zip"],
  [".sig", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
];

/** The Content-Type for a release file, by its name. The mirror script
 * uploads with the same one, so R2 and these responses agree. */
export function contentTypeFor(name) {
  const lower = name.toLowerCase();
  return CONTENT_TYPES.find(([suffix]) => lower.endsWith(suffix))?.[1] ?? "application/octet-stream";
}

// Release tags and GitHub asset names are plain: letters, digits and . _ - +
// (GitHub turns spaces into dots). Starting with a letter or digit keeps out
// dot files such as the mirror's own `.mirrored.json` index, and ".." never
// appears, so a request can only ever name an object under download/.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const DOWNLOAD_PATH = /^\/download\/([^/]+)\/([^/]+)$/;
const UPDATES_PATH = /^\/updates\/((?:[a-z0-9][a-z0-9_.-]*\/){0,3}[a-z0-9][a-z0-9_.-]*\.json)$/;

export function isSafeSegment(segment) {
  return SAFE_SEGMENT.test(segment) && !segment.includes("..");
}

/** Whether a mirrored file can change under the same name: channel pointers
 * (`latest.json`) and the floating `desktop-latest` release. Everything else
 * is versioned and never changes once published. */
function moving(tag, name) {
  return name.startsWith("latest") || tag === "desktop-latest";
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-length, content-range, etag",
};

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "accept, range, if-none-match, cache-control",
      "access-control-max-age": "86400",
    },
  });
}

function methodNotAllowed() {
  return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD, OPTIONS" } });
}

/** One `bytes=` range against an object of `size` bytes: {offset, length},
 * "unsatisfiable", or null for no (or an unsupported multi-part) range. */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

function etagMatches(header, etag) {
  if (!header || !etag) return false;
  return header.split(",").some((value) => {
    const tag = value.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

async function download(request, env, tag, name) {
  const github = `${GITHUB_DOWNLOAD}/${tag}/${name}`;
  if (!isSafeSegment(tag) || !isSafeSegment(name)) {
    return new Response("Not a release file.\n", { status: 404 });
  }
  if (!env.RELEASES) return Response.redirect(github, 302);
  const key = `download/${tag}/${name}`;
  // An R2 hiccup is not worth an error page: GitHub has every file too.
  const head = await env.RELEASES.head(key).catch(() => null);
  if (!head) return Response.redirect(github, 302);

  const headers = new Headers(CORS);
  headers.set("content-type", contentTypeFor(name));
  headers.set("accept-ranges", "bytes");
  headers.set("etag", head.httpEtag);
  headers.set(
    "cache-control",
    moving(tag, name) ? "public, max-age=60" : "public, max-age=31536000, immutable",
  );
  if (!contentTypeFor(name).startsWith("application/json") && !name.endsWith(".sig")) {
    headers.set("content-disposition", `attachment; filename="${name}"`);
  }
  if (etagMatches(request.headers.get("if-none-match"), head.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }

  // A resumed or parallel download asks for a part. A range that comes with
  // If-Range for some other version of the file gets the whole file.
  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== head.httpEtag
    ? null
    : parseRange(request.headers.get("range"), head.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("content-length", String(range.length));
  } else {
    headers.set("content-length", String(head.size));
  }
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const object = await env.RELEASES.get(key, range ? { range } : undefined).catch(() => null);
  // Deleted between the two calls: GitHub still has it.
  if (!object) return Response.redirect(github, 302);
  return new Response(object.body, { status, headers });
}

async function updates(request, env, path) {
  const object = await env.RELEASES?.get(`updates/${path}`).catch(() => null);
  const headers = new Headers(CORS);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "public, max-age=60");
  if (object) {
    headers.set("etag", object.httpEtag);
    headers.set("content-length", String(object.size));
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  }

  // Nothing mirrored yet: answer as the clients' second source would.
  if (path === "desktop/latest.json") {
    return Response.redirect(`${GITHUB_DOWNLOAD}/desktop-latest/latest.json`, 302);
  }
  if (path === "releases.json") {
    const listing = await githubReleases(100).catch(() => null);
    if (!listing) return new Response("GitHub did not answer. Try again shortly.\n", { status: 502, headers: CORS });
    return new Response(request.method === "HEAD" ? null : JSON.stringify(listing), { headers });
  }
  // The Web UI pointer must be signed for this host; the apps fall back to
  // GitHub's own pointer by themselves.
  return new Response("Not mirrored.\n", { status: 404, headers: CORS });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const fallback = `https://github.com/${REPO}/releases`;

    const file = DOWNLOAD_PATH.exec(url.pathname);
    const meta = UPDATES_PATH.exec(url.pathname);
    if (file || meta || url.pathname.startsWith("/download/") || url.pathname.startsWith("/updates/")) {
      if (request.method === "OPTIONS") return preflight();
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
      if (file) return download(request, env, file[1], file[2]);
      if (meta && !meta[1].includes("..")) return updates(request, env, meta[1]);
      return new Response("Not found.\n", { status: 404 });
    }

    const apk = /^\/apk(?:\/([a-z0-9_-]+))?\/?$/.exec(url.pathname);
    if (apk) {
      const abi = apk[1] ?? "arm64-v8a";
      if (abi !== "release" && !ABIS.has(abi)) {
        return new Response("Unknown APK flavour. Try /apk, /apk/universal, /apk/x86_64 or /apk/release.\n", { status: 404 });
      }
      const listing = await releases(env);
      return Response.redirect((listing && apkTarget(listing, abi)) ?? fallback, 302);
    }

    const desktop = /^\/(mac|windows|linux|desktop)\/?$/.exec(url.pathname);
    if (desktop) {
      const flavour = desktop[1] === "desktop" ? "release" : desktop[1];
      const listing = await releases(env);
      return Response.redirect((listing && desktopTarget(listing, flavour)) ?? fallback, 302);
    }

    return env.ASSETS.fetch(request);
  },
};
