import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,verify,createHash} from 'node:crypto';
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
    assert.throws(()=>packageUi({...options,version:'../evil'}));
    fs.symlinkSync(path.join(dist,'entry.js'),path.join(dist,'link.js'));
    assert.throws(()=>packageUi(options),/symlinks/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
