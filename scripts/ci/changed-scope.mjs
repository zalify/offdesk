import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only known non-runtime paths may bypass the app suite. Unknown/new paths
// deliberately opt into full CI. The website also ships the real installer.
export function scopeFor(paths) {
  const site = paths.some(p => p.startsWith('site/') || p === '.github/workflows/site.yml' || p === '.github/workflows/ci.yml' || p.startsWith('scripts/ci/'));
  const runtime = paths.some(p => {
    if (p === 'site/public/install' || p === 'site/install.test.mjs') return true;
    return !(p.startsWith('site/') || p.startsWith('docs/') || /^(README(?:\.[^/]+)?\.md|CHANGELOG(?:\.[^/]+)?\.md|LICENSE|COPYING)$/.test(p) || p === '.github/workflows/site.yml');
  });
  return { site, runtime };
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
  const scope = paths === null ? { site: true, runtime: true } : scopeFor(paths);
  for (const [key, value] of Object.entries(scope)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  console.log(`Changed paths: ${paths?.length ?? 'unknown'}; site=${scope.site}; runtime=${scope.runtime}`);
}
