// Tests for the script served at https://offdesk.dev/install.
//
// It lives outside `public/` on purpose: everything in there is published
// verbatim, and a test file is not part of the site.
//
// The script is driven with a fake `curl` on PATH, so nothing here touches
// the network, offdesk.dev's mirror or the real GitHub API.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(new URL("public/install", import.meta.url));

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
}

// `apiStatus` is what the fake curl reports for the releases API, and
// `assets` is the set of release files that exist. Between them they cover
// every way the installer can fail. `mirror` is offdesk.dev: "up" serves the
// listing and the files, "down" answers nothing, "no-files" serves the
// listing only, "empty" serves a listing with no release in it, and
// `mirrorTags` are the releases its listing names. Every URL the installer
// asks for is in `calls`.
function run({
  args = [],
  apiStatus = 200,
  mirror = "up",
  mirrorTags = ["desktop-v0.3.14", "v1.2.3", "v1.2.10"],
  assets = [
    "offdesk-darwin-arm64",
    "offdesk-node-darwin-arm64",
    "offdesk-hub-darwin-arm64",
  ],
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "offdesk-install-"));
  const binDir = join(tempDir, "bin");
  const prefix = join(tempDir, "prefix");
  mkdirSync(binDir);

  writeExecutable(
    join(binDir, "uname"),
    `#!/bin/sh
[ "$1" = "-s" ] && { echo Darwin; exit 0; }
[ "$1" = "-m" ] && { echo arm64; exit 0; }
exit 1
`,
  );
  writeExecutable(join(binDir, "tmux"), "#!/bin/sh\nexit 0\n");

  const log = join(tempDir, "calls.log");
  writeExecutable(
    join(binDir, "curl"),
    `#!/bin/sh
eval "url=\\\${$#}"
printf '%s\\n' "$url" >> '${log}'
case "$url" in
  https://offdesk.dev/*)
    case '${mirror}' in
      down) exit 7 ;;
      no-files) case "$url" in */download/*) exit 22 ;; esac ;;
      empty) case "$url" in */updates/releases.json) printf '[]'; exit 0 ;; esac ;;
    esac
    ;;
esac

# http_status: curl -sSL -o /dev/null -w %{http_code} <url>
if [ "$1" = "-sSL" ] && [ "$2" = "-o" ]; then
  printf '%s' '${apiStatus}'
  exit 0
fi

# fetch_to: curl -fsSL -o <dest> <url>
if [ "$1" = "-fsSL" ] && [ "$2" = "-o" ]; then
  for asset in ${assets.join(" ") || '""'}; do
    case "$4" in
      # The hub is run by the installer, so its stand-in is a script that
      # reports the call instead of a marker file.
      *"/offdesk-hub-"*) printf '#!/bin/sh\necho "offdesk-hub $*"\n' > "$3"; exit 0 ;;
      *"/offdesk-node-"*) printf '#!/bin/sh\necho "offdesk-node $*"\n' > "$3"; exit 0 ;;
      *"/$asset") printf 'binary:%s' "$asset" > "$3"; exit 0 ;;
    esac
  done
  exit 22
fi

# fetch: curl -fsSL <api>
if [ "$1" = "-fsSL" ]; then
  case "$url" in
    https://offdesk.dev/*) printf '%s' '${JSON.stringify(mirrorTags.map((tag_name) => ({ tag_name })))}'; exit 0 ;;
  esac
  [ "${apiStatus}" = "200" ] || exit 22
  printf '%s' '[{"tag_name":"desktop-v0.3.14"},{"tag_name":"v1.2.3"},{"tag_name":"v1.2.10"}]'
  exit 0
fi

echo "unexpected curl args: $*" >&2
exit 1
`,
  );

  const result = spawnSync("/bin/sh", [installer, "--prefix", prefix, ...args], {
    env: { ...process.env, HOME: tempDir, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf8",
  });

  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { result, prefix, tempDir, calls };
}

function cleanup(tempDir) {
  rmSync(tempDir, { recursive: true, force: true });
}

test("picks the newest vX.Y.Z release", () => {
  const { result, prefix, tempDir } = run();
  try {
    assert.equal(result.status, 0, result.stderr);
    // v1.2.10 over v1.2.3, and never the desktop tag.
    assert.match(result.stdout, /Installing offdesk v1\.2\.10 \(darwin\/arm64\)/);
    assert.equal(readFileSync(join(prefix, "offdesk"), "utf8"), "binary:offdesk-darwin-arm64");
    assert.match(
      readFileSync(join(prefix, "offdesk-node"), "utf8"),
      /offdesk-node/,
    );
  } finally {
    cleanup(tempDir);
  }
});

test("everything is installed by default, and the hub is started as a service", () => {
  const { result, prefix, tempDir } = run();
  try {
    assert.equal(result.status, 0, result.stderr);
    for (const name of ["offdesk", "offdesk-node", "offdesk-hub"]) {
      assert.ok(existsSync(join(prefix, name)), `${name} should be installed`);
    }
    // The one line ends with the hub running: the installer calls
    // `offdesk-hub service install`, which registers this machine and prints
    // the sign-in link itself.
    assert.match(result.stdout, /offdesk-hub service install/);
    assert.doesNotMatch(result.stdout, /Next: start the hub/);
  } finally {
    cleanup(tempDir);
  }
});

test("--no-service installs the binaries and says what to run", () => {
  const { result, prefix, tempDir } = run({ args: ["--no-service"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(prefix, "offdesk-hub")));
    assert.match(result.stdout, /Next: start the hub/);
    // The stand-in hub echoes its call at the start of a line; the "Next:"
    // text only mentions the command, indented.
    assert.doesNotMatch(result.stdout, /^offdesk-hub service install/m);
  } finally {
    cleanup(tempDir);
  }
});

test("--node-only is just the agent, for the second machine", () => {
  const { result, prefix, tempDir } = run({ args: ["--node-only"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(prefix, "offdesk-node")));
    assert.ok(!existsSync(join(prefix, "offdesk-hub")));
    assert.ok(!existsSync(join(prefix, "offdesk")));
  } finally {
    cleanup(tempDir);
  }
});

test("--hub-url and --token join a hub: agent only, registered, kept running", () => {
  const { result, prefix, tempDir } = run({
    args: ["--hub-url", "ws://192.168.1.10:4317/ws/machine", "--token", "abc-123"],
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(prefix, "offdesk-node")));
    assert.ok(!existsSync(join(prefix, "offdesk-hub")));
    assert.ok(!existsSync(join(prefix, "offdesk")));
    assert.match(
      result.stdout,
      /^offdesk-node register --hub-url ws:\/\/192\.168\.1\.10:4317\/ws\/machine --token abc-123$/m,
    );
    assert.match(result.stdout, /^offdesk-node service install$/m);
    assert.match(result.stdout, /This machine is connected/);
  } finally {
    cleanup(tempDir);
  }
});

test("--token without --hub-url is refused before anything is downloaded", () => {
  const { result, prefix, tempDir } = run({ args: ["--token", "abc-123"] });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--hub-url and --token go together/);
    assert.ok(!existsSync(join(prefix, "offdesk-node")));
  } finally {
    cleanup(tempDir);
  }
});

test("--hub-only installs the server alone", () => {
  const { result, prefix, tempDir } = run({ args: ["--hub-only"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(prefix, "offdesk-hub")));
    assert.ok(!existsSync(join(prefix, "offdesk")));
    assert.ok(!existsSync(join(prefix, "offdesk-node")));
  } finally {
    cleanup(tempDir);
  }
});

test("a 404 from the API is reported as a moved repository, not as a network failure", () => {
  const { result, tempDir } = run({ apiStatus: 404, mirror: "down" });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /returned 404 — the repository is gone or renamed/);
    assert.doesNotMatch(result.stderr, /could not reach/);
  } finally {
    cleanup(tempDir);
  }
});

test("rate limiting says so instead of blaming the release", () => {
  const { result, tempDir } = run({ apiStatus: 403, mirror: "down" });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rate-limited/);
  } finally {
    cleanup(tempDir);
  }
});

test("a release without this platform's binary points at building from source", () => {
  const { result, tempDir } = run({ assets: ["offdesk-node-darwin-arm64"] });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /release v1\.2\.10 has no offdesk-darwin-arm64/);
    assert.match(result.stderr, /cargo build --release --bin offdesk --bin offdesk-node/);
  } finally {
    cleanup(tempDir);
  }
});

test("the release list and the files come from offdesk.dev; GitHub only confirms the version", () => {
  const { result, prefix, tempDir, calls } = run();
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls[0], "https://offdesk.dev/updates/releases.json");
    assert.ok(calls.includes("https://offdesk.dev/download/v1.2.10/offdesk-darwin-arm64"), calls.join("\n"));
    assert.deepEqual(calls.filter((url) => url.includes("github.com")), ["https://api.github.com/repos/zalify/offdesk/releases"]);
    assert.equal(readFileSync(join(prefix, "offdesk"), "utf8"), "binary:offdesk-darwin-arm64");
  } finally {
    cleanup(tempDir);
  }
});

test("with offdesk.dev unreachable everything comes from GitHub as before", () => {
  const { result, prefix, tempDir, calls } = run({ mirror: "down" });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing offdesk v1\.2\.10/);
    assert.ok(calls.includes("https://api.github.com/repos/zalify/offdesk/releases"), calls.join("\n"));
    assert.ok(calls.includes("https://github.com/zalify/offdesk/releases/download/v1.2.10/offdesk-darwin-arm64"));
    assert.equal(readFileSync(join(prefix, "offdesk"), "utf8"), "binary:offdesk-darwin-arm64");
  } finally {
    cleanup(tempDir);
  }
});

test("a file offdesk.dev cannot serve is fetched from GitHub", () => {
  const { result, prefix, tempDir, calls } = run({ mirror: "no-files" });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(calls.includes("https://github.com/zalify/offdesk/releases/download/v1.2.10/offdesk-node-darwin-arm64"));
    assert.ok(existsSync(join(prefix, "offdesk-node")));
  } finally {
    cleanup(tempDir);
  }
});

test("an empty mirror listing is not \"no release\": GitHub is asked", () => {
  const { result, tempDir, calls } = run({ mirror: "empty" });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing offdesk v1\.2\.10/);
    assert.ok(calls.includes("https://api.github.com/repos/zalify/offdesk/releases"));
  } finally {
    cleanup(tempDir);
  }
});

test("a rate-limited GitHub does not matter while offdesk.dev answers", () => {
  const { result, tempDir } = run({ apiStatus: 403 });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing offdesk v1\.2\.10/);
  } finally {
    cleanup(tempDir);
  }
});

test("a release the mirror has not caught up with is still found on GitHub", () => {
  const { result, prefix, tempDir, calls } = run({ mirrorTags: ["v1.2.3"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing offdesk v1\.2\.10/);
    // offdesk.dev is asked for the file anyway: it redirects to GitHub for what it lacks.
    assert.ok(calls.includes("https://offdesk.dev/download/v1.2.10/offdesk-darwin-arm64"));
    assert.ok(existsSync(join(prefix, "offdesk")));
  } finally {
    cleanup(tempDir);
  }
});

test("a mirror ahead of an unreachable GitHub is believed", () => {
  const { result, tempDir } = run({ mirrorTags: ["v1.3.0"], apiStatus: 0, assets: ["offdesk-darwin-arm64", "offdesk-node-darwin-arm64", "offdesk-hub-darwin-arm64"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installing offdesk v1\.3\.0/);
  } finally {
    cleanup(tempDir);
  }
});
