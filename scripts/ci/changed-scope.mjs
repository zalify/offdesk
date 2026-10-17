import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// What the Android check (APK build for both ABIs, native updater tests, real
// APK startup on an emulator) depends on: the native app and the crates it
// links, the toolchain locks, the check itself, and the screens and pairing
// code its startup test reads. Its history (2026-09 to 2026-10) caught real
// bugs only through these paths; changes elsewhere met emulator flakes. Pushes
// to main still run it on every runtime change, so a miss here surfaces right
// after merge rather than at release.
const ANDROID_PATHS = [
  /^packages\/desktop\//,
  /^crates\/(secure|ui-updates)\//,
  /^(Cargo\.toml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
  /^scripts\/android-startup-smoke\.py$/,
  /^scripts\/ci\//,
  /^\.github\/workflows\/ci\.yml$/,
  /^packages\/app\/app\/(login|_layout)\.tsx$/,
  /^packages\/app\/components\/(HubPickerPanel|ConnectionRoutesPanel|SecureConnectionPanel)\.tsx$/,
  /^packages\/app\/lib\/(secureTransport|platform|serverUrl|desktopHub|useMobileHubSwitch|uiUpdates[^/]*)\.tsx?$/,
];

// Only known non-runtime paths may bypass the app suite. Unknown/new paths
// deliberately opt into full CI. The website also ships the real installer.
// Pull requests run the Android check only for the paths above; other events
// run it whenever the runtime suite runs.
export function scopeFor(paths, eventName = 'pull_request') {
  // The release mirror script shares worker.js's rules, so its tests run with the site's.
  const site = paths.some(p => p.startsWith('site/') || p === '.github/workflows/site.yml' || p === '.github/workflows/ci.yml' || p.startsWith('scripts/ci/') || p.startsWith('scripts/mirror-release'));
  const runtime = paths.some(p => {
    if (p === 'site/public/install' || p === 'site/install.test.mjs') return true;
    return !(p.startsWith('site/') || p.startsWith('docs/') || /^(README(?:\.[^/]+)?\.md|CHANGELOG(?:\.[^/]+)?\.md|LICENSE|COPYING)$/.test(p) || p === '.github/workflows/site.yml');
  });
  const android = runtime && (eventName !== 'pull_request' || paths.some(p => ANDROID_PATHS.some(re => re.test(p))));
  return { site, runtime, android };
}

export function changedPaths(event, eventName, cwd = process.cwd()) {
  let base, head;
  if (eventName === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else if (eventName === 'push') {
    base = event.before;
    head = event.after;
    // A newly created branch has no previous revision: run all checks.
    if (/^0+$/.test(base ?? '')) return null;
  } else return null;
  if (![base, head].every(sha => /^[a-f0-9]{40,64}$/.test(sha ?? ''))) throw new Error('Missing or invalid diff revision');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  // PR scope excludes work that landed on the base branch after branching.
  if (eventName === 'pull_request') base = git(['merge-base', base, head]).trim();
  // Disable rename detection: runtime -> docs must include the runtime deletion.
  // NUL delimiters preserve filenames containing whitespace/newlines.
  return git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const paths = changedPaths(event, process.env.GITHUB_EVENT_NAME);
  const scope = paths === null ? { site: true, runtime: true, android: true } : scopeFor(paths, process.env.GITHUB_EVENT_NAME);
  for (const [key, value] of Object.entries(scope)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`Changed paths: ${paths?.length ?? 'unknown'}; site=${scope.site}; runtime=${scope.runtime}; android=${scope.android}`);
}
