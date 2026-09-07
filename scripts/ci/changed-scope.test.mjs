import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { changedPaths, scopeFor } from './changed-scope.mjs';

test('website, its dependencies and accompanying docs use the site suite only', () => {
  assert.deepEqual(scopeFor(['site/src/pages/docs/mac.astro', 'site/worker.js', 'site/pnpm-lock.yaml', 'site/public/media/guide.webp', 'docs/testing/first-run.md', 'README.md']), {site:true,runtime:false});
});
test('documentation alone needs no platform builds', () => {
  assert.deepEqual(scopeFor(['README.zh-CN.md','docs/setup-lan.md','LICENSE']), {site:false,runtime:false});
});
test('runtime, toolchain, test infrastructure and unknown paths keep full coverage', () => {
  for (const path of ['packages/app/app/index.tsx','crates/hub/src/main.rs','Cargo.lock','pnpm-lock.yaml','package.json','e2e/Dockerfile.runner','scripts/build.sh','new-root-file.txt','.github/workflows/ci.yml','scripts/ci/changed-scope.mjs','site/public/install','site/install.test.mjs']) {
    assert.equal(scopeFor([path]).runtime,true,path);
  }
});
test('mixed changes run both suites and directory-like names do not bypass CI', () => {
  assert.deepEqual(scopeFor(['site/worker.js','crates/hub/src/main.rs']),{site:true,runtime:true});
  assert.equal(scopeFor(['docs-helper.ts','README.md.sh','site-backend/main.rs']).runtime,true);
});
test('site deployment workflow runs site validation', () => {
  assert.deepEqual(scopeFor(['.github/workflows/site.yml']), {site:true,runtime:false});
});
test('new branch and unknown event request full validation; malformed revisions fail', () => {
  assert.equal(changedPaths({before:'0'.repeat(40)},'push'),null);
  assert.equal(changedPaths({},'workflow_dispatch'),null);
  assert.throws(()=>changedPaths({},'pull_request'),/invalid diff revision/);
});
function repository(t) {
  const dir=mkdtempSync(join(tmpdir(),'offdesk-ci-scope-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  git('init','-q');git('config','user.email','ci-test@example.invalid');git('config','user.name','CI Test');
  const write=(path,text)=>{mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text)};
  const commit=()=>{git('add','.');git('commit','-qm','fixture');return git('rev-parse','HEAD')};
  return {dir,git,write,commit};
}
test('a runtime file renamed into docs still runs the runtime suite', t => {
  const r=repository(t);r.write('runtime.rs','code\n');const base=r.commit();
  mkdirSync(join(r.dir,'docs'));renameSync(join(r.dir,'runtime.rs'),join(r.dir,'docs','example.md'));
  const head=r.commit();const paths=changedPaths({before:base,after:head},'push',r.dir);
  assert.deepEqual(new Set(paths),new Set(['runtime.rs','docs/example.md']));
  assert.equal(scopeFor(paths).runtime,true);
});
test('PR diff excludes unrelated base-branch changes and preserves unusual filenames', t => {
  const r=repository(t);r.write('README.md','base');const fork=r.commit();
  r.write('crates/hub/new.rs','base branch change');const base=r.commit();
  r.git('checkout','-qb','docs-pr',fork);r.write('site/public/with space\nand newline.txt','asset');const head=r.commit();
  const paths=changedPaths({pull_request:{base:{sha:base},head:{sha:head}}},'pull_request',r.dir);
  assert.deepEqual(paths,['site/public/with space\nand newline.txt']);
  assert.deepEqual(scopeFor(paths),{site:true,runtime:false});
});
test('missing git revision fails rather than reporting a safe empty change', t => {
  const r=repository(t);r.write('README.md','base');const head=r.commit();
  assert.throws(()=>changedPaths({before:'1'.repeat(40),after:head},'push',r.dir));
});
