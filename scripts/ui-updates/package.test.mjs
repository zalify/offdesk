import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,verify,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {packageUi} from './package.mjs';
test('signed release matches exact asset bytes and injects runtime version',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'offdesk-ui-package-'));
  try {
    const dist=path.join(root,'dist'), output=path.join(root,'output'); fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist,'index.html'),'<html><head></head><body>你好</body></html>');
    fs.writeFileSync(path.join(dist,'entry.js'),'window.test=1');
    fs.writeFileSync(path.join(dist,'entry.js.map'),'private source');
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    const options={directory:dist,output,version:'rc-1',sequence:1,channel:'rc',privateKey:privateKey.export({type:'pkcs8',format:'pem'})};
    packageUi(options);
    const envelope=JSON.parse(fs.readFileSync(path.join(output,'latest.json')));
    assert(verify(null,Buffer.from(envelope.payload),publicKey,Buffer.from(envelope.signature,'base64')));
    const bytes=fs.readFileSync(path.join(output,'bundle.json')), manifest=JSON.parse(envelope.payload), bundle=JSON.parse(bytes);
    assert.equal(manifest.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(manifest.size,bytes.length);
    assert.match(Buffer.from(bundle.files['index.html'],'base64').toString(),/__OFFDESK_UI_VERSION__="rc-1"/);
    assert.equal(bundle.files['entry.js.map'],undefined);
    const old=path.join(root,'old.json');fs.copyFileSync(path.join(output,'latest.json'),old);
    packageUi({...options,version:'rc-2',sequence:2});
    const rollback=path.join(root,'rollback.json');
    const command=spawnSync(process.execPath,[new URL('./rollback.mjs',import.meta.url).pathname,old,path.join(output,'latest.json'),rollback],{encoding:'utf8',env:{...process.env,OFFDESK_UI_SIGNING_KEY:options.privateKey}});
    assert.equal(command.status,0,command.stderr);
    const restored=JSON.parse(fs.readFileSync(rollback)), target=JSON.parse(restored.payload);
    assert.equal(target.sequence,3);assert.equal(target.version,'rc-1');
    assert(verify(null,Buffer.from(restored.payload),publicKey,Buffer.from(restored.signature,'base64')));
    assert.throws(()=>packageUi({...options,version:'../evil'}));
    fs.symlinkSync(path.join(dist,'entry.js'),path.join(dist,'link.js'));
    assert.throws(()=>packageUi(options),/symlinks/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
