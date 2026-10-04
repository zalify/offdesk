// Produce immutable UI bytes and a signed channel pointer. No native build.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export function packageUi({ directory, output, version, sequence, channel, privateKey }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(version)) throw new Error('Invalid UI version');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid release sequence');
  if (!['rc', 'stable'].includes(channel)) throw new Error('Invalid release channel');
  const files = {};
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), relative = prefix + name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('UI bundles cannot contain symlinks');
      if (stat.isDirectory()) walk(file, relative + '/');
      else if (stat.isFile() && !name.endsWith('.map')) {
        if (/[\\:\0?#%]/.test(relative)) throw new Error('Invalid asset path');
        let bytes = fs.readFileSync(file);
        if (name.endsWith('.html')) {
          let html = bytes.toString('utf8');
          if (!html.includes('<head>')) throw new Error('Missing HTML head');
          html = html.replace('<head>', `<head><script>window.__OFFDESK_UI_VERSION__=${JSON.stringify(version)};</script>`);
          bytes = Buffer.from(html);
        }
        files[relative] = bytes.toString('base64');
      }
    }
  }
  walk(directory);
  if (!files['index.html']) throw new Error('Missing index.html');
  if (Object.keys(files).length > 4096 || Object.values(files).reduce((n,b) => n + Buffer.from(b,'base64').length, 0) > 36 * 1024 * 1024) throw new Error('Too many UI assets');
  const bundle = Buffer.from(JSON.stringify({format:1, version, files}));
  if (bundle.length > 48 * 1024 * 1024) throw new Error('UI bundle too large');
  const payload = JSON.stringify({format:1, sequence, version, channel, minBridge:1, maxBridge:1,
    platforms:['macos','android'], url:`https://github.com/zalify/offdesk/releases/download/ui-${version}/bundle.json`,
    sha256:createHash('sha256').update(bundle).digest('hex'), size:bundle.length});
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 release key');
  const envelope = {payload, signature:sign(null, Buffer.from(payload), key).toString('base64')};
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'bundle.json'), bundle);
  fs.writeFileSync(path.join(output,'latest.json'), JSON.stringify(envelope));
  const jwk=createPublicKey(key).export({format:'jwk'});
  return {version, sequence, channel, size:bundle.length, publicKey:Buffer.from(jwk.x,'base64url').toString('base64')};
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory,output,version,sequence,channel] = process.argv.slice(2);
  const privateKey = process.env.OFFDESK_UI_SIGNING_KEY;
  if (!privateKey || !directory || !output || !channel) throw new Error('Usage: OFFDESK_UI_SIGNING_KEY=<PEM> node package.mjs <dist> <out> <version> <sequence> <rc|stable>');
  console.log(JSON.stringify(packageUi({directory,output,version,sequence:Number(sequence),channel,privateKey})));
}
