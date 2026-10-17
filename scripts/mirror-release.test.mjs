import test from "node:test";
import assert from "node:assert/strict";
import { mirrorUrl, needsUpload, releasesListing, rewriteDesktopManifest, uiPointerProblem } from "./mirror-release.mjs";

const gh = (tag, name) => `https://github.com/zalify/offdesk/releases/download/${tag}/${name}`;
const sha = (c) => `sha256:${c.repeat(64)}`;

test("an asset is uploaded unless the index has the same bytes", () => {
  const apk = { name: "offdesk-0.24.0-universal.apk", size: 10, digest: sha("a") };
  assert.equal(needsUpload(apk, undefined), true);
  assert.equal(needsUpload(apk, { size: 10, digest: sha("a") }), false);
  assert.equal(needsUpload(apk, { size: 10, digest: sha("b") }), true);
  // Without digests the size decides, except for a pointer that changes in place.
  assert.equal(needsUpload({ ...apk, digest: null }, { size: 10, digest: null }), false);
  assert.equal(needsUpload({ ...apk, digest: null }, { size: 11, digest: null }), true);
  assert.equal(needsUpload({ name: "latest.json", size: 10 }, { size: 10 }), true);
  assert.equal(needsUpload({ name: "latest.json", size: 10, digest: sha("a") }, { size: 10, digest: sha("a") }), false);
});

test("the desktop manifest keeps everything but points its links at the mirror", () => {
  const manifest = {
    version: "0.24.0",
    notes: "notes",
    pub_date: "2026-10-17T00:00:00Z",
    platforms: {
      "darwin-aarch64": { signature: "sig-mac", url: gh("v0.24.0", "Offdesk.DEV_universal.app.tar.gz") },
      "windows-x86_64": { signature: "sig-win", url: gh("v0.24.0", "Offdesk.DEV_0.24.0_x64-setup.exe") },
      "linux-x86_64": { signature: "sig-linux", url: "https://example.com/elsewhere.AppImage" },
      "linux-aarch64": { signature: "sig-odd", url: gh("v0.24.0", "nested/path") },
    },
  };
  const rewritten = rewriteDesktopManifest(manifest, "zalify/offdesk");
  assert.equal(rewritten.version, "0.24.0");
  assert.equal(rewritten.notes, "notes");
  assert.equal(rewritten.platforms["darwin-aarch64"].url, "https://offdesk.dev/download/v0.24.0/Offdesk.DEV_universal.app.tar.gz");
  assert.equal(rewritten.platforms["darwin-aarch64"].signature, "sig-mac");
  assert.equal(rewritten.platforms["windows-x86_64"].url, "https://offdesk.dev/download/v0.24.0/Offdesk.DEV_0.24.0_x64-setup.exe");
  // Anything that is not a plain release file stays as it was.
  assert.equal(rewritten.platforms["linux-x86_64"].url, "https://example.com/elsewhere.AppImage");
  assert.equal(rewritten.platforms["linux-aarch64"].url, gh("v0.24.0", "nested/path"));
});

test("the listing has GitHub's shape, links mirrored files to offdesk.dev and leaves drafts out", () => {
  const asset = (tag, name, digest) => ({
    name, size: 10, digest, content_type: "application/octet-stream", updated_at: "2026-10-17T00:00:00Z",
    browser_download_url: gh(tag, name), uploader: { login: "someone" },
  });
  const releases = [
    { tag_name: "v0.25.0", draft: true, assets: [asset("v0.25.0", "secret.apk", sha("f"))] },
    {
      tag_name: "v0.24.0", name: "Offdesk DEV v0.24.0", draft: false, prerelease: false,
      published_at: "2026-10-17T00:00:00Z", html_url: "https://github.com/zalify/offdesk/releases/tag/v0.24.0", body: "long notes",
      assets: [
        asset("v0.24.0", "offdesk-0.24.0-arm64-v8a.apk", sha("a")),
        asset("v0.24.0", "offdesk-0.24.0.ipa", sha("b")),
        asset("v0.24.0", "offdesk-hub-linux-x64", sha("c")),
      ],
    },
    { tag_name: "ui-stable", prerelease: true, assets: [asset("ui-stable", "latest.json", null)] },
  ];
  const copied = {
    "v0.24.0": { assets: {
      "offdesk-0.24.0-arm64-v8a.apk": { size: 10, digest: sha("a") },
      // Copied before GitHub's file was replaced: not the same bytes any more.
      "offdesk-0.24.0.ipa": { size: 10, digest: sha("0") },
    } },
    "ui-stable": { assets: { "latest.json": { size: 10, digest: null } } },
  };
  const listing = releasesListing(releases, copied);
  assert.deepEqual(listing.map((r) => r.tag_name), ["v0.24.0", "ui-stable"]);
  const [release, channel] = listing;
  assert.equal(release.html_url, "https://github.com/zalify/offdesk/releases/tag/v0.24.0");
  assert.equal(release.published_at, "2026-10-17T00:00:00Z");
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal(release.body, undefined);
  assert.deepEqual(release.assets[0], {
    name: "offdesk-0.24.0-arm64-v8a.apk", size: 10, content_type: "application/octet-stream", digest: sha("a"),
    updated_at: "2026-10-17T00:00:00Z", browser_download_url: mirrorUrl("v0.24.0", "offdesk-0.24.0-arm64-v8a.apk"),
  });
  assert.equal(release.assets[1].browser_download_url, gh("v0.24.0", "offdesk-0.24.0.ipa"));
  assert.equal(release.assets[2].browser_download_url, gh("v0.24.0", "offdesk-hub-linux-x64"));
  assert.equal(channel.prerelease, true);
  assert.equal(channel.assets[0].browser_download_url, gh("ui-stable", "latest.json"));
});

test("a Web UI pointer goes up only signed for its channel, linking a bundle already mirrored", () => {
  const manifest = { channel: "stable", version: "stable-1-1", size: 42, url: "https://offdesk.dev/download/ui-stable/bundle-stable-1-1.json" };
  const envelope = (m) => ({ payload: JSON.stringify(m), signature: "c2lnbmF0dXJl" });
  const index = { assets: { "bundle-stable-1-1.json": { size: 42 } } };
  assert.equal(uiPointerProblem(envelope(manifest), "stable", index), null);
  assert.match(uiPointerProblem(envelope(manifest), "rc", index), /channel stable/);
  assert.match(uiPointerProblem(envelope(manifest), "stable", { assets: {} }), /not in the bucket/);
  assert.match(uiPointerProblem(envelope(manifest), "stable", { assets: { "bundle-stable-1-1.json": { size: 41 } } }), /not in the bucket/);
  assert.match(uiPointerProblem(envelope({ ...manifest, url: gh("ui-stable", "bundle-stable-1-1.json") }), "stable", index), /not under/);
  assert.match(uiPointerProblem(envelope({ ...manifest, url: "https://offdesk.dev/download/ui-stable/../x" }), "stable", index), /plain file/);
  assert.match(uiPointerProblem({ payload: JSON.stringify(manifest), signature: "" }, "stable", index), /not signed/);
  assert.match(uiPointerProblem({ payload: "{", signature: "x" }, "stable", index), /envelope/);
});
