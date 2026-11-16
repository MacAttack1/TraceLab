import zlib from "node:zlib";
import { parseBoardFiles, rc6Stream, desSchedule, desBlock, checkRC6Key, checkXZZKey } from "../web/js/parsers.js";

const enc = (s) => new Uint8Array(Buffer.from(s, "latin1"));
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL", m); } };
async function t(name, files, keys, check) {
  try {
    const b = await parseBoardFiles(files, keys);
    const nets = new Set(b.pins.map((p) => p.net).filter(Boolean));
    console.log(`${name.padEnd(18)} ${b.format.padEnd(18)} parts=${b.parts.length} pins=${b.pins.length} nets=${nets.size} outline=${b.outline.length}`);
    check && check(b, nets);
  } catch (e) { fails++; console.log(`${name.padEnd(18)} ERROR ${e.message}`); }
}
const pinOf = (b, part, num) => { const p = b.parts.find((x) => x.name === part); return p && p.pins.map((i) => b.pins[i]).find((q) => q.num === num); };

// ---- DES known-answer
{
  const k = [0x13, 0x34, 0x57, 0x79, 0x9b, 0xbc, 0xdf, 0xf1], pt = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
  const s = desSchedule(Uint8Array.from(k)); const out = new Uint8Array(8); desBlock(Uint8Array.from(pt), 0, out, 0, s, false);
  const hex = Buffer.from(out).toString("hex"); console.log("DES KAT", hex); ok(hex === "85e813540f0ab405", "DES encrypt");
  const back = new Uint8Array(8); desBlock(out, 0, back, 0, s, true); ok(Buffer.from(back).toString("hex") === "0123456789abcdef", "DES decrypt");
}

// ---- BRD plain + encoded
const brd = "str_length: 0\nvar_data: 4 3 5 1\nFormat:\n0 0\n2000 0\n2000 1000\n0 1000\nParts:\nU1 5 2\nR1 10 4\nJ1 1 5\nPins:\n100 100 1 1 PP3V3\n140 100 2 1 GND\n500 500 3 2 PP3V3\n540 500 4 2 \n900 900 5 3 GND\nNails:\n4 540 500 1 PP3V3_X\n";
await t("BRD", [{ name: "a.brd", bytes: enc(brd) }], {}, (b) => { ok(b.parts[1].side === "B", "R1 bottom"); ok(pinOf(b, "R1", "2").net === "PP3V3_X", "nail net fill"); });
{
  const raw = enc(brd); const e = new Uint8Array(raw.length + 4); e.set([0x23, 0xe2, 0x63, 0x28]);
  const inv = new Map(); for (let y = 0; y < 256; y++) inv.set((~(((y >> 6) & 3) | (y << 2))) & 0xff, y);
  raw.forEach((x, i) => (e[i + 4] = x === 10 || x === 13 || x === 0 ? x : inv.get(x)));
  await t("BRD encoded", [{ name: "b.brd", bytes: e }], {}, (b) => ok(b.parts.length === 3, "encoded parts"));
}
// ---- BRDOUT
await t("BRDOUT", [{ name: "c.brd", bytes: enc("BRDOUT: 4 1000 800\n0 0\n1000 0\n1000 800\n0 800\nNETS: 2\n1 VCC\n2 GND\nPARTS: 2\nU1 0 0 10 10 1 1\nC1 0 0 10 10 3 2\nPINS: 4\n10 10 1 1\n20 10 2 1\n50 50 1 2\n50 90 2 2\nNAILS: 1\n7 30 30 1 1\n") }], {}, (b) => { ok(pinOf(b, "C1", "1").y === 750, "bottom y flip"); ok(b.parts.some((p) => p.name === "TP7"), "nail TP"); });
// ---- BDV (encoding is the same involution)
{
  const plain = "\r\n<<format.asc>>\r\n0 0\r\n2.0 0\r\n2.0 1.0\r\n0 1.0\r\n<<pins.asc>>\r\nPin Name X Y Layer Net Nail\r\nPart U7 (T)\r\n1 1 0.100 0.200 1 PPBUS 12\r\n2 2 0.140 0.200 1 GND 0\r\nPart C9 (B)\r\n1 1 0.500 0.500 2 PPBUS 0\r\n2 2 0.540 0.500 2 GND 0\r\n<<nails.asc>>\r\n";
  const b = enc(plain); let count = 0xa0; for (let i = 0; i < b.length; i++) { if (b[i] === 13 && b[i + 1] === 10) count++; const x = b[i]; if (!(x === 13 || x === 10 || x === 0)) b[i] = (count - x) & 0xff; if (count > 285) count = 159; }
  await t("BDV", [{ name: "d.bdv", bytes: b }], {}, (bb) => { ok(pinOf(bb, "U7", "1").x === 100, "bdv x"); ok(bb.parts[1].side === "B", "bdv side"); });
  await t("ASC set", [{ name: "format.asc", bytes: enc("0 0\n2 0\n2 1\n") }, { name: "pins.asc", bytes: enc("Part U7 (T)\n1 A 1 0.1 0.2 1 PPBUS 0\n2 B 2 0.14 0.2 1 GND 0\n") }, { name: "nails.asc", bytes: enc("") }], {}, (bb) => ok(pinOf(bb, "U7", "A 1") && pinOf(bb, "U7", "A 1").net === "PPBUS", "asc pin name with space"));
}
// ---- BVR1 / BVR3
await t("BVR1", [{ name: "e.bvr", bytes: enc("BVRAW_FORMAT_1\n<<Layout>>\nx,y\n0,0\n2,0\n2,1\n<<Pin>>\nhdr\nU1 (T) 1 1 0.1 0.1 1 VCC\nU1 (T) 2 2 0.2 0.1 1 GND\nR4 (B) 1 1 0.5 0.5 2 VCC\n") }], {}, (b) => ok(b.parts.length === 2, "bvr1 parts"));
await t("BVR3", [{ name: "f.bvr", bytes: enc("BVRAW_FORMAT_3\nPART_NAME U1\nPART_SIDE T\nPART_ORIGIN 100 100\nPART_MOUNT SMD\nPIN_ID 1\nPIN_NUMBER 1\nPIN_NAME VIN\nPIN_SIDE T\nPIN_ORIGIN 10 0\nPIN_RADIUS 5\nPIN_NET PPVIN\nPIN_END\nPIN_NUMBER 2\nPIN_SIDE T\nPIN_ORIGIN -10 0\nPIN_NET GND\nPIN_END\nPART_END\nOUTLINE_SEGMENTED 0 0 1000 0 1000 0 1000 500 1000 500 0 500 0 500 0 0\n") }], {}, (b) => { ok(pinOf(b, "U1", "1").x === 110, "bvr3 origin"); ok(b.outline.length === 1, "bvr3 outline chain"); });
// ---- Panel CAD
await t("Panel CAD", [{ name: "g.cad", bytes: enc("###Panel Added\nCOMP U1 1 0 0 1.0 1.0 1 0\nCOMP R2 2 0 0 1.5 1.0 2 0\nC_PIN U1-1 1.0 1.0 0 0 0 0 /PP5V\nC_PIN U1-2 1.1 1.0 0 0 0 0 GND\nC_PIN R2-1 1.5 1.0 0 0 0 0 /PP5V\n") }], {}, (b) => ok(pinOf(b, "U1", "1").net === "PP5V", "cad net slash"));
// ---- GenCAD
await t("GenCAD", [{ name: "h.cad", bytes: enc(`$HEADER\nGENCAD 1.4\nUNITS MM\n$ENDHEADER\n$BOARD\nLINE 0 0 100 0\nLINE 100 0 100 50\nLINE 100 50 0 50\nLINE 0 50 0 0\n$ENDBOARD\n$PADSTACKS\nPADSTACK PS1 0\nPAD P1 TOP 0 0\nPADSTACK TH1 0.8\nPAD P2 ALL 0 0\n$ENDPADSTACKS\n$SHAPES\nSHAPE R0402\nINSERT SMD\nPIN 1 PS1 -0.5 0 TOP 0 0\nPIN 2 PS1 0.5 0 TOP 0 0\nSHAPE HDR\nINSERT TH\nPIN 1 TH1 0 0 TOP 0 0\n$ENDSHAPES\n$COMPONENTS\nCOMPONENT R10\nPLACE 10 10\nLAYER TOP\nROTATION 90\nSHAPE R0402 0 0\nDEVICE RES_10K\nCOMPONENT "J 1"\nPLACE 50 25\nLAYER BOTTOM\nROTATION 0\nSHAPE HDR MIRRORX FLIP\n$ENDCOMPONENTS\n$DEVICES\nDEVICE RES_10K\nVALUE 10K\n$ENDDEVICES\n$SIGNALS\nSIGNAL PP3V3_S0\nNODE R10 1\nNODE "J 1" 1\nSIGNAL GND\nNODE R10 2\n$ENDSIGNALS\n`) }], {}, (b) => {
  const p = pinOf(b, "R10", "1"); ok(Math.abs(p.x - 10 / 0.0254) < 0.5 && Math.abs(p.y - (10 - 0.5) / 0.0254) < 0.5, "gencad rotation " + p.x + "," + p.y);
  ok(b.parts.find((x) => x.name === "J 1").side === "BOTH", "gencad TH both"); ok(b.parts[0].desc.includes("10K"), "gencad device value"); ok(b.outline.length === 1, "gencad outline");
});
// ---- Altium ASCII
await t("Altium ASCII", [{ name: "i.pcbdoc", bytes: enc("|RECORD=Board|KIND=Protel_Advanced_PCB|VERSION=5.0\n|RECORD=Component|ID=0|LAYER=TOP|X=1000mil|Y=1000mil|ROTATION=0|SOURCEDESIGNATOR=U3|SOURCEDESCRIPTION=Buck\n|RECORD=Pad|INDEXFORSAVE=0|LAYER=TOP|NET=1|COMPONENT=0|NAME=1|X=1000mil|Y=1000mil|XSIZE=20mil|YSIZE=30mil\n|RECORD=Pad|INDEXFORSAVE=1|LAYER=TOP|NET=0|COMPONENT=0|NAME=2|X=1050mil|Y=1000mil|XSIZE=20mil|YSIZE=30mil\n|RECORD=Net|ID=0|NAME=GND\n|RECORD=Net|ID=1|NAME=VBUS\n|RECORD=Track|LAYER=KEEPOUT|X1=0mil|Y1=0mil|X2=2000mil|Y2=0mil\n") }], {}, (b) => { ok(pinOf(b, "U3", "1").net === "VBUS", "altium late net"); ok(pinOf(b, "U3", "1").r === 10, "altium radius"); });
// ---- KiCad
await t("KiCad", [{ name: "j.kicad_pcb", bytes: enc(`(kicad_pcb (version 20240108)\n (net 0 "")\n (net 1 "+3V3")\n (net 2 "GND")\n (footprint "R_0402" (layer "F.Cu") (at 100 50 90)\n  (property "Reference" "R7") (property "Value" "4.7k")\n  (pad "1" smd roundrect (at -0.5 0 90) (size 0.6 0.5) (layers "F.Cu") (net 1 "+3V3"))\n  (pad "2" smd roundrect (at 0.5 0 90) (size 0.6 0.5) (layers "F.Cu") (net 2 "GND")))\n (footprint "C_0402" (layer "B.Cu") (at 110 50)\n  (fp_text reference "C3" (at 0 0)) (pad "1" smd rect (at -0.5 0) (size 0.6 0.5) (net 1 "+3V3")) (pad "2" smd rect (at 0.5 0) (size 0.6 0.5) (net 2 "GND")))\n (gr_rect (start 90 40) (end 130 70) (layer "Edge.Cuts"))\n)`) }], {}, (b) => {
  const p = pinOf(b, "R7", "1"); ok(Math.abs(p.x - 100 / 0.0254) < 0.5 && Math.abs(p.y - -(50 + 0.5) / 0.0254) < 0.5, "kicad rotation " + p.x + "," + p.y);
  ok(b.parts[1].side === "B", "kicad bottom"); ok(b.outline.length === 1, "kicad outline");
});
// ---- IPC-356
{
  const L = ["P  JOB   TEST", "P  UNITS CUST 0", "P  NNAME1 VERY_LONG_NET_NAME_PP1V8"];
  const rec = (code, net, ref, pin, acc, x, y) => (code + net.padEnd(14) + "   " + ref.padEnd(6) + "-" + pin.padEnd(4) + "M" + "      " + "   A" + acc + "X" + (x < 0 ? "-" : "+") + String(Math.abs(x)).padStart(6, "0") + "Y" + (y < 0 ? "-" : "+") + String(Math.abs(y)).padStart(6, "0"));
  L.push(rec("327", "NNAME1", "U1", "1", "01", 10000, 20000), rec("327", "GND", "U1", "2", "01", 10500, 20000), rec("327", "NNAME1", "C5", "1", "02", 30000, 20000), rec("317", "GND", "J2", "1", "00", 50000, 5000), "999");
  await t("IPC-356", [{ name: "k.ipc", bytes: enc(L.join("\n")) }], {}, (b) => { ok(pinOf(b, "U1", "1").net === "VERY_LONG_NET_NAME_PP1V8", "ipc alias"); ok(pinOf(b, "U1", "1").x === 1000, "ipc units"); ok(b.parts.find((p) => p.name === "C5").side === "B", "ipc bottom"); });
}
// ---- CST (synthetic binary)
{
  const bytes = []; const s16 = (v) => bytes.push(v & 0xff, (v >> 8) & 0xff); const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
  s16(2); bytes.push(0, 0, 0, 0); s16(5); str("CComp");
  bytes.push(2); str("U1"); bytes.push(0, 0, 0, 0); bytes.push(0x0c); bytes.push(0, 0, 0, 0, 0, 0);
  bytes.push(2); str("R1"); bytes.push(0, 0, 0, 0); bytes.push(0x01); bytes.push(0, 0, 0, 0); s16(2); // last 2 of the 6 = net count
  bytes.push(3); str("VCC"); bytes.push(3); str("GND");
  bytes.push(0, 0); s16(3); bytes.push(0, 0, 0, 0); str("CPad"); bytes.push(0, 0); // CPad at q; num_pins at q-8
  // fix: num_pins must sit at q-8: rebuild tail precisely
  const q = bytes.length - 6; const npos = q - 8; bytes[npos] = 3; bytes[npos + 1] = 0;
  while (bytes.length < q + 4 + 0) bytes.push(0);
  // pins start at q+4
  bytes.length = q + 4;
  const pin = (pid, net, x, y) => { s16(pid); s16(0); s16(net); s16(x); s16(y); s16(0); bytes.push(0, 0, 0, 0); };
  pin(0, 0, 100, 100); pin(0, 1, 140, 100); pin(1, 0, 400, 400);
  await t("CST", [{ name: "l.cst", bytes: Uint8Array.from(bytes) }], {}, (b) => { ok(pinOf(b, "U1", "1") && pinOf(b, "U1", "1").net === "VCC", "cst net"); ok(b.parts.find((p) => p.name === "R1").side === "B", "cst side"); });
}
// ---- FZ (plain zlib and RC6)
const fzContent = "UNIT:mils\nA!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!\nS!PU1!IC!QFN!NO!0!\nS!PC3!C!C0402!YES!0!\nA!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!\nS!+VCCIO!PU1!1!VIN!1000,5!2000!!8!\nS!GND!PU1!2!GND!1040!2000!!8!\nS!+VCCIO!PC3!1!1!3000!3000!!8!\nS!GND!PC3!2!2!3040!3000!!8!\n";
const fzDescr = "board\nPARTNUMBER\tDESCRIPTION\tQTY\tLOCATION\tPN2\n02G0123\tIC PWM RT8231\t1\tPU1\tx\n";
function buildFZ() {
  const zc = zlib.deflateSync(Buffer.from(fzContent, "latin1")), zd = zlib.deflateSync(Buffer.from(fzDescr, "latin1"));
  const N = 4 + zc.length + zd.length + 4; const b = new Uint8Array(N); b.set(zc, 4); b.set(zd, 4 + zc.length);
  const L = zd.length + 8; b[N - 4] = L & 0xff; b[N - 3] = (L >> 8) & 0xff; b[N - 2] = (L >> 16) & 0xff; b[N - 1] = (L >>> 24) & 0xff; return b;
}
await t("FZ plain", [{ name: "m.fz", bytes: buildFZ() }], {}, (b) => { ok(pinOf(b, "PU1", "1").x === 1000.5, "fz comma decimal"); ok(b.parts.find((p) => p.name === "PC3").side === "B", "fz mirror"); ok(b.parts[0].desc.includes("RT8231"), "fz descr"); });
{
  const PAR = [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
  const key = PAR.map((want, i) => { let w = (Math.random() * 2 ** 32) >>> 0; let f = w; f ^= f >>> 16; f ^= f >>> 8; f ^= f >>> 4; f ^= f >>> 2; f ^= f >>> 1; if (((~f) & 1) !== want) w = (w ^ 1) >>> 0; return w; });
  ok(checkRC6Key(key, PAR), "generated fz key parity");
  let b = buildFZ(); rc6Stream(b, key, true);
  const ks = key.map((w) => "0x" + w.toString(16).padStart(8, "0")).join(", ");
  await t("FZ RC6", [{ name: "n.fz", bytes: b.slice() }], { fz: ks }, (bb) => ok(bb.pins.length === 4, "fz rc6 pins"));
  try { await parseBoardFiles([{ name: "n.fz", bytes: b.slice() }], {}); fails++; console.log("  FAIL no-key should throw"); } catch (e) { console.log("FZ no key          ->", e.message.slice(0, 60)); }
}
// ---- XZZ (header xor + DES part blocks)
{
  const keyBytes = [0xa1, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef];
  const fixParity = (v, odd) => { let t = v; t ^= t >> 4; t ^= t >> 2; t ^= t >> 1; const even = !(t & 1); if (odd ? even : !even) v ^= 1; return v; };
  for (let i = 0; i < 8; i++) keyBytes[7 - i] = fixParity(keyBytes[7 - i], i === 7);
  ok(checkXZZKey(Uint8Array.from(keyBytes)), "xzz key parity");
  const sched = desSchedule(Uint8Array.from(keyBytes));
  const u32 = (a, v) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const S = 10000;
  // part plaintext
  const part = []; u32(part, 0); for (let i = 0; i < 18; i++) part.push(0); u32(part, 0); part.push(0x06); for (let i = 0; i < 30; i++) part.push(0);
  u32(part, 3); for (const c of "U12") part.push(c.charCodeAt(0));
  const addPin = (name, x, y, net) => { part.push(0x09); const body = []; u32(body, 0); u32(body, x * S); u32(body, y * S); for (let i = 0; i < 8; i++) body.push(0); u32(body, name.length); for (const c of name) body.push(c.charCodeAt(0)); for (let i = 0; i < 32; i++) body.push(0); u32(body, net); u32(part, body.length); part.push(...body); };
  addPin("1", 100, 200, 1); addPin("2", 140, 200, 2);
  const psize = part.length - 4; part[0] = psize & 0xff; part[1] = (psize >> 8) & 0xff;
  while (part.length % 8) part.push(0);
  const encPart = new Uint8Array(part.length); for (let o = 0; o < part.length; o += 8) desBlock(Uint8Array.from(part), o, encPart, o, sched, false);
  const blocks = [];
  const seg = (x1, y1, x2, y2) => { blocks.push(5); const b = []; u32(b, 28); u32(b, x1 * S); u32(b, y1 * S); u32(b, x2 * S); u32(b, y2 * S); u32(b, S); u32(b, 0); u32(blocks, b.length); blocks.push(...b); };
  seg(50, 50, 1050, 50); seg(1050, 50, 1050, 550); seg(1050, 550, 50, 550); seg(50, 550, 50, 50);
  blocks.push(7); u32(blocks, encPart.length); blocks.push(...encPart);
  const nets = []; const net = (i, n) => { u32(nets, 8 + n.length); u32(nets, i); for (const c of n) nets.push(c.charCodeAt(0)); }; net(1, "PP1V05"); net(2, "GND");
  const file = []; for (const c of "XZZPCB") file.push(c.charCodeAt(0)); while (file.length < 0x40) file.push(0);
  const mainStart = 0x40; const mainOff = mainStart - 0x20; const netStart = mainStart + 4 + blocks.length; const netOff = netStart - 0x20;
  file[0x20] = mainOff; file[0x28] = netOff & 0xff; file[0x29] = (netOff >> 8) & 0xff;
  u32(file, blocks.length); file.push(...blocks); u32(file, nets.length); file.push(...nets);
  const kx = keyBytes.map((v) => v.toString(16).padStart(2, "0")).join("");
  await t("XZZ", [{ name: "o.pcb", bytes: Uint8Array.from(file) }], { xzz: kx }, (b) => { const p = pinOf(b, "U12", "1"); ok(p && p.net === "PP1V05" && p.x === 50, "xzz pin + translate"); ok(b.outline.length === 1, "xzz outline"); });
  const xf = Uint8Array.from(file).map((v) => v ^ 0x5a); // header xor variant (byte 0x10 was 0, becomes the key)
  await t("XZZ xor", [{ name: "p.pcb", bytes: xf }], { xzz: kx }, (b) => ok(b.pins.length === 2, "xzz xor"));
}
// ---- Allegro extract text
await t("Allegro extract", [{ name: "q.txt", bytes: enc("A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!SYM_MIRROR!\nS!VCC!U1!1!VIN!100!100!NO!\nS!GND!U1!2!GND!140!100!NO!\nS!VCC!C2!1!1!500!500!YES!\n") }], {}, (b) => ok(b.parts.find((p) => p.name === "C2").side === "B", "extract mirror"));
// ---- CSV
await t("CSV", [{ name: "r.csv", bytes: enc("part,pin,net,x,y,side,value\nU1,1,VCC,0,0,top,MCU\nR1,1,VCC,50,0,bottom,10k\n") }], {}, (b) => ok(b.parts[1].desc === "10k", "csv value"));
// ---- Allegro binary rejection
{ const b = new Uint8Array(400); b.set(enc("allegro"), 0xf8); try { await parseBoardFiles([{ name: "x.brd", bytes: b }]); fails++; } catch (e) { console.log("Allegro binary     ->", e.message.slice(0, 60)); } }

console.log(fails ? `\n${fails} FAILURE(S)` : "\nALL PARSER TESTS PASSED");
process.exit(fails ? 1 : 0);
