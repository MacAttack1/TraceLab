// Trace Lab boardview parsers.
// Every parser returns a common model in mils (0.001"):
//   { format, outline:[[[x,y],...], ...] (polygons), segments:[[x1,y1,x2,y2]...] (fallback),
//     parts:[{name, side:'T'|'B'|'BOTH', desc?}], pins:[{x,y,part,net,num,name?,r?,side?}],
//     copper (design-tool formats only: KiCad, Eagle, Altium ASCII, GenCAD, XZZ line layers):
//     layers:[{id,name,side:'T'|'B'|'I'}] top→bottom, traces:[{x1,y1,x2,y2,w,layer,net}],
//     vias:[{x,y,r,net}], zones:[{layer,net,poly:[[x,y]…]}] }
// Repair boardview formats (BRD, BDV, FZ, CAE, ASC, BVR, CST, IPC-D-356…) carry no copper routing.
// Logic for the repair-tool formats follows the OpenBoardView reference implementations (MIT).

export const FORMATS = [
  ["Test_Link / Landrex BRD (plain + encoded)", ".brd"],
  ["BRDOUT boardview", ".brd"],
  ["Honhan BDV", ".bdv"],
  ["ASUS TSICT ASC (format/pins/nails.asc)", ".asc"],
  ["ASUS FZ (zlib or RC6, key for encrypted)", ".fz"],
  ["CAE (RC6, needs key)", ".cae"],
  ["XZZ / XinZhiZao PCB (DES, needs key)", ".pcb"],
  ["Boardview Raw BVR v1 / v3", ".bvr .bvr3"],
  ["GenCAD 1.4", ".cad"],
  ["Samsung / panel CAD (C_PIN)", ".cad"],
  ["Castw CST", ".cst"],
  ["Altium ASCII PCB", ".pcbdoc"],
  ["KiCad board", ".kicad_pcb"],
  ["Eagle XML board", ".brd"],
  ["IPC-D-356 netlist", ".ipc .356 .net"],
  ["Allegro / Fabmaster text extract (A!/S!)", ".txt .fab"],
  ["CSV pin list", ".csv .tsv"],
];

const latin1 = new TextDecoder("latin1");
const td8 = (u8) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); } catch (e) { return latin1.decode(u8); } };
const has = (s, k) => s.indexOf(k) >= 0;
const extOf = (n) => (n.match(/\.[^.]+$/) || [""])[0].toLowerCase();
const lines = (t) => t.split(/\r\n|\r|\n/);
const num = (s) => { const v = parseFloat(String(s).replace(",", ".")); return isFinite(v) ? v : NaN; };

export class NeedKeyError extends Error { constructor(kind, msg) { super(msg); this.kind = kind; } }

/* ============================================================ entry */
export async function parseBoardFiles(files, keys = {}) {
  // files: [{name, bytes:Uint8Array}]
  const ascSet = files.filter((f) => /\.(asc|bom)$/i.test(f.name));
  if (ascSet.length) return finish(parseASC(ascSet), ascSet[0].name, "ASUS TSICT ASC");
  const f = files[0];
  const u8 = f.bytes, name = f.name, ext = extOf(name);
  if (u8.length < 8) throw new Error("This file is empty or too short to be a boardview.");
  const head = latin1.decode(u8.subarray(0, Math.min(u8.length, 1 << 20)));
  const all = () => latin1.decode(u8);

  if (ext === ".fz") return finish(await parseFZ(u8, keys.fz, FZ_PARITY, "FZ", parseKeyWords(keys.fzBuiltin || "")), name, "ASUS FZ");
  if (ext === ".cae") return finish(await parseFZ(u8, keys.cae, CAE_PARITY, "CAE", parseKeyWords(keys.caeBuiltin || "")), name, "CAE");
  if (has(head, "GENCAD") && has(head, "$HEADER")) return finish(parseGenCAD(td8(u8)), name, "GenCAD");
  if (has(head, "|KIND=Protel_Advanced_PCB")) {
    if (has(head, "Binary")) throw new Error("This is a binary Altium PCB. Export it from Altium as ASCII (.PcbDoc ASCII) and open that.");
    return finish(parseAltium(td8(u8)), name, "Altium ASCII");
  }
  if (has(head, "###Panel Added") && has(all(), "C_PIN")) return finish(parseCAD(all()), name, "Panel CAD");
  if (ext === ".cst") return finish(parseCST(u8), name, "Castw CST");
  if ((u8[0] === 0x23 && u8[1] === 0xe2 && u8[2] === 0x63 && u8[3] === 0x28) || (has(head, "str_length:") && has(head, "var_data:")))
    return finish(parseBRD(u8), name, "Test_Link BRD");
  if (has(head, "BRDOUT:") && has(head, "NETS:")) return finish(parseBRD2(all()), name, "BRDOUT");
  if (has(head, "dd:1.3?,r?-=bb") || (has(head, "<<format.asc>>") && has(head, "<<pins.asc>>")) || ext === ".bdv" || has(decodeBDV(u8.subarray(0, 65536)), "<<pins.asc>>"))
    return finish(parseBDV(u8), name, "Honhan BDV");
  if (has(head, "BVRAW_FORMAT_1")) return finish(parseBVR1(all()), name, "BVR v1");
  if (has(head, "BVRAW_FORMAT_3")) return finish(parseBVR3(all()), name, "BVR v3");
  if (isXZZ(u8)) return finish(parseXZZ(u8, keys.xzz), name, "XZZ PCB");
  if (/^\s*\(kicad_pcb/.test(head)) return finish(parseKiCad(td8(u8)), name, "KiCad");
  if (has(head, "<eagle") && has(head, "<board")) return finish(parseEagle(td8(u8)), name, "Eagle");
  if (/^(317|327|367)/m.test(head) && (/^P\s+(JOB|UNITS|CODE)/m.test(head) || /\.(ipc|356|net|d356)$/i.test(name))) return finish(parseIPC356(all()), name, "IPC-D-356");
  if (/^A!(NET_NAME|REFDES)!/m.test(head)) return finish(parseFabText(td8(u8), ""), name, "Allegro extract");
  if (isAllegroBinary(u8)) throw new Error("This is a Cadence Allegro binary .brd. Its layout is proprietary; open it in Allegro Free Physical Viewer and export GenCAD or an extract, then open that here.");
  if (ext === ".tvw") throw new Error("TeboView .tvw is a closed format with no public specification, so Trace Lab can't read it yet. Export the board to GenCAD (.cad) from TeboView if you have it.");
  if (/\.(csv|tsv)$/i.test(name) || /^[^\n]*\b(net|signal)\b[^\n]*[,;\t]/i.test(head)) return finish(parseCSV(td8(u8)), name, "CSV");
  throw new Error("Trace Lab doesn't recognise this file. Supported extensions: " + [...new Set(FORMATS.flatMap((x) => x[1].split(" ")))].join(" ") + ".");
}

/* ============================================================ common post-process */
const NC_RE = /^(NC|N\/C|N_C|UNCONNECTED|NONE|NO_NET|NET_NC|NC@\d+|\(NC\))$/i;
function finish(m, fname, format) {
  const pins = m.pins.filter((p) => p.part >= 0 && p.part < m.parts.length && isFinite(p.x) && isFinite(p.y));
  if (!pins.length) throw new Error("No pins found in this " + format + " file. It may be a variant Trace Lab doesn't decode yet.");
  const parts = m.parts.map((p) => ({ name: String(p.name || "?"), side: p.side || "T", desc: p.desc || "", pins: [] }));
  pins.forEach((p, i) => {
    p.net = String(p.net || "").trim();
    if (NC_RE.test(p.net)) p.net = "";
    const pt = parts[p.part]; pt.pins.push(i);
    if (p.num === undefined || p.num === null || p.num === "") p.num = p.name || String(pt.pins.length);
    p.num = String(p.num);
  });
  // drop empty parts but keep indices consistent
  const keep = parts.map((p) => p.pins.length > 0);
  const remap = []; const outParts = [];
  parts.forEach((p, i) => { if (keep[i]) { remap[i] = outParts.length; outParts.push(p); } });
  pins.forEach((p) => { p.part = remap[p.part]; });
  outParts.forEach((p) => (p.pins = []));
  pins.forEach((p, i) => outParts[p.part].pins.push(i));
  let outline = (m.outline || []).filter((poly) => poly && poly.length > 2);
  if (!outline.length && m.segments && m.segments.length) outline = chainSegments(m.segments);
  const out = { name: fname, format, parts: outParts, pins, outline, desc: m.desc || "" };
  if (m.holes && m.holes.length) out.holes = m.holes.filter((h) => isFinite(h.x) && isFinite(h.y) && h.r > 0);
  if (m.traces && m.traces.length) {
    const clean = (n) => { n = String(n || "").trim(); return NC_RE.test(n) ? "" : n; };
    out.traces = m.traces.filter((t) => isFinite(t.x1) && isFinite(t.y1) && isFinite(t.x2) && isFinite(t.y2)).map((t) => ({ ...t, net: clean(t.net) }));
    out.vias = (m.vias || []).filter((v) => isFinite(v.x) && isFinite(v.y)).map((v) => ({ ...v, net: clean(v.net) }));
    out.zones = (m.zones || []).filter((z) => z.poly && z.poly.length > 2).map((z) => ({ ...z, net: clean(z.net) }));
    const used = new Set([...out.traces.map((t) => t.layer), ...out.zones.map((z) => z.layer)]);
    out.layers = (m.layers || []).filter((l) => used.has(l.id));
    for (const id of used) if (!out.layers.some((l) => l.id === id)) out.layers.push({ id, name: String(id), side: "I" });
  }
  return out;
}

export function chainSegments(segs) {
  const key = (x, y) => Math.round(x) + "," + Math.round(y);
  const rest = segs.map((s) => s.slice());
  const polys = [];
  while (rest.length) {
    const s = rest.pop();
    const poly = [[s[0], s[1]], [s[2], s[3]]];
    let end = [s[2], s[3]], guard = 0;
    while (rest.length && guard++ < 200000) {
      let bi = -1, bd = Infinity, rev = false;
      for (let i = 0; i < rest.length; i++) {
        const r = rest[i];
        const d1 = Math.abs(r[0] - end[0]) + Math.abs(r[1] - end[1]);
        const d2 = Math.abs(r[2] - end[0]) + Math.abs(r[3] - end[1]);
        if (d1 < bd) { bd = d1; bi = i; rev = false; }
        if (d2 < bd) { bd = d2; bi = i; rev = true; }
        if (bd === 0) break;
      }
      const startD = Math.abs(poly[0][0] - end[0]) + Math.abs(poly[0][1] - end[1]);
      if (bi < 0 || (bd > 0 && startD <= bd) || bd > 400) break;
      const r = rest.splice(bi, 1)[0];
      end = rev ? [r[0], r[1]] : [r[2], r[3]];
      poly.push(end);
    }
    if (poly.length > 2) polys.push(poly);
  }
  polys.sort((a, b) => bboxArea(b) - bboxArea(a));
  return polys.slice(0, 40);
}
function bboxArea(p) { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; p.forEach(([x, y]) => { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }); return (c - a) * (d - b); }
// Arc through three points (start, mid, end) as short segments.
function arc3(a, m, b, steps = 12) {
  const [x1, y1] = a, [x2, y2] = m, [x3, y3] = b; const d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
  if (Math.abs(d) < 1e-9) return [[x1, y1, x3, y3]];
  const ux = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / d;
  const uy = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / d;
  const r = Math.hypot(x1 - ux, y1 - uy); let a0 = Math.atan2(y1 - uy, x1 - ux), am = Math.atan2(y2 - uy, x2 - ux), a1 = Math.atan2(y3 - uy, x3 - ux);
  const norm = (v) => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let s1 = norm(a1 - a0); const sm = norm(am - a0); if (sm > s1) s1 -= 2 * Math.PI; // go the way that passes the mid point
  return arcSegs(ux, uy, r, a0, a0 + s1, steps);
}
function arcSegs(cx, cy, r, a0, a1, steps = 16) {
  const out = []; let px = cx + r * Math.cos(a0), py = cy + r * Math.sin(a0);
  for (let i = 1; i <= steps; i++) { const a = a0 + (a1 - a0) * i / steps; const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a); out.push([px, py, x, y]); px = x; py = y; }
  return out;
}

/* ============================================================ Test_Link BRD */
function parseBRD(u8) {
  let b = u8;
  if (u8[0] === 0x23 && u8[1] === 0xe2 && u8[2] === 0x63 && u8[3] === 0x28) {
    b = u8.slice();
    for (let i = 0; i < b.length; i++) { const x = b[i]; if (x === 13 || x === 10 || x === 0) continue; b[i] = (~(((x >> 6) & 3) | (x << 2))) & 0xff; }
  }
  const t = latin1.decode(b);
  const outline = [], parts = [], pins = [], nails = new Map(); let blk = 0;
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    if (l === "str_length:" || l === "var_data:") { blk = 0; continue; }
    if (/^format:$/i.test(l)) { blk = 1; continue; }
    if (l === "Parts:" || l === "Pins1:") { blk = 2; continue; }
    if (l === "Pins:" || l === "Pins2:") { blk = 3; continue; }
    if (l === "Nails:") { blk = 4; continue; }
    const k = l.split(/\s+/);
    if (blk === 1 && k.length >= 2) outline.push([+k[0], +k[1]]);
    else if (blk === 2 && k.length >= 2) { const ty = +k[1]; parts.push({ name: k[0], side: (ty === 1 || (ty >= 4 && ty < 8)) ? "T" : (ty === 2 || ty >= 8) ? "B" : "BOTH", end: +k[2] || 0 }); }
    else if (blk === 3 && k.length >= 4) pins.push({ x: +k[0], y: +k[1], probe: +k[2], part: (+k[3]) - 1, net: k[4] || "" });
    else if (blk === 4 && k.length >= 5) nails.set(+k[0], k[4]);
  }
  const valid = pins.filter((p) => p.part >= 0 && p.part < parts.length).length;
  if (valid < pins.length * 0.9) { let k = 0; parts.forEach((pt, pi) => { while (k < pt.end && k < pins.length) { pins[k].part = pi; k++; } }); }
  pins.forEach((p) => { if (!p.net && nails.has(p.probe)) p.net = nails.get(p.probe); });
  return { outline: [outline], parts, pins };
}

/* ============================================================ BRDOUT */
function parseBRD2(t) {
  const outline = [], nets = new Map(), parts = [], pins = [], nails = []; let sec = "", maxY = 0;
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    const h = l.match(/^(BRDOUT|NETS|PARTS|PINS|NAILS):\s*(.*)$/i);
    if (h) { sec = h[1].toUpperCase(); if (sec === "BRDOUT") { const k = h[2].split(/\s+/); maxY = +k[2] || 0; } continue; }
    const k = l.split(/\s+/);
    if (sec === "BRDOUT" && k.length >= 2) outline.push([+k[0], +k[1]]);
    else if (sec === "NETS" && k.length >= 2) nets.set(+k[0], k[1]);
    else if (sec === "PARTS" && k.length >= 7) parts.push({ name: k[0], first: +k[5], side: +k[6] === 1 ? "T" : +k[6] === 2 ? "B" : "BOTH" });
    else if (sec === "PINS" && k.length >= 3) pins.push({ x: +k[0], y: +k[1], net: nets.get(+k[2]) || "", pside: +k[3] || 0, part: -1 });
    else if (sec === "NAILS" && k.length >= 5) nails.push({ probe: +k[0], x: +k[1], y: +k[2], net: nets.get(+k[3]) || "", top: +k[4] === 1 });
  }
  pins.forEach((p) => { if (!p.net) p.net = ""; });
  const base = parts.length && parts[0].first === 1 ? 1 : 0; // files differ on 0- vs 1-based first-pin indices
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i].first - base, e = i + 1 < parts.length ? parts[i + 1].first - base : pins.length;
    let dip = true;
    for (let k = s; k < e && k < pins.length; k++) {
      if (k < 0) continue; const p = pins[k]; p.part = i;
      if (p.pside !== 1) p.y = maxY - p.y;
      if ((p.pside === 1 && parts[i].side === "T") || (p.pside === 2 && parts[i].side === "B")) dip = false;
    }
    if (dip) parts[i].side = "BOTH";
  }
  // nails become 1-pin test points
  nails.forEach((n) => { parts.push({ name: "TP" + n.probe, side: n.top ? "T" : "B", nail: true }); pins.push({ x: n.x, y: n.top ? n.y : maxY - n.y, part: parts.length - 1, net: n.net, num: "1" }); });
  return { outline: [outline], parts, pins };
}

/* ============================================================ BDV / ASC / BVR1 (shared row parser) */
function decodeBDV(u8) {
  const b = u8.slice(); let count = 0xa0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10) count++;
    const x = b[i];
    if (!(x === 13 || x === 10 || x === 0)) b[i] = (count - x) & 0xff;
    if (count > 285) count = 159;
  }
  return latin1.decode(b);
}
const PIN_ROW = /^(\d+)\s+(.+?)\s+([-+]?[\d.]+(?:e[-+]?\d+)?)\s+([-+]?[\d.]+(?:e[-+]?\d+)?)\s+(\d+)\s+(\S+)(?:\s+(-?\d+))?\s*$/i;
function parseAscLike(t) {
  const outline = [], parts = [], pins = []; let blk = 0;
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    if (/^<<format\.asc>>$/i.test(l)) { blk = 1; continue; }
    if (/^<<pins\.asc>>$/i.test(l)) { blk = 2; continue; }
    if (/^<<nails\.asc>>$/i.test(l)) { blk = 3; continue; }
    if (/^<<.*>>$/.test(l)) { blk = 0; continue; }
    if (blk === 1) { const m = l.match(/^([-+]?[\d.]+)[\s,]+([-+]?[\d.]+)/); if (m) outline.push([+m[1] * 1000, +m[2] * 1000]); }
    else if (blk === 2) {
      const pm = l.match(/^Part\s+(\S+)\s+\((\w)\)/i);
      if (pm) { parts.push({ name: pm[1], side: pm[2].toUpperCase() === "T" ? "T" : "B" }); continue; }
      const m = l.match(PIN_ROW); if (!m || !parts.length) continue;
      pins.push({ part: parts.length - 1, num: m[2].trim(), x: +m[3] * 1000, y: +m[4] * 1000, net: m[6] });
    }
  }
  return { outline: [outline], parts, pins };
}
function parseBDV(u8) {
  const raw = latin1.decode(u8.subarray(0, 4096));
  const t = has(raw, "<<pins.asc>>") ? latin1.decode(u8) : decodeBDV(u8);
  return parseAscLike(t);
}
function parseASC(files) {
  const by = (n) => files.find((f) => f.name.toLowerCase().replace(/^.*[\\/]/, "") === n);
  const fmt = by("format.asc"), pins = by("pins.asc");
  if (!pins) {
    // a single combined file
    const t = latin1.decode(files[0].bytes);
    if (has(t, "<<pins.asc>>")) return parseAscLike(t);
    throw new Error("ASC boardviews are a set of files. Select format.asc, pins.asc and nails.asc together (Ctrl-click) and open them at once.");
  }
  let t = "";
  if (fmt) t += "<<format.asc>>\n" + latin1.decode(fmt.bytes) + "\n";
  t += "<<pins.asc>>\n" + latin1.decode(pins.bytes) + "\n";
  return parseAscLike(t);
}
function parseBVR1(t) {
  const outline = [], parts = [], pins = []; let blk = 0, prev = null;
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    if (l === "<<Layout>>") { blk = 1; continue; }
    if (l === "<<Pin>>") { blk = 2; continue; }
    if (l === "<<Nail>>") { blk = 3; continue; }
    if (blk === 1) { const m = l.match(/^([-+]?[\d.]+)[\s,]+([-+]?[\d.]+)/); if (m) outline.push([Math.trunc(+m[1] * 1000), Math.trunc(+m[2] * 1000)]); }
    else if (blk === 2) {
      const m = l.match(/^(\S+)\s+\((\w)\)\s+(\d+)\s+(\S+)\s+([-+]?[\d.]+)\s+([-+]?[\d.]+)\s+(\d+)\s+(\S+)/); if (!m) continue;
      if (m[1] !== prev) { parts.push({ name: m[1], side: m[2].toUpperCase() === "T" ? "T" : "B" }); prev = m[1]; }
      pins.push({ part: parts.length - 1, num: m[4], x: Math.trunc(+m[5] * 1000), y: Math.trunc(+m[6] * 1000), net: m[8] });
    }
  }
  return { outline: [outline], parts, pins };
}

/* ============================================================ BVR3 */
function parseBVR3(t) {
  const parts = [], pins = [], outline = [], segs = [];
  let part = null, pin = null;
  const S = (v) => (v === "T" ? "T" : v === "B" ? "B" : "BOTH");
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    const sp = l.indexOf(" "); const key = sp < 0 ? l : l.slice(0, sp), val = sp < 0 ? "" : l.slice(sp + 1).trim();
    switch (key) {
      case "PART_NAME": part = { name: val.split(/\s+/)[0], side: "T", ox: 0, oy: 0, mount: "SMD" }; break;
      case "PART_SIDE": if (part) part.side = S(val); break;
      case "PART_ORIGIN": if (part) { const k = val.split(/\s+/); part.ox = Math.trunc(+k[0]); part.oy = Math.trunc(+k[1]); } break;
      case "PART_MOUNT": if (part) part.mount = val; break;
      case "PIN_NUMBER": pin = pin || {}; pin.num = val; break;
      case "PIN_NAME": pin = pin || {}; pin.name = val; break;
      case "PIN_SIDE": pin = pin || {}; pin.side = S(val); break;
      case "PIN_ORIGIN": { pin = pin || {}; const k = val.split(/\s+/); pin.x = Math.trunc(+k[0]) + (part ? part.ox : 0); pin.y = Math.trunc(+k[1]) + (part ? part.oy : 0); break; }
      case "PIN_RADIUS": pin = pin || {}; pin.r = +val; break;
      case "PIN_NET": pin = pin || {}; pin.net = val; break;
      case "PIN_END": if (pin) { pin.part = parts.length; pins.push(pin); } pin = null; break;
      case "PART_END": if (part) { if (part.mount !== "SMD" && part.side !== "BOTH") part.side = "BOTH"; parts.push(part); } part = null; break;
      case "OUTLINE_POINTS": { const k = val.split(/\s+/).map(Number); for (let i = 0; i + 1 < k.length; i += 2) outline.push([Math.trunc(k[i]), Math.trunc(k[i + 1])]); break; }
      case "OUTLINE_SEGMENTED": { const k = val.split(/\s+/).map(Number); for (let i = 0; i + 3 < k.length; i += 4) segs.push([k[i], k[i + 1], k[i + 2], k[i + 3]]); break; }
    }
  }
  return { outline: outline.length > 2 ? [outline] : [], segments: segs, parts, pins };
}

/* ============================================================ Panel CAD (###Panel Added / C_PIN) */
function parseCAD(t) {
  const parts = [], pins = [], ids = new Map();
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    const k = l.split(/\s+/);
    if (/^COMP/.test(l) && k.length >= 8) { parts.push({ name: k[1], side: k[7] === "1" ? "T" : "B" }); ids.set(k[1], parts.length - 1); }
    else if (/^C_PIN/.test(l) && k.length >= 9) {
      const pn = k[1].split("-")[0]; const pi = ids.get(pn); if (pi === undefined) continue;
      let net = k[8] || ""; if (net.includes("/")) net = net.slice(1);
      pins.push({ part: pi, num: k[1].split("-").slice(1).join("-") || "", x: num(k[2]) * 1000, y: num(k[3]) * 1000, net });
    }
  }
  return { parts, pins };
}

/* ============================================================ Castw CST (binary) */
function parseCST(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let p = 0;
  const rs = () => { const v = dv.getInt16(p, true); p += 2; return v; };
  const rb = () => u8[p++];
  const str = (n) => { const s = latin1.decode(u8.subarray(p, p + n)); p += n; return s; };
  const nParts = rs(); p += 4; const sl = rs(); str(sl);
  const parts = [];
  for (let i = 0; i < nParts; i++) {
    const n = rb(); const name = str(n); p += 4; const layer = rb();
    parts.push({ name, side: layer === 0x0c ? "T" : layer === 0x01 ? "B" : "BOTH" }); p += 6;
  }
  p -= 2; const nNets = rs(); const nets = [];
  for (let i = 0; i < nNets; i++) { const n = rb(); nets.push(str(n)); }
  parts.push({ name: "TP", side: "BOTH", nail: true }); const dummy = parts.length - 1;
  let q = p; while (q < u8.length - 4 && !(u8[q] === 67 && u8[q + 1] === 80 && u8[q + 2] === 97 && u8[q + 3] === 100)) q++; // "CPad"
  if (q >= u8.length - 4) throw new Error("This CST file has no pad section that Trace Lab can find.");
  p = q - 8; const nPins = rs(); p += 10;
  const pins = [];
  for (let i = 0; i < nPins && p + 16 <= u8.length; i++) {
    const pid = rs(); rs(); const nid = rs(); const x = rs(); const y = rs(); rs(); p += 4;
    pins.push({ part: pid >= 0 ? pid : dummy, net: nets[nid] || "", x, y });
  }
  return { parts, pins };
}

/* ============================================================ ASUS FZ / CAE (RC6 + zlib) */
const FZ_PARITY = [0, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1];
const CAE_PARITY = [1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 0];
export function parseKeyWords(s) {
  const m = String(s || "").match(/(0x)?[0-9a-f]+/gi) || [];
  return m.map((h) => parseInt(h.replace(/^0x/i, ""), 16) >>> 0);
}
function wordParity(w) { w ^= w >>> 16; w ^= w >>> 8; w ^= w >>> 4; w ^= w >>> 2; w ^= w >>> 1; return (~w) & 1; }
export function checkRC6Key(words, parity) { return words.length === 44 && words.every((w, i) => wordParity(w) === parity[i]); }
const rotl = (a, b) => ((a << b) | (a >>> (32 - b))) >>> 0;
export function rc6Stream(buf, key, encrypt = false) {
  let A = 0, B = 0, C = 0, D = 0; const ib = new Uint8Array(16);
  for (let pos = 0; pos < buf.length; pos++) {
    B = (B + key[0]) >>> 0; D = (D + key[1]) >>> 0;
    for (let i = 1; i <= 20; i++) {
      const t = rotl(Math.imul(B, 2 * B + 1) >>> 0, 5), u = rotl(Math.imul(D, 2 * D + 1) >>> 0, 5);
      A = (rotl((A ^ t) >>> 0, u) + key[2 * i]) >>> 0;
      C = (rotl((C ^ u) >>> 0, t) + key[2 * i + 1]) >>> 0;
      const tmp = A; A = B; B = C; C = D; D = tmp;
    }
    A = (A + key[42]) >>> 0; C = (C + key[43]) >>> 0;
    const inB = buf[pos]; const outB = (inB ^ (A & 0xff)) & 0xff; buf[pos] = outB;
    const cipher = encrypt ? outB : inB;
    ib.copyWithin(0, 1); ib[15] = cipher;
    A = (ib[0] | ib[1] << 8 | ib[2] << 16 | ib[3] << 24) >>> 0; B = (ib[4] | ib[5] << 8 | ib[6] << 16 | ib[7] << 24) >>> 0;
    C = (ib[8] | ib[9] << 8 | ib[10] << 16 | ib[11] << 24) >>> 0; D = (ib[12] | ib[13] << 8 | ib[14] << 16 | ib[15] << 24) >>> 0;
  }
  return buf;
}
export async function inflate(u8) {
  // zlib stream; tolerate trailing bytes after the end of the stream
  const ds = new DecompressionStream("deflate"); const w = ds.writable.getWriter();
  w.write(u8).catch(() => {}); w.close().catch(() => {});
  const r = ds.readable.getReader(); const chunks = []; let n = 0;
  try { for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); n += value.length; } }
  catch (e) { if (!n) throw new Error("Decompression failed. The file is damaged, or the decryption key is wrong."); }
  const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}
async function parseFZ(u8, keyStr, parity, label, builtin) {
  let b = u8.slice();
  if (!(b[4] === 0x78 && (b[5] === 0x9c || b[5] === 0xda))) {
    let key = parseKeyWords(keyStr);
    if (key.length && !checkRC6Key(key, parity)) throw new NeedKeyError(label.toLowerCase(), `The ${label} key in Settings isn't valid (it needs 44 words and fails the parity check). Check it and try again.`);
    if (!key.length) key = builtin && checkRC6Key(builtin, parity) ? builtin : []; // built-in key when none is set
    if (!key.length) throw new NeedKeyError(label.toLowerCase(), `This ${label} file is encrypted. Add your ${label} key (44 hex words) in Settings, then open the file again.`);
    rc6Stream(b, key);
  }
  const N = b.length;
  const dlen = (b[N - 1] << 24 | b[N - 2] << 16 | b[N - 3] << 8 | b[N - 4]) >>> 0;
  if (dlen > N) throw new Error(`This ${label} file didn't decode cleanly. If it's encrypted, the key is probably wrong.`);
  const contentSize = N - dlen + 4;
  const content = latin1.decode(await inflate(b.subarray(4, Math.min(N, 4 + contentSize))));
  let descr = "";
  try { descr = latin1.decode(await inflate(b.subarray(contentSize, contentSize + dlen))); } catch (e) {}
  return parseFabText(content, descr);
}
// Allegro extract text: "A!col!col!" header rows followed by "S!val!val!" rows. Also the decoded FZ payload.
function parseFabText(t, descr) {
  const parts = [], pins = [], ids = new Map(); let mult = 1, cols = null, blk = "";
  const getPart = (n) => { let i = ids.get(n); if (i === undefined) { parts.push({ name: n, side: "T" }); i = parts.length - 1; ids.set(n, i); } return i; };
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    if (l === "UNIT:millimeters") mult = 25.4;
    if (l.startsWith("A!")) { cols = l.slice(2).split("!"); blk = cols[0]; continue; }
    if (!l.startsWith("S!") || !cols) continue;
    const v = l.slice(2).split("!"); const c = (k) => { const i = cols.indexOf(k); return i >= 0 ? (v[i] || "").trim() : ""; };
    if (blk === "REFDES" && cols.includes("SYM_MIRROR")) { const i = getPart(c("REFDES")); parts[i].side = c("SYM_MIRROR") === "YES" ? "B" : "T"; if (c("COMP_DEVICE_TYPE")) parts[i].desc = c("COMP_DEVICE_TYPE"); }
    else if (cols.includes("NET_NAME") && cols.includes("REFDES") && cols.includes("PIN_X")) {
      const ref = c("REFDES"); if (!ref) continue;
      const i = getPart(ref); let n = c("PIN_NUMBER"); const nm = c("PIN_NAME");
      if (n.length <= 1 && (n === "" || n === "0")) n = nm;
      const side = cols.includes("SYM_MIRROR") ? c("SYM_MIRROR") : "";
      if (side === "YES") parts[i].side = "B";
      pins.push({ part: i, net: c("NET_NAME"), num: n, name: nm, x: num(c("PIN_X")) * mult, y: num(c("PIN_Y")) * mult });
    }
  }
  if (descr) {
    const L = lines(descr);
    for (let i = 2; i < L.length; i++) {
      const l = L[i].trim(); if (!l || l[0] === "s") continue;
      const f = L[i].split("\t"); const d = (f[1] || "").trim(); const locs = (f[3] || "").split(/[\s,]+/);
      locs.forEach((n) => { const pi = ids.get(n); if (pi !== undefined && d) parts[pi].desc = d + (f[0] ? " (" + f[0].trim() + ")" : ""); });
    }
  }
  return { parts, pins };
}

/* ============================================================ XZZ (XOR + DES) */
const XZZ_PARITY = [1, 1, 1, 1, 1, 1, 1, 0];
function isXZZ(u8) {
  const sig = [88, 90, 90, 80, 67, 66]; // XZZPCB
  if (sig.every((c, i) => u8[i] === c)) return true;
  if (u8.length > 0x10 && u8[0x10] !== 0) { const k = u8[0x10]; return sig.every((c, i) => (u8[i] ^ k) === c); }
  return false;
}
export function parseHexKey64(s) {
  const h = String(s || "").replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "");
  if (h.length !== 16) return null;
  const out = new Uint8Array(8); for (let i = 0; i < 8; i++) out[i] = parseInt(h.substr(i * 2, 2), 16); return out;
}
export function checkXZZKey(k8) { // k8 big-endian bytes; parity indexed from least significant byte
  if (!k8) return false;
  for (let i = 0; i < 8; i++) { let t = k8[7 - i]; t ^= t >> 4; t ^= t >> 2; t ^= t >> 1; if (((~t) & 1) !== XZZ_PARITY[i]) return false; }
  return true;
}
function parseXZZ(u8in, keyStr) {
  const b = u8in.slice();
  const marker = [118, 54, 118, 54, 53, 53, 53, 118, 54, 118, 54]; // v6v6555v6v6
  let mk = b.length;
  outer: for (let i = 0; i + marker.length <= b.length; i++) { for (let j = 0; j < marker.length; j++) if (b[i + j] !== marker[j]) continue outer; mk = i; break; }
  if (b[0x10] !== 0) { const k = b[0x10]; for (let i = 0; i < mk; i++) b[i] ^= k; }
  const dv = new DataView(b.buffer); const u32 = (o) => { if (o + 4 > b.length) throw new Error("XZZ file is truncated."); return dv.getUint32(o, true); };
  const mainStart = u32(0x20) + 0x20, netStart = u32(0x28) + 0x20;
  const mainSize = u32(mainStart), netSize = u32(netStart);
  const nets = new Map();
  { let p = netStart + 4; const end = netStart + 4 + netSize; while (p < end) { const sz = u32(p), idx = u32(p + 4); nets.set(idx, latin1.decode(b.subarray(p + 8, p + sz))); p += sz; } }
  const k8 = parseHexKey64(keyStr);
  let des = null;
  const parts = [], pins = [], segs = [], xTraces = [];
  let p = mainStart + 4; const end = mainStart + 4 + mainSize;
  const S = 10000;
  while (p < end) {
    const type = b[p]; p += 1; const size = u32(p); p += 4; const blk = b.subarray(p, p + size); p += size;
    const bv = new DataView(blk.buffer, blk.byteOffset, blk.byteLength); const r = (o) => bv.getUint32(o, true);
    if (type === 0x05 && size >= 24) {
      if (r(0) === 28) segs.push([r(4) / S, r(8) / S, r(12) / S, r(16) / S]);
      else { const w = r(20) / S; xTraces.push({ x1: r(4) / S, y1: r(8) / S, x2: r(12) / S, y2: r(16) / S, w: w > 0 && w < 400 ? w : 6, layer: r(0), ni: size >= 28 ? r(24) : -1 }); }
    }
    else if (type === 0x01 && size >= 28) {
      if (r(0) !== 28) continue;
      let a0 = r(16) / S, a1 = r(20) / S; if (a0 > a1) [a0, a1] = [a1, a0]; if (a1 - a0 > 180) a0 += 360;
      segs.push(...arcSegs(r(4) / S, r(8) / S, r(12) / S, a0 * Math.PI / 180, a1 * Math.PI / 180, 9));
    }
    else if (type === 0x07) {
      if (!k8) throw new NeedKeyError("xzz", "This XZZ board stores its parts encrypted. Add your XZZ key (16 hex digits) in Settings, then open the file again.");
      if (!checkXZZKey(k8)) throw new NeedKeyError("xzz", "The XZZ key in Settings isn't valid (it fails the parity check). Check it and try again.");
      des = des || desSchedule(k8);
      const d = desDecryptBuf(blk, des); const dd = new DataView(d.buffer); const g = (o) => dd.getUint32(o, true);
      let c = 0; const partSize = g(c); c += 4 + 18; const grp = g(c); c += 4 + grp;
      if (d[c] !== 0x06) continue;
      c += 31; const nl = g(c); c += 4; const pname = latin1.decode(d.subarray(c, c + nl)); c += nl;
      parts.push({ name: pname, side: "T" }); const pi = parts.length - 1;
      while (c < partSize + 4 && c < d.length) {
        const st = d[c]; c += 1;
        if (st === 0x01 || st === 0x05 || st === 0x06) { c += g(c) + 4; }
        else if (st === 0x09) {
          const bs = g(c); const pend = c + bs + 4; c += 8;
          const x = g(c); c += 4; const y = g(c); c += 4; c += 8;
          const nl2 = g(c); c += 4; const pn = latin1.decode(d.subarray(c, c + nl2)); c += nl2; c += 32;
          const ni = g(c); c = pend;
          pins.push({ part: pi, num: pn, x: x / S, y: y / S, net: nets.get(ni) || "" });
        }
      }
    }
    else if (type === 0x09 && size >= 24) {
      const x = r(4), y = r(8); const nlen = r(20); const nm = latin1.decode(blk.subarray(24, 24 + nlen)); const ni = r(size - 4);
      parts.push({ name: "TP" + nm, side: "T", nail: true }); pins.push({ part: parts.length - 1, num: nm, x: x / S, y: y / S, net: nets.get(ni) || "" });
    }
  }
  let mx = Infinity, my = Infinity; segs.forEach((s) => { mx = Math.min(mx, s[0], s[2]); my = Math.min(my, s[1], s[3]); });
  if (isFinite(mx)) { segs.forEach((s) => { s[0] -= mx; s[2] -= mx; s[1] -= my; s[3] -= my; }); pins.forEach((q) => { q.x -= mx; q.y -= my; }); xTraces.forEach((t) => { t.x1 -= mx; t.x2 -= mx; t.y1 -= my; t.y2 -= my; }); }
  // XZZ keeps other line work (copper, silkscreen) as numbered layers; offer each as a layer to show or hide
  const traces = xTraces.map((t) => ({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, w: t.w, layer: t.layer, net: t.ni >= 0 ? nets.get(t.ni) || "" : "" }));
  const ids = [...new Set(traces.map((t) => t.layer))].sort((a, b) => a - b);
  const layers = ids.map((l, i) => ({ id: l, name: "Layer " + l, side: i === 0 ? "T" : i === ids.length - 1 && ids.length > 1 ? "B" : "I" }));
  return { parts, pins, segments: segs, traces, layers };
}

/* ---------- DES (FIPS 46-3), bit-array implementation ---------- */
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const EX = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const PP = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SH = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SB = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
const toBits = (b8, o) => { const r = new Uint8Array(64); for (let i = 0; i < 64; i++) r[i] = (b8[o + (i >> 3)] >> (7 - (i & 7))) & 1; return r; };
export function desSchedule(k8) {
  const k = toBits(k8, 0); const cd = PC1.map((i) => k[i - 1]); let c = cd.slice(0, 28), d = cd.slice(28);
  const subs = [];
  for (let r = 0; r < 16; r++) { for (let s = 0; s < SH[r]; s++) { c.push(c.shift()); d.push(d.shift()); } const cd2 = c.concat(d); subs.push(Uint8Array.from(PC2.map((i) => cd2[i - 1]))); }
  return subs;
}
export function desBlock(in8, o, out8, oo, subs, decrypt) {
  const x = toBits(in8, o); let L = new Uint8Array(32), R = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { L[i] = x[IP[i] - 1]; R[i] = x[IP[i + 32] - 1]; }
  const e = new Uint8Array(48), f = new Uint8Array(32);
  for (let r = 0; r < 16; r++) {
    const K = subs[decrypt ? 15 - r : r];
    for (let i = 0; i < 48; i++) e[i] = R[EX[i] - 1] ^ K[i];
    for (let s = 0; s < 8; s++) {
      const j = s * 6; const row = (e[j] << 1) | e[j + 5]; const col = (e[j + 1] << 3) | (e[j + 2] << 2) | (e[j + 3] << 1) | e[j + 4];
      const v = SB[s][row * 16 + col]; f[s * 4] = (v >> 3) & 1; f[s * 4 + 1] = (v >> 2) & 1; f[s * 4 + 2] = (v >> 1) & 1; f[s * 4 + 3] = v & 1;
    }
    const nR = new Uint8Array(32); for (let i = 0; i < 32; i++) nR[i] = L[i] ^ f[PP[i] - 1];
    L = R; R = nR;
  }
  const pre = new Uint8Array(64); pre.set(R, 0); pre.set(L, 32);
  for (let i = 0; i < 8; i++) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | pre[FP[i * 8 + j] - 1]; out8[oo + i] = v; }
}
function desDecryptBuf(inb, subs) {
  const out = new Uint8Array(inb.length); const tmp = new Uint8Array(8);
  for (let o = 0; o < inb.length; o += 8) {
    if (o + 8 <= inb.length) desBlock(inb, o, out, o, subs, true);
    else { const t = new Uint8Array(8); t.set(inb.subarray(o)); desBlock(t, 0, tmp, 0, subs, true); out.set(tmp.subarray(0, inb.length - o), o); }
  }
  return out;
}

/* ============================================================ GenCAD 1.4 */
function gTok(l) { const out = []; const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g; let m; while ((m = re.exec(l))) out.push(m[1] !== undefined ? m[1] : m[2]); return out; }
function parseGenCAD(t) {
  let sec = "", conv = (v) => v * 1000; // default INCH
  const segs = [], padstacks = new Map(), shapes = new Map(), comps = [], devices = new Map(), signals = new Map();
  let curPS = null, curShape = null, curComp = null, curDev = null, curSig = null;
  const trackW = new Map(), gTraces = [], gVias = [], rLayers = []; let rNet = "", rW = 8, rLayer = "";
  const padDefs = new Map(), holes = []; let curPad = null;
  for (const raw of lines(t)) {
    const l = raw.trim(); if (!l) continue;
    if (l[0] === "$") { sec = l.toUpperCase(); curPS = curShape = curComp = curDev = curSig = curPad = null; continue; }
    const k = gTok(l); const kw = (k[0] || "").toUpperCase();
    if (sec === "$HEADER" && kw === "UNITS") {
      const u = (k[1] || "").toUpperCase(), n = +k[2] || 1;
      conv = u === "THOU" ? (v) => v : u === "MM" ? (v) => v / 0.0254 : u === "MM100" ? (v) => v / 2.54 : u === "USER" ? (v) => v / n * 1000 : u === "USERMM" ? (v) => v / n / 0.0254 : u === "USERCM" ? (v) => v / n * 10 / 0.0254 : (v) => v * 1000;
    } else if (sec === "$BOARD") {
      const v = k.slice(1).map(Number).map(conv);
      if (kw === "LINE" && v.length >= 4) segs.push([v[0], v[1], v[2], v[3]]);
      else if (kw === "ARC" && v.length >= 6) { const [x1, y1, x2, y2, cx, cy] = v; const r = Math.hypot(x1 - cx, y1 - cy); let a0 = Math.atan2(y1 - cy, x1 - cx), a1 = Math.atan2(y2 - cy, x2 - cx); if (a1 <= a0) a1 += Math.PI * 2; segs.push(...arcSegs(cx, cy, r, a0, a1)); }
      else if (kw === "CIRCLE" && v.length >= 3) segs.push(...arcSegs(v[0], v[1], v[2], 0, Math.PI * 2, 24));
      else if (kw === "RECTANGLE" && v.length >= 4) { const [x, y, w, h] = v; segs.push([x, y, x + w, y], [x + w, y, x + w, y + h], [x + w, y + h, x, y + h], [x, y + h, x, y]); }
    } else if (sec === "$PADS") {
      // pad shapes: RECTANGLE x y w h | CIRCLE x y r | a closed LINE/ARC polygon
      const v = k.slice(1).map(Number).map(conv);
      if (kw === "PAD") { curPad = { pts: [] }; padDefs.set(k[1], curPad); }
      else if (!curPad) continue;
      else if (kw === "RECTANGLE" && v.length >= 4 && v[2] > 0 && v[3] > 0) { const [x, y, w, h] = v; curPad.pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; curPad.half = Math.min(w, h) / 2; }
      else if (kw === "CIRCLE" && v.length >= 3 && v[2] > 0) { curPad.circle = [v[0], v[1], v[2]]; curPad.half = v[2]; }
      else if (kw === "LINE" && v.length >= 4) { if (!curPad.pts.length) curPad.pts.push([v[0], v[1]]); curPad.pts.push([v[2], v[3]]); }
      else if (kw === "ARC" && v.length >= 6) { const [x1, y1, x2, y2, cx, cy] = v; const r = Math.hypot(x1 - cx, y1 - cy); let a0 = Math.atan2(y1 - cy, x1 - cx), a1 = Math.atan2(y2 - cy, x2 - cx); if (a1 <= a0) a1 += Math.PI * 2; if (!curPad.pts.length) curPad.pts.push([x1, y1]); arcSegs(cx, cy, r, a0, a1, 8).forEach(([, , x, y]) => curPad.pts.push([x, y])); }
    } else if (sec === "$MECH") {
      if (kw === "HOLE" && k.length >= 4) holes.push({ x: conv(+k[1]), y: conv(+k[2]), r: conv(+k[3]) / 2 });
    } else if (sec === "$PADSTACKS") {
      if (kw === "PADSTACK") { curPS = { drill: +k[2] || 0, layers: new Set(), cu: {} }; padstacks.set(k[1], curPS); }
      else if (kw === "PAD" && curPS) { const ly = (k[2] || "").toUpperCase(); curPS.layers.add(ly); if (!curPS.cu[ly]) curPS.cu[ly] = { pad: k[1], rot: +k[3] || 0, mir: k[4] === "1" || /^MIRROR/i.test(k[4] || "") }; }
    } else if (sec === "$SHAPES") {
      if (kw === "SHAPE") { curShape = { pins: [], smd: true }; shapes.set(k[1], curShape); }
      else if (kw === "INSERT" && curShape) curShape.smd = !/^TH/i.test(k[1] || "");
      else if (kw === "PIN" && curShape && k.length >= 5) curShape.pins.push({ name: k[1], pad: k[2], x: conv(+k[3]), y: conv(+k[4]), layer: (k[5] || "").toUpperCase(), rot: +k[6] || 0, mir: k[7] === "1" || /^MIRROR/i.test(k[7] || "") });
    } else if (sec === "$COMPONENTS") {
      if (kw === "COMPONENT") { curComp = { name: k[1], x: 0, y: 0, rot: 0, side: "T", shape: "", mx: false, my: false, flip: false, dev: "" }; comps.push(curComp); }
      else if (!curComp) continue;
      else if (kw === "PLACE") { curComp.x = conv(+k[1]); curComp.y = conv(+k[2]); }
      else if (kw === "LAYER") curComp.side = /BOTTOM/i.test(k[1]) ? "B" : "T";
      else if (kw === "ROTATION") curComp.rot = +k[1] || 0;
      else if (kw === "SHAPE") { curComp.shape = k[1]; const r = k.slice(2).map((s) => s.toUpperCase()); curComp.mx = r.includes("MIRRORX"); curComp.my = r.includes("MIRRORY"); curComp.flip = r.includes("FLIP"); }
      else if (kw === "DEVICE") curComp.dev = k.slice(1).join(" ");
    } else if (sec === "$DEVICES") {
      if (kw === "DEVICE") { curDev = { part: "", value: "", desc: "" }; devices.set(k.slice(1).join(" "), curDev); }
      else if (curDev && kw === "PART") curDev.part = k.slice(1).join(" ");
      else if (curDev && kw === "VALUE") curDev.value = k.slice(1).join(" ");
      else if (curDev && kw === "DESC") curDev.desc = k.slice(1).join(" ");
    } else if (sec === "$TRACKS") {
      if (kw === "TRACK" && k.length >= 3) trackW.set(k[1], conv(+k[2]));
    } else if (sec === "$ROUTES") {
      const v = k.slice(1).map(Number).map(conv);
      if (kw === "ROUTE") { rNet = l.replace(/^ROUTE\s+/i, "").replace(/^"|"$/g, "").trim(); }
      else if (kw === "TRACK") rW = trackW.has(k[1]) ? trackW.get(k[1]) : conv(+k[1]) || 8;
      else if (kw === "LAYER") { rLayer = (k[1] || "").toUpperCase(); if (!rLayers.includes(rLayer)) rLayers.push(rLayer); }
      else if (kw === "LINE" && v.length >= 4 && rLayer) gTraces.push({ x1: v[0], y1: v[1], x2: v[2], y2: v[3], w: rW, layer: rLayer, net: rNet });
      else if (kw === "ARC" && v.length >= 6 && rLayer) { const [x1, y1, x2, y2, cx, cy] = v; const r = Math.hypot(x1 - cx, y1 - cy); let a0 = Math.atan2(y1 - cy, x1 - cx), a1 = Math.atan2(y2 - cy, x2 - cx); if (a1 <= a0) a1 += Math.PI * 2; arcSegs(cx, cy, r, a0, a1, 10).forEach(([a, b, c, d]) => gTraces.push({ x1: a, y1: b, x2: c, y2: d, w: rW, layer: rLayer, net: rNet })); }
      else if (kw === "VIA" && k.length >= 4) { const ps = padstacks.get(k[1]); gVias.push({ x: conv(+k[2]), y: conv(+k[3]), r: ps && ps.drill ? conv(ps.drill) : 10, net: rNet }); }
    } else if (sec === "$SIGNALS") {
      if (kw === "SIGNAL") curSig = l.replace(/^SIGNAL\s+/i, "").replace(/^"|"$/g, "").trim();
      else if (kw === "NODE" && curSig !== null) signals.set(k[1] + "\u0000" + k[2], curSig);
    }
  }
  const parts = [], pins = [], seen = new Set();
  for (const c of comps) {
    const sh = shapes.get(c.shape); if (!sh) continue;
    const dup = c.side + c.x + "," + c.y + c.shape; if (seen.has(dup)) continue; seen.add(dup);
    const d = devices.get(c.dev); const desc = [d && d.value, d && d.desc, d && d.part, !d && c.dev].filter(Boolean).join(" · ");
    const th = !sh.smd || sh.pins.some((p) => { const ps = padstacks.get(p.pad); return ps && ps.drill > 0; });
    parts.push({ name: c.name, side: th ? "BOTH" : c.side, desc }); const pi = parts.length - 1;
    let rad = c.rot * Math.PI / 180; const sx = c.mx ? -1 : 1, sy = c.my ? -1 : 1; if (sx * sy === -1) rad = Math.PI - rad;
    const co = Math.cos(rad), si = Math.sin(rad);
    const place = (lx, ly) => [c.x + sx * (lx * co - ly * si), c.y + sy * (lx * si + ly * co)];
    for (const p of sh.pins) {
      const [x, y] = place(p.x, p.y);
      const geo = padGeometry(padstacks.get(p.pad), padDefs, p, place);
      let side;
      const ps = padstacks.get(p.pad);
      if (ps && ps.layers.size) { const top = ps.layers.has("TOP"), bot = ps.layers.has("BOTTOM"), all = ps.layers.has("ALL") || ps.layers.has("INNER"); side = all || (top && bot) ? "BOTH" : top ? "T" : bot ? "B" : undefined; if (side && c.flip && side !== "BOTH") side = side === "T" ? "B" : "T"; }
      if (side === "T" && c.side === "B" && !c.flip) side = "B";
      const pin = { part: pi, num: p.name, x, y, net: signals.get(c.name + "\u0000" + p.name) || "", side: side === "BOTH" ? "BOTH" : undefined };
      if (geo) { pin.r = geo.r; pin.real = true; if (geo.poly) pin.poly = geo.poly; }
      pins.push(pin);
    }
  }
  const lo = (l) => (l === "TOP" ? -1 : l === "BOTTOM" ? 999 : +(l.match(/\d+/) || [500])[0]);
  const layers = rLayers.slice().sort((a, b) => lo(a) - lo(b)).map((l) => ({ id: l, name: l[0] + l.slice(1).toLowerCase(), side: l === "TOP" ? "T" : l === "BOTTOM" ? "B" : "I" }));
  return { parts, pins, segments: segs, traces: gTraces, vias: gVias, layers, holes };
}
// The copper pad a GenCAD pin uses, placed on the board: { r } for a round pad, { r, poly } otherwise
// (r is half the pad's narrow side, used for hit-testing and label sizing).
function padGeometry(ps, padDefs, pin, place) {
  if (!ps) return null;
  const cu = ps.cu.TOP || ps.cu.ALL || ps.cu.BOTTOM || ps.cu.INNER || Object.values(ps.cu)[0];
  const def = cu && padDefs.get(cu.pad); if (!def) return null;
  if (def.half === undefined && def.pts.length > 2) { const xs = def.pts.map((q) => q[0]), ys = def.pts.map((q) => q[1]); def.half = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2; }
  if (!(def.half > 0)) return null;
  const a = (cu.rot + pin.rot) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
  const local = ([x, y]) => { if (cu.mir) x = -x; let X = x * ca - y * sa, Y = x * sa + y * ca; if (pin.mir) X = -X; return place(pin.x + X, pin.y + Y); };
  if (def.circle) return { r: def.circle[2] };
  let pts = def.pts; if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts = pts.slice(0, -1);
  if (pts.length < 3) return null;
  return { r: def.half, poly: pts.map(local) };
}

/* ============================================================ Altium ASCII */
const CU_ALT = /^(TOP|BOTTOM|MID\d+)$/;
function parseAltium(t) {
  const nets = new Map(), comps = new Map(), pads = [], segs = [], cu = [], vs = [];
  for (const l of lines(t)) {
    if (!l.includes("|RECORD=")) continue;
    const kv = {}; l.split("|").forEach((s) => { const i = s.indexOf("="); if (i > 0) kv[s.slice(0, i).toUpperCase()] = s.slice(i + 1); });
    const rec = kv.RECORD;
    if (rec === "Net") nets.set(+kv.ID, kv.NAME);
    else if (rec === "Component" && kv.ID !== undefined) comps.set(+kv.ID, { name: kv.SOURCEDESIGNATOR || "U?" + kv.ID, side: kv.LAYER === "TOP" ? "T" : kv.LAYER === "BOTTOM" ? "B" : "BOTH", desc: kv.SOURCEDESCRIPTION || kv.COMMENT || "" });
    else if (rec === "Pad" && kv.COMPONENT !== undefined && kv.X !== undefined) {
      const xs = num(kv.XSIZE), ys = num(kv.YSIZE);
      pads.push({ comp: +kv.COMPONENT, netId: kv.NET !== undefined ? +kv.NET : null, num: kv.NAME || "", x: num(kv.X), y: num(kv.Y), r: xs > 0 && ys > 0 ? Math.min(xs, ys) / 2 : undefined, th: kv.LAYER === "MULTILAYER" });
    }
    else if ((rec === "Track") && kv.LAYER === "KEEPOUT") segs.push([num(kv.X1), num(kv.Y1), num(kv.X2), num(kv.Y2)]);
    else if (rec === "Track" && CU_ALT.test(kv.LAYER || "")) cu.push({ x1: num(kv.X1), y1: num(kv.Y1), x2: num(kv.X2), y2: num(kv.Y2), w: num(kv.WIDTH) || 8, layer: kv.LAYER, netId: kv.NET !== undefined ? +kv.NET : null });
    else if (rec === "Arc" && CU_ALT.test(kv.LAYER || "")) { const cx = num(kv["LOCATION.X"]), cy = num(kv["LOCATION.Y"]), r = num(kv.RADIUS); let a0 = num(kv.STARTANGLE) * Math.PI / 180, a1 = num(kv.ENDANGLE) * Math.PI / 180; if (a1 <= a0) a1 += Math.PI * 2; arcSegs(cx, cy, r, a0, a1, 10).forEach(([x1, y1, x2, y2]) => cu.push({ x1, y1, x2, y2, w: num(kv.WIDTH) || 8, layer: kv.LAYER, netId: kv.NET !== undefined ? +kv.NET : null })); }
    else if (rec === "Via" && kv.X !== undefined) vs.push({ x: num(kv.X), y: num(kv.Y), r: (num(kv.DIAMETER) || 20) / 2, netId: kv.NET !== undefined ? +kv.NET : null });
    else if (rec === "Arc" && kv.LAYER === "KEEPOUT") { const cx = num(kv["LOCATION.X"]), cy = num(kv["LOCATION.Y"]), r = num(kv.RADIUS); let a0 = num(kv.STARTANGLE) * Math.PI / 180, a1 = num(kv.ENDANGLE) * Math.PI / 180; if (a1 <= a0) a1 += Math.PI * 2; segs.push(...arcSegs(cx, cy, r, a0, a1)); }
  }
  // NET ids are resolved after all records are read, so redo the lookups
  const parts = [], idx = new Map();
  for (const [id, c] of comps) { idx.set(id, parts.length); parts.push(c); }
  const pins = [];
  for (const p of pads) { const pi = idx.get(p.comp); if (pi === undefined) continue; if (p.th) parts[pi].side = "BOTH"; pins.push({ part: pi, num: p.num, x: p.x, y: p.y, r: p.r, net: p.netId === null ? "" : nets.get(p.netId) || "" }); }
  const nn = (id) => (id === null ? "" : nets.get(id) || "");
  const traces = cu.map((t) => ({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, w: t.w, layer: t.layer, net: nn(t.netId) }));
  const vias = vs.map((v) => ({ x: v.x, y: v.y, r: v.r, net: nn(v.netId) }));
  const ids = [...new Set(traces.map((t) => t.layer))].sort((a, b) => (a === "TOP" ? -1 : a === "BOTTOM" ? 999 : +a.slice(3)) - (b === "TOP" ? -1 : b === "BOTTOM" ? 999 : +b.slice(3)));
  const layers = ids.map((l) => ({ id: l, name: l === "TOP" ? "Top" : l === "BOTTOM" ? "Bottom" : "Mid " + l.slice(3), side: l === "TOP" ? "T" : l === "BOTTOM" ? "B" : "I" }));
  return { parts, pins, segments: segs, traces, vias, layers };
}

/* ============================================================ KiCad (.kicad_pcb) */
function sexpr(t) {
  let i = 0; const n = t.length;
  function parse() {
    const list = [];
    while (i < n) {
      const c = t[i];
      if (c === "(") { i++; list.push(parse()); }
      else if (c === ")") { i++; return list; }
      else if (c === '"') { let s = ""; i++; while (i < n && t[i] !== '"') { if (t[i] === "\\" && i + 1 < n) { s += t[i + 1]; i += 2; } else s += t[i++]; } i++; list.push(s); }
      else if (c === " " || c === "\n" || c === "\r" || c === "\t") i++;
      else { let s = ""; while (i < n && !/[\s()"]/.test(t[i])) s += t[i++]; list.push(s); }
    }
    return list;
  }
  return parse()[0];
}
const kid = (node, k) => node.find((x) => Array.isArray(x) && x[0] === k);
const kids = (node, k) => node.filter((x) => Array.isArray(x) && x[0] === k);
function parseKiCad(t) {
  const root = sexpr(t); const MIL = 1 / 0.0254;
  const nets = new Map(); kids(root, "net").forEach((n) => nets.set(n[1], n[2]));
  const parts = [], pins = [], segs = [];
  for (const fp of [...kids(root, "footprint"), ...kids(root, "module")]) {
    const at = kid(fp, "at") || ["at", 0, 0, 0]; const fx = +at[1], fy = +at[2], rot = (+at[3] || 0) * Math.PI / 180;
    const layer = (kid(fp, "layer") || [])[1] || "F.Cu";
    let ref = "", val = "";
    kids(fp, "fp_text").forEach((x) => { if (x[1] === "reference") ref = x[2]; if (x[1] === "value") val = x[2]; });
    kids(fp, "property").forEach((x) => { if (x[1] === "Reference") ref = x[2]; if (x[1] === "Value") val = x[2]; });
    const pads = kids(fp, "pad"); if (!pads.length) continue;
    const side = /^B\./.test(layer) ? "B" : "T"; const th = pads.length && pads.every((p) => p[2] === "thru_hole" || p[2] === "np_thru_hole");
    parts.push({ name: ref || "REF**", side: th ? "BOTH" : side, desc: val }); const pi = parts.length - 1;
    const co = Math.cos(rot), si = Math.sin(rot);
    for (const p of pads) {
      const pa = kid(p, "at") || ["at", 0, 0]; const px = +pa[1], py = +pa[2];
      const ax = fx + px * co + py * si, ay = fy - px * si + py * co;
      const nn = kid(p, "net"); const net = nn ? (nn.length >= 3 ? nn[2] : (nets.get(nn[1]) || nn[1])) : "";
      const sz = kid(p, "size"); const r = sz ? Math.min(+sz[1], +sz[2]) / 2 * MIL : undefined;
      pins.push({ part: pi, num: p[1], x: ax * MIL, y: -ay * MIL, net, r });
    }
  }
  const edge = (g) => { const l = kid(g, "layer"); return l && l[1] === "Edge.Cuts"; };
  const P = (n) => [+n[1] * MIL, -n[2] * MIL];
  for (const g of root) {
    if (!Array.isArray(g) || !edge(g)) continue;
    if (g[0] === "gr_line") { const a = P(kid(g, "start")), b = P(kid(g, "end")); segs.push([a[0], a[1], b[0], b[1]]); }
    else if (g[0] === "gr_rect") { const a = P(kid(g, "start")), b = P(kid(g, "end")); segs.push([a[0], a[1], b[0], a[1]], [b[0], a[1], b[0], b[1]], [b[0], b[1], a[0], b[1]], [a[0], b[1], a[0], a[1]]); }
    else if (g[0] === "gr_arc" && kid(g, "mid")) { const a = P(kid(g, "start")), m = P(kid(g, "mid")), b = P(kid(g, "end")); segs.push([a[0], a[1], m[0], m[1]], [m[0], m[1], b[0], b[1]]); }
    else if (g[0] === "gr_circle") { const c = P(kid(g, "center")), e = P(kid(g, "end")); segs.push(...arcSegs(c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), 0, Math.PI * 2, 24)); }
    else if (g[0] === "gr_poly") { const pts = kid(g, "pts"); if (pts) { const xy = kids(pts, "xy").map(P); for (let i = 0; i < xy.length; i++) { const a = xy[i], b = xy[(i + 1) % xy.length]; segs.push([a[0], a[1], b[0], b[1]]); } } }
  }
  // copper: tracks, arcs, vias and filled zones
  const netOf = (g) => { const nn = kid(g, "net"); return nn ? (nn.length >= 3 ? nn[2] : (nets.get(nn[1]) || nn[1])) : ""; };
  const traces = [], vias = [], zones = [], seen = new Set();
  const isCu = (l) => /\.Cu$/.test(l || "");
  const add = (l) => { if (isCu(l)) seen.add(l); return l; };
  for (const g of root) {
    if (!Array.isArray(g)) continue;
    if (g[0] === "segment" || g[0] === "arc") {
      const l = (kid(g, "layer") || [])[1]; if (!isCu(l)) continue; add(l);
      const w = +((kid(g, "width") || [])[1] || 0.2) * MIL, net = netOf(g);
      const ss = g[0] === "segment" ? [[...P(kid(g, "start")), ...P(kid(g, "end"))]] : arc3(P(kid(g, "start")), P(kid(g, "mid")), P(kid(g, "end")));
      ss.forEach(([x1, y1, x2, y2]) => traces.push({ x1, y1, x2, y2, w, layer: l, net }));
    } else if (g[0] === "via") {
      const at = kid(g, "at"); if (!at) continue; vias.push({ x: +at[1] * MIL, y: -at[2] * MIL, r: +((kid(g, "size") || [])[1] || 0.6) * MIL / 2, net: netOf(g) });
    } else if (g[0] === "zone") {
      const net = ((kid(g, "net_name") || [])[1]) || netOf(g);
      for (const fp of kids(g, "filled_polygon")) { const l = (kid(fp, "layer") || kid(g, "layer") || [])[1]; const pts = kid(fp, "pts"); if (!isCu(l) || !pts) continue; add(l); zones.push({ layer: l, net, poly: kids(pts, "xy").map(P) }); }
    }
  }
  const order = (l) => l === "F.Cu" ? -1 : l === "B.Cu" ? 999 : +(l.match(/In(\d+)/) || [0, 500])[1];
  const layers = [...seen].sort((a, b) => order(a) - order(b)).map((l) => ({ id: l, name: l === "F.Cu" ? "Top (F.Cu)" : l === "B.Cu" ? "Bottom (B.Cu)" : l.replace(".Cu", ""), side: l === "F.Cu" ? "T" : l === "B.Cu" ? "B" : "I" }));
  return { parts, pins, segments: segs, traces, vias, zones, layers };
}

/* ============================================================ Eagle XML (.brd) */
function parseEagle(t) {
  const doc = new DOMParser().parseFromString(t, "application/xml");
  const MIL = 1 / 0.0254; const pkgs = new Map(); const parts = [], pins = [], segs = [];
  doc.querySelectorAll("libraries > library").forEach((lib) => {
    const ln = lib.getAttribute("name");
    lib.querySelectorAll("packages > package").forEach((pk) => {
      const pads = [];
      pk.querySelectorAll("smd").forEach((s) => pads.push({ name: s.getAttribute("name"), x: +s.getAttribute("x"), y: +s.getAttribute("y"), r: Math.min(+s.getAttribute("dx") || 0, +s.getAttribute("dy") || 0) / 2, smd: true }));
      pk.querySelectorAll("pad").forEach((s) => pads.push({ name: s.getAttribute("name"), x: +s.getAttribute("x"), y: +s.getAttribute("y"), r: (+s.getAttribute("diameter") || +s.getAttribute("drill") * 1.6 || 0) / 2, smd: false }));
      pkgs.set(ln + "\u0000" + pk.getAttribute("name"), pads);
    });
  });
  const nets = new Map();
  doc.querySelectorAll("signals > signal").forEach((sg) => { const n = sg.getAttribute("name"); sg.querySelectorAll("contactref").forEach((c) => nets.set(c.getAttribute("element") + "\u0000" + c.getAttribute("pad"), n)); });
  doc.querySelectorAll("elements > element").forEach((el) => {
    const pads = pkgs.get(el.getAttribute("library") + "\u0000" + el.getAttribute("package")); if (!pads || !pads.length) return;
    const name = el.getAttribute("name"), x = +el.getAttribute("x"), y = +el.getAttribute("y");
    const rs = el.getAttribute("rot") || "R0"; const mir = /M/.test(rs); const ang = (parseFloat(rs.replace(/[^\d.\-]/g, "")) || 0) * Math.PI / 180;
    const th = pads.every((p) => !p.smd);
    parts.push({ name, side: th ? "BOTH" : mir ? "B" : "T", desc: el.getAttribute("value") || "" }); const pi = parts.length - 1;
    const co = Math.cos(ang), si = Math.sin(ang);
    pads.forEach((p) => {
      const px = mir ? -p.x : p.x; const rx = px * co - p.y * si, ry = px * si + p.y * co;
      pins.push({ part: pi, num: p.name, x: (x + rx) * MIL, y: (y + ry) * MIL, r: p.r ? p.r * MIL : undefined, net: nets.get(name + "\u0000" + p.name) || "" });
    });
  });
  doc.querySelectorAll("plain > wire[layer='20']").forEach((w) => segs.push(["x1", "y1", "x2", "y2"].map((a) => +w.getAttribute(a) * MIL)));
  // copper: signal wires on layers 1 (top) … 16 (bottom), vias, polygon pours (outline as drawn)
  const lname = new Map(); doc.querySelectorAll("layers > layer").forEach((l) => lname.set(+l.getAttribute("number"), l.getAttribute("name")));
  const traces = [], vias = [], zones = [], seen = new Set();
  doc.querySelectorAll("signals > signal").forEach((sg) => {
    const net = sg.getAttribute("name");
    sg.querySelectorAll("wire").forEach((w) => {
      const l = +w.getAttribute("layer"); if (!(l >= 1 && l <= 16)) return; seen.add(l);
      const x1 = +w.getAttribute("x1") * MIL, y1 = +w.getAttribute("y1") * MIL, x2 = +w.getAttribute("x2") * MIL, y2 = +w.getAttribute("y2") * MIL, wd = (+w.getAttribute("width") || 0.15) * MIL;
      const curve = +w.getAttribute("curve") || 0;
      if (curve) { // arc: chord + included angle
        const c = curve * Math.PI / 180, dx = x2 - x1, dy = y2 - y1, ch = Math.hypot(dx, dy), r = ch / 2 / Math.sin(Math.abs(c) / 2), h = Math.sqrt(Math.max(0, r * r - ch * ch / 4)) * Math.sign(c);
        const mx = (x1 + x2) / 2 - dy / ch * h, my = (y1 + y2) / 2 + dx / ch * h; const a0 = Math.atan2(y1 - my, x1 - mx);
        arcSegs(mx, my, r, a0, a0 + c, 10).forEach(([a, b, cc, d]) => traces.push({ x1: a, y1: b, x2: cc, y2: d, w: wd, layer: l, net }));
      } else traces.push({ x1, y1, x2, y2, w: wd, layer: l, net });
    });
    sg.querySelectorAll("via").forEach((v) => vias.push({ x: +v.getAttribute("x") * MIL, y: +v.getAttribute("y") * MIL, r: ((+v.getAttribute("diameter") || (+v.getAttribute("drill") || 0.3) * 2)) * MIL / 2, net }));
    sg.querySelectorAll("polygon").forEach((pg) => { const l = +pg.getAttribute("layer"); if (!(l >= 1 && l <= 16)) return; seen.add(l); zones.push({ layer: l, net, poly: [...pg.querySelectorAll("vertex")].map((v) => [+v.getAttribute("x") * MIL, +v.getAttribute("y") * MIL]) }); });
  });
  const layers = [...seen].sort((a, b) => a - b).map((l) => ({ id: l, name: (l === 1 ? "Top" : l === 16 ? "Bottom" : "Inner " + l) + (lname.get(l) && !/^(Top|Bottom)$/i.test(lname.get(l)) ? " (" + lname.get(l) + ")" : ""), side: l === 1 ? "T" : l === 16 ? "B" : "I" }));
  return { parts, pins, segments: segs, traces, vias, zones, layers };
}

/* ============================================================ IPC-D-356 */
function parseIPC356(t) {
  let scale = 0.1; const alias = new Map(); const recs = [];
  for (const l of lines(t)) {
    if (/^P\s+UNITS\s+CUST\s*0/i.test(l)) scale = 0.1;
    else if (/^P\s+UNITS\s+CUST\s*1/i.test(l) || /^P\s+UNITS\s+SI/i.test(l)) scale = 0.001 / 0.0254;
    else if (/^P\s+UNITS\s+CUST\s*2/i.test(l)) scale = 0.1;
    const nm = l.match(/^P\s+(NNAME\d+)\s+(\S.*)$/); if (nm) alias.set(nm[1], nm[2].trim());
    if (!/^(317|327|367)/.test(l)) continue;
    let net = l.slice(3, 17).trim(); if (alias.has(net)) net = alias.get(net);
    const ref = l.slice(20, 26).trim(); const pin = l.slice(27, 31).trim();
    const m = l.slice(31).replace(/\s+/g, "").match(/A(\d\d)X([+-]?\d+)Y([+-]?\d+)/); if (!m || !ref) continue;
    recs.push({ net: net === "N/C" ? "" : net, ref, pin, acc: +m[1], x: +m[2] * scale, y: +m[3] * scale });
  }
  const maxL = Math.max(1, ...recs.map((r) => r.acc));
  const parts = [], ids = new Map(), pins = [];
  for (const r of recs) {
    if (r.ref === "VIA") continue;
    let pi = ids.get(r.ref); if (pi === undefined) { parts.push({ name: r.ref, side: "T", votes: [0, 0, 0] }); pi = parts.length - 1; ids.set(r.ref, pi); }
    const s = r.acc === 0 ? 2 : r.acc === 1 ? 0 : r.acc === maxL ? 1 : 2; parts[pi].votes[s]++;
    pins.push({ part: pi, num: r.pin, x: r.x, y: r.y, net: r.net });
  }
  parts.forEach((p) => { const [t1, b1, a1] = p.votes; p.side = a1 >= t1 && a1 >= b1 ? "BOTH" : b1 > t1 ? "B" : "T"; delete p.votes; });
  return { parts, pins };
}

/* ============================================================ CSV */
function parseCSV(text) {
  const L = lines(text).filter((l) => l.trim());
  const d = [",", "\t", ";"].sort((a, b) => L[0].split(b).length - L[0].split(a).length)[0];
  const hdr = L[0].split(d).map((s) => s.trim().toLowerCase().replace(/["']/g, ""));
  const f = (...ns) => hdr.findIndex((h) => ns.includes(h));
  const iP = f("part", "refdes", "ref", "designator", "component", "comp"), iN = f("net", "netname", "net_name", "signal"),
    iX = f("x", "pos_x", "x_mils", "x(mils)"), iY = f("y", "pos_y", "y_mils", "y(mils)"), iPin = f("pin", "pin_name", "pin_number", "number", "pad"),
    iS = f("side", "layer", "mount"), iV = f("value", "description", "desc");
  if (iP < 0 || iN < 0 || iX < 0 || iY < 0) throw new Error("CSV needs columns named part, net, x and y (optional: pin, side, value).");
  const map = new Map(), parts = [], pins = [];
  for (let i = 1; i < L.length; i++) {
    const c = L[i].split(d).map((s) => s.trim().replace(/^"|"$/g, ""));
    const pn = c[iP]; if (!pn) continue;
    let pi = map.get(pn);
    if (pi === undefined) { const sd = iS >= 0 ? c[iS] || "" : ""; parts.push({ name: pn, side: /^(b|bot|bottom|2)$/i.test(sd) ? "B" : "T", desc: iV >= 0 ? c[iV] : "" }); pi = parts.length - 1; map.set(pn, pi); }
    pins.push({ x: num(c[iX]), y: num(c[iY]), part: pi, net: c[iN] || "", num: iPin >= 0 ? c[iPin] : "" });
  }
  return { parts, pins };
}

function isAllegroBinary(u8) {
  if (u8.length < 0xfb) return false;
  const s = latin1.decode(u8.subarray(0xf8, 0xfb));
  return s === "all" || s === "vie";
}
