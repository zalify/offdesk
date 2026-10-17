#!/usr/bin/env node
// Copy GitHub releases into the R2 bucket that offdesk.dev serves them from.
//
// In mainland China github.com, api.github.com and GitHub's download host are
// unreliable without a proxy; offdesk.dev is not. The apps, the Hub and the
// installer therefore ask offdesk.dev first (site/worker.js) and GitHub
// second. This script fills the bucket:
//
//   download/<tag>/<asset>          every asset of the release, byte for byte
//   download/<tag>/.mirrored.json   what has been copied (name, size, digest),
//                                   so a re-run skips it; the worker never
//                                   serves dot files
//   updates/releases.json           (--updates) GitHub's release listing,
//                                   links to mirrored files rewritten to
//                                   https://offdesk.dev/download/<tag>/<name>
//   updates/desktop/latest.json     (--updates) the desktop updater manifest
//                                   from `desktop-latest`, its links rewritten
//                                   the same way (minisign signs the files,
//                                   not the links)
//   updates/ui/<channel>/latest.json  (--ui-pointer) the Web UI pointer signed
//                                   for offdesk.dev, uploaded only once the
//                                   bundle it names is in the bucket
//
// Usage:
//   node scripts/mirror-release.mjs [<tag>...] [--updates]
//        [--ui-pointer <channel>=<file>] [--force]
//
// Needs `gh` (GH_TOKEN in CI) and wrangler, run through npx (WRANGLER
// overrides the command). wrangler reads CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID, or a `wrangler login` on a workstation. In CI
// without CLOUDFLARE_API_TOKEN it warns and does nothing, so a release never
// fails for want of the mirror. Safe to re-run: files already copied with the
// same digest (or size, when GitHub gives no digest) are skipped.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { contentTypeFor, isSafeSegment } from "../site/worker.js";

export const MIRROR = "https://offdesk.dev";
const BUCKET = process.env.MIRROR_BUCKET || "offdesk-dev-releases";
const REPO = process.env.GITHUB_REPOSITORY || "zalify/offdesk";
const INDEX = ".mirrored.json";
// The clients read at most this many releases (the Android updater and the
// iPhone notice ask GitHub for 100).
const LISTED = 100;

export const mirrorUrl = (tag, name) => `${MIRROR}/download/${tag}/${name}`;
const githubDownload = (repo) => `https://github.com/${repo}/releases/download/`;

/** Whether an asset has to be (re)uploaded, given its entry in the index.
 * Channel pointers keep their name while their bytes change, so with no
 * digest to compare they always go up again. */
export function needsUpload(asset, copied) {
  if (!copied) return true;
  if (asset.digest && copied.digest) return asset.digest !== copied.digest;
  if (asset.name.startsWith("latest")) return true;
  return asset.size !== copied.size;
}

/** The desktop updater manifest with every GitHub download link pointing at
 * the mirror instead. offdesk.dev redirects to GitHub for anything it does
 * not have, so the links work before the files are copied too. */
export function rewriteDesktopManifest(manifest, repo = REPO) {
  const prefix = githubDownload(repo);
  const platforms = Object.fromEntries(
    Object.entries(manifest.platforms ?? {}).map(([platform, entry]) => {
      const rest = typeof entry?.url === "string" && entry.url.startsWith(prefix) ? entry.url.slice(prefix.length) : null;
      const [tag, name, ...extra] = rest?.split("/") ?? [];
      const url = rest && !extra.length && isSafeSegment(tag ?? "") && isSafeSegment(name ?? "") ? mirrorUrl(tag, name) : entry.url;
      return [platform, { ...entry, url }];
    }),
  );
  return { ...manifest, platforms };
}

/** GitHub's release listing, cut to what the clients read, with mirrored
 * assets linking to offdesk.dev. `copied` maps a tag to its index. Drafts are
 * left out: the token that lists them can see what the public cannot. */
export function releasesListing(releases, copied) {
  return releases
    .filter((release) => !release.draft)
    .slice(0, LISTED)
    .map((release) => {
      const index = copied[release.tag_name]?.assets ?? {};
      return {
        tag_name: release.tag_name,
        name: release.name,
        draft: false,
        prerelease: Boolean(release.prerelease),
        created_at: release.created_at,
        published_at: release.published_at,
        html_url: release.html_url,
        assets: (release.assets ?? []).map((asset) => ({
          name: asset.name,
          size: asset.size,
          content_type: asset.content_type,
          // The Android updater requires GitHub's SHA-256 digest.
          digest: asset.digest ?? null,
          updated_at: asset.updated_at,
          browser_download_url:
            index[asset.name] && !needsUpload(asset, index[asset.name])
              ? mirrorUrl(release.tag_name, asset.name)
              : asset.browser_download_url,
        })),
      };
    });
}

/** The reason a Web UI pointer may not be published yet, or null. It must
 * be a signed envelope for this channel whose bundle link is the mirror's
 * copy, and that copy must already be in the bucket. The signature itself
 * was checked when it was made (scripts/ui-updates/package.mjs). */
export function uiPointerProblem(envelope, channel, index) {
  let manifest;
  try {
    manifest = JSON.parse(envelope.payload);
  } catch {
    return "not a signed envelope";
  }
  if (typeof envelope.signature !== "string" || !envelope.signature) return "not signed";
  if (manifest.channel !== channel) return `signed for channel ${manifest.channel}, not ${channel}`;
  const prefix = `${MIRROR}/download/ui-${channel}/`;
  if (typeof manifest.url !== "string" || !manifest.url.startsWith(prefix)) return `bundle link is not under ${prefix}`;
  const name = manifest.url.slice(prefix.length);
  if (!isSafeSegment(name)) return "bundle link is not a plain file name";
  const copied = index?.assets?.[name];
  if (!copied || copied.size !== manifest.size) return `${name} is not in the bucket yet`;
  return null;
}

// ── side effects ─────────────────────────────────────────────────────

const wranglerCommand = () => (process.env.WRANGLER || "npx --yes wrangler@4").split(/\s+/).filter(Boolean);

function run(command, args, { input, capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", "pipe"] });
    const out = [];
    const err = [];
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(Object.assign(new Error(`${command} ${args[0]} exited ${code}`), { stderr: Buffer.concat(err).toString() }));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

const wrangler = (args) => {
  const [command, ...prefix] = wranglerCommand();
  return run(command, [...prefix, ...args]);
};

async function getObject(key) {
  try {
    return await wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--pipe", "--remote"]);
  } catch {
    return null; // Missing, which is all a first run ever sees.
  }
}

async function putObject(key, file, contentType) {
  try {
    await wrangler(["r2", "object", "put", `${BUCKET}/${key}`, "--file", file, "--content-type", contentType, "--remote"]);
  } catch (error) {
    throw new Error(
      `Could not upload ${key} to R2 bucket ${BUCKET}.\n${error.stderr ?? error.message}\n` +
        "If this is an authentication or permission error: CLOUDFLARE_API_TOKEN needs " +
        "Account → Workers R2 Storage → Edit (and CLOUDFLARE_ACCOUNT_ID must be set).",
    );
  }
}

async function readIndex(tag) {
  const bytes = await getObject(`download/${tag}/${INDEX}`);
  try {
    const index = bytes && JSON.parse(bytes.toString("utf8"));
    if (index && typeof index.assets === "object") return index;
  } catch {
    // A damaged index only costs a re-upload.
  }
  return { tag, assets: {} };
}

async function putJson(key, value, work) {
  const file = join(work, "upload.json");
  writeFileSync(file, JSON.stringify(value));
  await putObject(key, file, "application/json");
}

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

async function mirrorTag(tag, work, force) {
  if (!isSafeSegment(tag)) throw new Error(`${tag} is not a release tag`);
  const release = JSON.parse(gh(["api", `repos/${REPO}/releases/tags/${tag}`]));
  if (release.draft) throw new Error(`${tag} is a draft; publish it first`);
  const index = await readIndex(tag);
  let uploaded = 0;
  try {
    for (const asset of release.assets ?? []) {
      if (!isSafeSegment(asset.name)) {
        console.warn(`::warning::skipping ${tag}/${asset.name}: not a plain file name`);
        continue;
      }
      if (!force && !needsUpload(asset, index.assets[asset.name])) continue;
      const dir = mkdtempSync(join(work, "asset-"));
      try {
        gh(["release", "download", tag, "--repo", REPO, "--pattern", asset.name, "--dir", dir, "--clobber"]);
        const file = join(dir, asset.name);
        const size = statSync(file).size;
        if (size !== asset.size) throw new Error(`${tag}/${asset.name}: downloaded ${size} bytes, GitHub lists ${asset.size}`);
        await putObject(`download/${tag}/${asset.name}`, file, contentTypeFor(asset.name));
        index.assets[asset.name] = { size: asset.size, digest: asset.digest ?? null };
        uploaded++;
        console.log(`  ${tag}/${asset.name} (${asset.size} bytes)`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    // Recorded even when a later upload fails, so the retry skips these.
    if (uploaded) await putJson(`download/${tag}/${INDEX}`, index, work);
  }
  console.log(`${tag}: ${uploaded} uploaded, ${(release.assets ?? []).length - uploaded} already mirrored`);
  return index;
}

async function inParallel(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await task(items[i]);
      }
    }),
  );
  return results;
}

async function publishUpdates(work, known) {
  const releases = JSON.parse(gh(["api", `repos/${REPO}/releases?per_page=${LISTED}`]));
  const tags = releases.filter((r) => !r.draft && isSafeSegment(r.tag_name ?? "")).map((r) => r.tag_name);
  const indexes = await inParallel(tags, 8, (tag) => known.get(tag) ?? readIndex(tag));
  const copied = Object.fromEntries(tags.map((tag, i) => [tag, indexes[i]]));
  await putJson("updates/releases.json", releasesListing(releases, copied), work);
  console.log(`updates/releases.json: ${tags.length} releases`);

  const latest = JSON.parse(gh(["release", "download", "desktop-latest", "--repo", REPO, "--pattern", "latest.json", "--output", "-"]));
  await putJson("updates/desktop/latest.json", rewriteDesktopManifest(latest), work);
  console.log(`updates/desktop/latest.json: ${latest.version}`);
}

async function publishUiPointer(spec, work, known) {
  const [channel, file] = spec.split(/=(.*)/s);
  if (!["rc", "stable"].includes(channel) || !file) throw new Error("--ui-pointer takes <rc|stable>=<file>");
  const envelope = JSON.parse(readFileSync(file, "utf8"));
  const index = known.get(`ui-${channel}`) ?? (await readIndex(`ui-${channel}`));
  const problem = uiPointerProblem(envelope, channel, index);
  if (problem) throw new Error(`Web UI pointer for ${channel} not published: ${problem}`);
  await putJson(`updates/ui/${channel}/latest.json`, envelope, work);
  console.log(`updates/ui/${channel}/latest.json: ${JSON.parse(envelope.payload).version}`);
}

async function main(argv) {
  const tags = [];
  const pointers = [];
  let updates = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--updates") updates = true;
    else if (arg === "--force") force = true;
    else if (arg === "--ui-pointer") pointers.push(argv[++i] ?? "");
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else tags.push(arg);
  }
  if (!tags.length && !updates && !pointers.length) {
    throw new Error("Usage: node scripts/mirror-release.mjs [<tag>...] [--updates] [--ui-pointer <channel>=<file>] [--force]");
  }
  if (process.env.CI && !process.env.CLOUDFLARE_API_TOKEN) {
    console.log("::warning::CLOUDFLARE_API_TOKEN is not set: offdesk.dev's release mirror was not updated.");
    return;
  }
  const work = mkdtempSync(join(tmpdir(), "offdesk-mirror-"));
  try {
    const known = new Map();
    for (const tag of tags) known.set(tag, await mirrorTag(tag, work, force));
    // The pointer moves only after its bundle is up (the tag above).
    for (const pointer of pointers) await publishUiPointer(pointer, work, known);
    if (updates) await publishUpdates(work, known);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message.split("\n")[0]}`);
    console.error(error.message);
    process.exit(1);
  });
}
