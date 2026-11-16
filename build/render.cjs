const sharp = require('/home/claude/.npm-global/lib/node_modules/sharp'); const fs = require('fs');
(async () => {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];
  const pngs = [];
  for (const s of sizes) pngs.push(await sharp(s <= 32 ? 'tracelab-small.svg' : 'tracelab.svg', { density: 600 }).resize(s, s).png().toBuffer());
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length); let off = 6 + dir.length;
  sizes.forEach((s, i) => { const o = i * 16; dir[o] = s >= 256 ? 0 : s; dir[o + 1] = s >= 256 ? 0 : s; dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(pngs[i].length, o + 8); dir.writeUInt32LE(off, o + 12); off += pngs[i].length; });
  fs.writeFileSync('tracelab.ico', Buffer.concat([head, dir, ...pngs]));
  await sharp('tracelab.svg', { density: 600 }).resize(512, 512).png().toFile('tracelab-512.png');
  // preview sheet: 512, 128, 48, 32, 16 on dark and light
  const comp = []; let x = 20;
  for (const [s, src] of [[256, 'tracelab.svg'], [128, 'tracelab.svg'], [48, 'tracelab.svg'], [32, 'tracelab-small.svg'], [16, 'tracelab-small.svg']]) {
    const b = await sharp(src, { density: 600 }).resize(s, s).png().toBuffer();
    comp.push({ input: b, left: x, top: 20 }, { input: b, left: x, top: 300 }); x += s + 30;
  }
  await sharp({ create: { width: x, height: 580, channels: 4, background: '#1e1e1e' } }).composite([{ input: Buffer.from(`<svg width="${x}" height="290"><rect width="${x}" height="290" fill="#f3f3f3"/></svg>`), left: 0, top: 290 }, ...comp]).png().toFile('preview.png');
  console.log('done');
})();
