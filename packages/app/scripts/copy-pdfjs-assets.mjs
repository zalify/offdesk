// Copies pdf.js's CMaps, standard fonts and wasm decoders (JPEG2000/ICC) into public/pdfjs/ so `expo export`
// ships them in dist/. Needed for PDFs with non-embedded CJK fonts. The copy is
// gitignored; every web build (`pnpm build`, desktop build:web, Docker, CI) runs
// through the app's `build` / `dev:web` scripts, which call this first.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const require = createRequire(path.join(appDir, "package.json"));
const pdfjsDir = path.dirname(require.resolve("pdfjs-dist/package.json"));
const outDir = path.join(appDir, "public", "pdfjs");

fs.rmSync(outDir, { recursive: true, force: true });
for (const name of ["cmaps", "standard_fonts", "wasm"]) {
  const from = path.join(pdfjsDir, name);
  if (!fs.existsSync(from)) throw new Error(`pdfjs-dist is missing ${name}/ (${from})`);
  fs.cpSync(from, path.join(outDir, name), { recursive: true });
}
console.log(`pdf.js assets copied to ${path.relative(process.cwd(), outDir) || outDir}`);
