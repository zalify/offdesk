// Prepare a newer signed pointer to a known-good immutable UI. Does not publish.
// Usage: OFFDESK_UI_SIGNING_KEY=<PEM> node rollback.mjs <known-good.json> <current-channel.json> <output.json>
import fs from 'node:fs';
import {createPrivateKey,createPublicKey,sign,verify} from 'node:crypto';
const [source,current,output]=process.argv.slice(2);
if (!source || !current || !output) throw new Error('Pass known-good manifest, current channel manifest and a new output path');
const key=createPrivateKey(process.env.OFFDESK_UI_SIGNING_KEY ?? '');
function verified(file) {
  const envelope=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!verify(null,Buffer.from(envelope.payload),createPublicKey(key),Buffer.from(envelope.signature,'base64')))throw new Error('Manifest has a different signer');
  return JSON.parse(envelope.payload);
}
const good=verified(source), latest=verified(current);
if(good.channel!==latest.channel || good.format!==1 || latest.format!==1)throw new Error('Rollback manifests must use the same channel and format');
const sequence=Math.max(good.sequence,latest.sequence)+1;
if(!Number.isSafeInteger(sequence))throw new Error('Invalid release sequence');
const payload=JSON.stringify({...good,sequence});
fs.writeFileSync(output,JSON.stringify({payload,signature:sign(null,Buffer.from(payload),key).toString('base64')}),{flag:'wx'});
console.log(`Prepared rollback to ${good.version} at sequence ${sequence}; upload the signed pointer to ${good.channel} after verification.`);
