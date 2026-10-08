// Ephemeral fixture signing key, never used by real releases.
import fs from 'node:fs';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {packageUi} from './package.mjs';
const [dist,out]=process.argv.slice(2);
if (!dist || !out || fs.existsSync(out)) throw new Error('Pass built dist and a NEW fixture directory');
fs.mkdirSync(out,{recursive:true,mode:0o700});
const {privateKey}=generateKeyPairSync('ed25519');
const pem=privateKey.export({type:'pkcs8',format:'pem'});
for(const [sequence,version] of [[1,'smoke-a'],[2,'smoke-b'],[3,'smoke-broken']]) {
  const input=path.join(out,`${version}-dist`);
  fs.cpSync(dist,input,{recursive:true});
  if(version==='smoke-broken') fs.writeFileSync(path.join(input,'index.html'),'<html><head></head><body>Broken UI test</body></html>');
  const metadata=packageUi({directory:input,output:path.join(out,version),version,sequence,channel:'rc',privateKey:pem});
  fs.writeFileSync(path.join(out,'public-key.txt'),metadata.publicKey);
  fs.rmSync(input,{recursive:true});
}
fs.writeFileSync(path.join(out,'tauri.smoke.conf.json'),JSON.stringify({identifier:'dev.offdesk.ui-smoke',productName:'Offdesk UI Smoke',build:{beforeBuildCommand:''},bundle:{active:true,createUpdaterArtifacts:false,macOS:{signingIdentity:'-'}}}));
console.log(`Created signed A/B/broken UI fixtures in ${out}`);
