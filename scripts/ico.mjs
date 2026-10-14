// Pack PNGs into one .ico, each kept as PNG (Windows Vista and later read
// those at every size), so each size can be drawn for itself instead of
// scaled down from one big image.
//
//   node scripts/ico.mjs out.ico 16.png 24.png 32.png ...
import { readFileSync, writeFileSync } from "node:fs";

const [out, ...inputs] = process.argv.slice(2);
if (!out || inputs.length === 0) {
  console.error("usage: node scripts/ico.mjs out.ico in.png...");
  process.exit(1);
}

const images = inputs.map((file) => {
  const data = readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);
  // IHDR is the first chunk: width and height at bytes 16 and 20.
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
});

const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(({ data, width, height }, i) => {
  const e = 6 + i * 16;
  header.writeUInt8(width >= 256 ? 0 : width, e); // 0 means 256
  header.writeUInt8(height >= 256 ? 0 : height, e + 1);
  header.writeUInt8(0, e + 2); // no palette
  header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});

writeFileSync(out, Buffer.concat([header, ...images.map((i) => i.data)]));
console.log(`wrote ${out}: ${images.map((i) => i.width).join(", ")}`);
