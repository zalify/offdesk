import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('.', import.meta.url));
await writeFile(root + 'message.js', "export default 'Vite preview ready';\n");
const vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 5127, strictPort: true, allowedHosts: ['.preview.test'], hmr: { clientPort: 443, protocol: 'wss' } } });
await vite.listen();
const next = spawn(process.execPath, [root + 'node_modules/next/dist/bin/next', 'dev', root + 'next', '-H', '127.0.0.1', '-p', '5128'], { stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { next.kill('SIGTERM'); void vite.close().finally(() => process.exit()); });
let ready = false;
for (let i = 0; i < 90; i++) {
  try { if ((await fetch('http://127.0.0.1:5128')).ok) { ready = true; break; } } catch {}
  await new Promise(r => setTimeout(r, 500));
}
if (!ready) { next.kill(); await vite.close(); throw new Error('Next fixture failed to start'); }
console.log('PREVIEW_FIXTURE_READY');
