import { parseBoardFiles, NeedKeyError, FORMATS, parseKeyWords, checkRC6Key, parseHexKey64, checkXZZKey } from "./parsers.js";
import { initAssistant } from "./ai.js";
import { initBench } from "./bench.js";

const $ = (s) => document.querySelector(s);
const dpr = () => Math.min(window.devicePixelRatio || 1, 2.5);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- backend ---------------- */
const TOKEN = (document.querySelector('meta[name="tl-token"]') || {}).content || "";
export const hasBackend = !!TOKEN && TOKEN !== "{{TOKEN}}";
export async function api(path, opts = {}) {
  if (!hasBackend) throw new Error("This copy of Trace Lab is running without its desktop backend.");
  const headers = Object.assign({ "X-TL-Token": TOKEN }, opts.headers || {});
  return fetch(path, Object.assign({}, opts, { headers }));
}
export const config = { hasKey: false, provider: "anthropic", model: "claude-sonnet-5-5", base_url: "", xzz_key: "", cae_key: "", keyProviders: {}, theme_mode: "system", accent: "copper" };
async function loadConfig() { if (!hasBackend) return; try { const r = await api("/api/config"); if (r.ok) Object.assign(config, await r.json()); } catch (e) {} }
// Built-in decode keys (e.g. ASUS FZ) are served by the backend at runtime, never shipped in the page.
const builtinKeys = { fz: "", cae: "" };
async function loadBuiltinKeys() { if (!hasBackend) return; try { const r = await api("/api/keys"); if (r.ok) { const k = await r.json(); builtinKeys.fz = k.fz || ""; builtinKeys.cae = k.cae || ""; } } catch (e) {} }

/* ---------------- pdf.js ---------------- */
let pdfjsLib = null;
async function getPdf() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import("../lib/pdf.min.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../lib/pdf.worker.min.mjs", import.meta.url).href;
  return pdfjsLib;
}

/* ---------------- state ---------------- */
export const S = { board: null, sch: null, sel: null, pinSel: -1, side: "T", airwires: true, depth: 2, caps: false, layout: "split",
  tree: [], hl: new Map(), hlSch: new Map(), hitCursor: 0, hoverTok: null, lastError: null };
const bv = { scale: 1, ox: 0, oy: 0, fit: 1 };
const sv = { page: 0, zoom: 1, ox: 0, oy: 0, fit: 1 };
let T = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement), g = (n) => cs.getPropertyValue(n).trim();
  T = { bg: g("--pane"), fill: g("--b-fill"), edge: g("--b-edge"), part: g("--b-part"), pin: g("--b-pin"), gnd: g("--b-gnd"),
    label: g("--b-label"), sel: g("--b-sel"), ink: g("--b-pin-ink"), fg: g("--fg"), muted: g("--muted"), line: g("--line2"),
    nets: [0, 1, 2, 3, 4, 5, 6].map((i) => g("--n" + i)) };
}
const FONT_MONO = getComputedStyle(document.documentElement).getPropertyValue("--f-mono").trim() || "monospace";
const FONT_UI = getComputedStyle(document.documentElement).getPropertyValue("--f-ui").trim() || "sans-serif";

/* ---------------- board model ---------------- */
const vis = (b, p, side) => { const s = p.side || b.parts[p.part].side; return s === side || s === "BOTH"; };
export function finalizeBoard(b) {
  const nets = new Map();
  b.pins.forEach((p, i) => { if (p.net) { if (!nets.has(p.net)) nets.set(p.net, []); nets.get(p.net).push(i); } });
  b.nets = nets;
  const total = b.pins.length;
  b.gnd = new Set();
  for (const [n, arr] of nets) {
    if (/^(A|D|P|S|SGND_|CHASSIS_?)?(GND|VSS|GROUND)([_-].*)?$/i.test(n) || /[_-](GND|VSS)$/i.test(n) || arr.length > Math.max(80, total * 0.12)) b.gnd.add(n);
  }
  // extents from pins + outline
  let ex = [Infinity, Infinity, -Infinity, -Infinity];
  b.pins.forEach((p) => { ex = [Math.min(ex[0], p.x), Math.min(ex[1], p.y), Math.max(ex[2], p.x), Math.max(ex[3], p.y)]; });
  (b.outline || []).forEach((poly) => poly.forEach(([x, y]) => { ex = [Math.min(ex[0], x), Math.min(ex[1], y), Math.max(ex[2], x), Math.max(ex[3], y)]; }));
  const span = Math.max(ex[2] - ex[0], ex[3] - ex[1], 1);
  const rMin = span * 0.00025, rMax = span * 0.012;
  b.parts.forEach((pt) => {
    const ps = pt.pins.map((i) => b.pins[i]); const n = ps.length;
    let md = Infinity; const lim = Math.min(n, 300);
    for (let i = 0; i < lim; i++) for (let j = 0; j < n; j++) { if (i === j) continue; const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y); if (d > 0 && d < md) md = d; }
    let r = isFinite(md) ? md * 0.38 : span * 0.0025;
    r = Math.max(rMin, Math.min(r, rMax));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    ps.forEach((p) => { const rr = p.r > 0 ? Math.max(rMin, Math.min(p.r, r * 1.6, rMax)) : r; p.rr = rr; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    const pad = r * 1.7; pt.bb = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  });
  if (!(b.outline && b.outline.length)) { const m = span * 0.02; b.outline = [[[ex[0] - m, ex[1] - m], [ex[2] + m, ex[1] - m], [ex[2] + m, ex[3] + m], [ex[0] - m, ex[3] + m]]]; b.synthOutline = true; }
  b.ext = [ex[0] - span * 0.03, ex[1] - span * 0.03, ex[2] + span * 0.03, ex[3] + span * 0.03];
  b.span = span; b.cell = Math.max(span / 120, 1e-6);
  b.partByName = new Map(); b.parts.forEach((p, i) => { const k = p.name.toUpperCase(); if (!b.partByName.has(k)) b.partByName.set(k, i); });
  b.netByUpper = new Map([...nets.keys()].map((n) => [n.toUpperCase(), n]));
  b.grid = { T: buildGrid(b, "T"), B: buildGrid(b, "B") };
  b.hasBottom = b.parts.some((p) => p.side === "B");
  return b;
}
function buildGrid(b, side) {
  const g = new Map(), C = b.cell;
  b.pins.forEach((p, i) => { if (!vis(b, p, side)) return; const k = Math.floor(p.x / C) + "," + Math.floor(p.y / C); if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  return g;
}
function hitPin(x, y, tol) {
  const b = S.board; const g = b.grid[S.side]; const C = b.cell; const cx = Math.floor(x / C), cy = Math.floor(y / C);
  const reach = Math.min(6, Math.max(1, Math.ceil(tol / C))); let best = -1, bd = Infinity;
  for (let i = -reach; i <= reach; i++) for (let j = -reach; j <= reach; j++) {
    const a = g.get((cx + i) + "," + (cy + j)); if (!a) continue;
    for (const pi of a) { const p = b.pins[pi]; const d = Math.hypot(p.x - x, p.y - y); if (d <= Math.max(p.rr, tol) && d < bd) { bd = d; best = pi; } }
  }
  return best;
}
function hitPart(x, y) {
  const b = S.board; let best = -1, ba = Infinity;
  b.parts.forEach((p, i) => { if (p.nail || !(p.side === S.side || p.side === "BOTH")) return; const q = p.bb; if (x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]) { const a = (q[2] - q[0]) * (q[3] - q[1]); if (a < ba) { ba = a; best = i; } } });
  return best;
}

/* ---------------- subnets ---------------- */
// Two-pin parts that pass a net through: resistors, inductors, ferrites, fuses, shorting/solder jumpers (incl. Compal/Quanta "P" power prefixes)
const SERIES = new Set(["R", "L", "FB", "F", "FU", "XW", "PF", "FL", "RT", "SH", "PR", "PL", "PJ", "PJP", "JP", "RN", "JS", "SJ"]);
export function isSeries(p, caps = S.caps) {
  if (!p || p.pins.length !== 2 || p.nail) return false;
  const pre = (p.name.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
  return SERIES.has(pre) || (caps && (pre === "C" || pre === "PC"));
}
export function expand(root, depth = S.depth, caps = S.caps) {
  const b = S.board; const out = [{ net: root, depth: 0, via: null, parent: null }];
  if (!b || b.gnd.has(root)) return out;
  const seen = new Set([root]);
  for (let qi = 0; qi < out.length && out.length < 80; qi++) {
    const nd = out[qi]; if (nd.depth >= depth) continue;
    for (const pi of b.nets.get(nd.net) || []) {
      const part = b.parts[b.pins[pi].part]; if (!isSeries(part, caps)) continue;
      const other = part.pins[0] === pi ? part.pins[1] : part.pins[0]; const on = b.pins[other].net;
      if (!on || seen.has(on) || b.gnd.has(on)) continue;
      seen.add(on); out.push({ net: on, depth: nd.depth + 1, via: part.name, viaDesc: part.desc || "", parent: nd.net });
    }
  }
  const kids = new Map(); out.forEach((n) => { if (n.parent !== null) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); } });
  const ord = []; (function walk(n) { ord.push(n); (kids.get(n.net) || []).forEach(walk); })(out[0]);
  ord.forEach((n, i) => (n.color = i === 0 ? 0 : 1 + ((i - 1) % 6)));
  return ord;
}
const mstCache = new Map();
function getMST(net, side) {
  const k = net + "|" + side; if (mstCache.has(k)) return mstCache.get(k);
  const b = S.board; const P = (b.nets.get(net) || []).map((i) => b.pins[i]).filter((p) => vis(b, p, side));
  const n = P.length, edges = [];
  if (n >= 2 && n <= 1500) {
    const inT = new Uint8Array(n), d = new Float64Array(n).fill(Infinity), par = new Int32Array(n).fill(-1); d[0] = 0;
    for (let k2 = 0; k2 < n; k2++) {
      let u = -1, best = Infinity; for (let i = 0; i < n; i++) if (!inT[i] && d[i] < best) { best = d[i]; u = i; }
      if (u < 0) break; inT[u] = 1; if (par[u] >= 0) edges.push([P[par[u]], P[u]]);
      for (let v = 0; v < n; v++) if (!inT[v]) { const dd = (P[u].x - P[v].x) ** 2 + (P[u].y - P[v].y) ** 2; if (dd < d[v]) { d[v] = dd; par[v] = u; } }
    }
  }
  mstCache.set(k, edges); return edges;
}

/* ---------------- selection ---------------- */
const selListeners = new Set();
export function onSelect(fn) { selListeners.add(fn); }
export function select(sel, opt = {}) {
  if (isDirty() && (!sel || sel.type !== "net" || sel.name !== draftNet)) saveDraft(true); // keep unsaved readings
  const { focusBoard = true, focusSch = true, pin = -1 } = opt;
  S.sel = sel; S.pinSel = pin; S.hl = new Map(); S.hlSch = new Map(); S.tree = []; S.hitCursor = 0; mstCache.clear();
  if (sel) {
    if (sel.type === "net" && S.board) { S.tree = expand(sel.name); S.tree.forEach((n) => { S.hl.set(n.net, n.color); S.hlSch.set(n.net.toUpperCase(), n.color); }); }
    else S.hlSch.set(sel.name.toUpperCase(), 0);
  }
  renderInspector(); updatePageSel();
  if (sel && focusBoard && S.board) focusBoardOn(sel.type, sel.name);
  if (sel && focusSch) focusSchOn(sel.name, 0);
  reqB(); reqS();
  selListeners.forEach((f) => { try { f(sel); } catch (e) {} });
}
export function selectByName(name, opts) {
  const b = S.board; const u = String(name).trim().toUpperCase();
  if (b && b.netByUpper.has(u)) { select({ type: "net", name: b.netByUpper.get(u) }, opts); return "net"; }
  if (b && b.partByName.has(u)) { select({ type: "part", name: b.parts[b.partByName.get(u)].name }, opts); return "part"; }
  if (S.sch && S.sch.index.has(u)) { select({ type: "text", name: u }, Object.assign({ focusBoard: false }, opts)); return "text"; }
  return null;
}
function refreshTree() { if (S.sel && S.sel.type === "net") select(S.sel, { focusBoard: false, focusSch: false, pin: S.pinSel }); }

/* ---------------- board view ---------------- */
const bc = $("#bc"), bwrap = $("#bwrap"), btip = $("#btip");
const mir = () => (S.side === "B" ? -1 : 1);
const b2s = (x, y) => [x * bv.scale * mir() + bv.ox, -y * bv.scale + bv.oy];
const s2b = (sx, sy) => [(sx - bv.ox) / (bv.scale * mir()), -(sy - bv.oy) / bv.scale];
export function fitBoard() {
  const b = S.board; if (!b) return; const W = bwrap.clientWidth, H = bwrap.clientHeight; if (!W || !H) return;
  const e = b.ext, w = e[2] - e[0], h = e[3] - e[1];
  bv.scale = bv.fit = Math.min(W / w, H / h) * 0.95;
  const cx = (e[0] + e[2]) / 2, cy = (e[1] + e[3]) / 2;
  bv.ox = W / 2 - cx * bv.scale * mir(); bv.oy = H / 2 + cy * bv.scale; reqB();
}
function zoomBoardTo(bb, frac) {
  const W = bwrap.clientWidth, H = bwrap.clientHeight; if (!W || !H) return;
  const minS = S.board.span * 0.03;
  const w = Math.max(bb[2] - bb[0], minS), h = Math.max(bb[3] - bb[1], minS);
  bv.scale = Math.min(Math.min(W / w, H / h) * frac, bv.fit * 400);
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  bv.ox = W / 2 - cx * bv.scale * mir(); bv.oy = H / 2 + cy * bv.scale; reqB();
}
export function setSide(s, keep = true) {
  if (s === S.side) return;
  const W = bwrap.clientWidth, H = bwrap.clientHeight; const c = s2b(W / 2, H / 2);
  S.side = s; if (keep) bv.ox = W / 2 - c[0] * bv.scale * mir();
  document.querySelectorAll("#sideSeg button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.s === s));
  reqB();
}
export function focusBoardOn(type, name) {
  const b = S.board; if (!b) return;
  if (type === "net") {
    const all = b.nets.get(name) || []; if (!all.length || b.gnd.has(name)) return;
    let on = all.filter((i) => vis(b, b.pins[i], S.side)); if (!on.length) { setSide(S.side === "T" ? "B" : "T", false); on = all; }
    let bb = [Infinity, Infinity, -Infinity, -Infinity]; on.forEach((i) => { const p = b.pins[i]; bb = [Math.min(bb[0], p.x), Math.min(bb[1], p.y), Math.max(bb[2], p.x), Math.max(bb[3], p.y)]; });
    zoomBoardTo(bb, 0.7);
  } else if (type === "part") {
    const i = b.partByName.get(name.toUpperCase()); if (i === undefined) return; const p = b.parts[i];
    if (p.side !== "BOTH" && p.side !== S.side) setSide(p.side, false);
    zoomBoardTo(p.bb, 0.35);
  }
}
let rB = 0; export function reqB() { if (!rB) rB = requestAnimationFrame(() => { rB = 0; drawBoard(); }); }
function sizeCanvas(c, wrap) { const d = dpr(), W = wrap.clientWidth, H = wrap.clientHeight; if (c.width !== Math.round(W * d) || c.height !== Math.round(H * d)) { c.width = Math.round(W * d); c.height = Math.round(H * d); } return [W, H, d]; }
function canvasMsg(ctx, W, H, d, ls) {
  ctx.setTransform(d, 0, 0, d, 0, 0); ctx.textAlign = "center"; ctx.fillStyle = T.muted;
  ls.forEach((l, i) => { ctx.font = (i ? "400 13px " : "600 15px ") + FONT_UI; ctx.fillText(l, W / 2, H / 2 + i * 22 - 10); });
}
function drawBoard() {
  const [W, H, d] = sizeCanvas(bc, bwrap); if (!W || !H) return;
  const ctx = bc.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = T.bg; ctx.fillRect(0, 0, bc.width, bc.height);
  const b = S.board; if (!b) { canvasMsg(ctx, W, H, d, ["No boardview loaded", "Open a boardview, or drop it here"]); return; }
  const sc = bv.scale, mm = mir(), px = 1 / sc, side = S.side;
  ctx.setTransform(d * sc * mm, 0, 0, -d * sc, d * bv.ox, d * bv.oy);
  const a = s2b(0, 0), z = s2b(W, H); const vx0 = Math.min(a[0], z[0]), vx1 = Math.max(a[0], z[0]), vy0 = Math.min(a[1], z[1]), vy1 = Math.max(a[1], z[1]);
  // board outline (all loops, even-odd so cutouts show)
  ctx.beginPath();
  for (const poly of b.outline) { poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); }
  ctx.fillStyle = T.fill; ctx.fill("evenodd"); ctx.lineWidth = 1.5 * px; ctx.strokeStyle = T.edge; if (b.synthOutline) ctx.setLineDash([6 * px, 5 * px]); ctx.stroke(); ctx.setLineDash([]);
  // parts
  const selPart = S.sel && S.sel.type === "part" ? b.partByName.get(S.sel.name.toUpperCase()) : -1;
  const visParts = []; ctx.beginPath();
  b.parts.forEach((p, i) => { if (!(p.side === side || p.side === "BOTH")) return; const q = p.bb; if (q[2] < vx0 || q[0] > vx1 || q[3] < vy0 || q[1] > vy1) return; visParts.push(i); if (!p.nail) ctx.rect(q[0], q[1], q[2] - q[0], q[3] - q[1]); });
  ctx.lineWidth = 1 * px; ctx.strokeStyle = T.part; ctx.globalAlpha = S.sel ? 0.6 : 1; ctx.stroke(); ctx.globalAlpha = 1;
  // airwires
  if (S.airwires) for (const [net, ci] of S.hl) {
    if (b.gnd.has(net)) continue; const ed = getMST(net, side); if (!ed.length) continue;
    ctx.beginPath(); for (const [p, q] of ed) { ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); }
    ctx.strokeStyle = T.nets[ci]; ctx.lineWidth = (ci === 0 ? 1.6 : 1.2) * px; ctx.globalAlpha = 0.8; ctx.stroke(); ctx.globalAlpha = 1;
  }
  // pins
  const pDef = new Path2D(), pGnd = new Path2D(), pHl = new Map(), pSelPart = new Path2D();
  const addPin = (path, p) => { const r = p.rr; if (r * sc < 1.3) path.rect(p.x - r, p.y - r, 2 * r, 2 * r); else { path.moveTo(p.x + r, p.y); path.arc(p.x, p.y, r, 0, Math.PI * 2); } };
  for (const i of visParts) {
    for (const pi of b.parts[i].pins) {
      const p = b.pins[pi]; if (!vis(b, p, side)) continue; const ci = S.hl.get(p.net);
      if (ci !== undefined) { if (!pHl.has(ci)) pHl.set(ci, new Path2D()); addPin(pHl.get(ci), p); }
      else addPin(p.net && b.gnd.has(p.net) ? pGnd : pDef, p);
      if (i === selPart) addPin(pSelPart, p);
    }
  }
  ctx.globalAlpha = S.sel ? 0.42 : 1; ctx.fillStyle = T.gnd; ctx.fill(pGnd); ctx.fillStyle = T.pin; ctx.fill(pDef); ctx.globalAlpha = 1;
  if (selPart >= 0) { ctx.fillStyle = T.pin; ctx.fill(pSelPart); }
  for (const [ci, path] of pHl) { ctx.fillStyle = T.nets[ci]; ctx.fill(path); }
  // highlighted pins that live on the other side
  ctx.lineWidth = 1.3 * px; ctx.setLineDash([3 * px, 2 * px]);
  for (const [net, ci] of S.hl) {
    const arr = b.nets.get(net); if (!arr || arr.length > 3000) continue; const g = new Path2D(); let any = false;
    for (const pi of arr) { const p = b.pins[pi]; if (vis(b, p, side) || p.x < vx0 - 50 || p.x > vx1 + 50 || p.y < vy0 - 50 || p.y > vy1 + 50) continue; g.moveTo(p.x + p.rr, p.y); g.arc(p.x, p.y, p.rr, 0, Math.PI * 2); any = true; }
    if (any) { ctx.strokeStyle = T.nets[ci]; ctx.globalAlpha = 0.6; ctx.stroke(g); ctx.globalAlpha = 1; }
  }
  ctx.setLineDash([]);
  if (selPart >= 0) { const sp = b.parts[selPart]; if (sp.side === side || sp.side === "BOTH") { const q = sp.bb; ctx.strokeStyle = T.sel; ctx.lineWidth = 2 * px; ctx.strokeRect(q[0], q[1], q[2] - q[0], q[3] - q[1]); } }
  if (S.pinSel >= 0) { const p = b.pins[S.pinSel]; if (p && vis(b, p, side)) { ctx.beginPath(); ctx.arc(p.x, p.y, p.rr + 3 * px, 0, Math.PI * 2); ctx.strokeStyle = T.sel; ctx.lineWidth = 2 * px; ctx.stroke(); } }
  // labels
  ctx.setTransform(d, 0, 0, d, 0, 0); ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const i of visParts) for (const pi of b.parts[i].pins) {
    const p = b.pins[pi]; const rs = p.rr * sc; if (rs < 13 || !p.net || !vis(b, p, side)) continue;
    const fs = Math.min(11, rs * 0.45); const maxc = Math.max(3, Math.floor(rs * 1.8 / (fs * 0.6))); const t = p.net.length > maxc ? p.net.slice(0, maxc - 1) + "…" : p.net;
    const [x, y] = b2s(p.x, p.y); ctx.font = `500 ${fs}px ${FONT_MONO}`; ctx.fillStyle = T.ink; ctx.fillText(t, x, y);
  }
  for (const i of visParts) {
    const p = b.parts[i]; if (p.nail) continue; const [x0, y0] = b2s(p.bb[0], p.bb[1]), [x1, y1] = b2s(p.bb[2], p.bb[3]);
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0); const fs = Math.min(15, h * 0.42, w / (p.name.length * 0.64)); if (fs < 7.5) continue;
    ctx.font = `600 ${fs}px ${FONT_MONO}`; ctx.fillStyle = i === selPart ? T.sel : T.label; ctx.globalAlpha = S.sel && i !== selPart ? 0.75 : 1;
    ctx.fillText(p.name, (x0 + x1) / 2, (y0 + y1) / 2); ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left"; ctx.font = "600 11px " + FONT_UI; ctx.fillStyle = T.muted; ctx.fillText(side === "B" ? "BOTTOM · MIRRORED" : "TOP", 10, H - 12);
}

/* ---------------- schematic view ---------------- */
const scv = $("#sc"), swrap = $("#swrap"), stip = $("#stip");
let rS = 0; export function reqS() { if (!rS) rS = requestAnimationFrame(() => { rS = 0; drawSch(); }); }
const SR = { base: null, hi: null, baseJob: -1, hiTask: null, t: 0 };
function resetSR() { SR.base = null; SR.hi = null; SR.baseJob = -1; if (SR.hiTask) { try { SR.hiTask.cancel(); } catch (e) {} } SR.hiTask = null; }
export function fitSch() {
  const sch = S.sch; if (!sch) return; const pg = sch.pages[sv.page]; const W = swrap.clientWidth, H = swrap.clientHeight; if (!W || !H) return;
  sv.zoom = sv.fit = Math.min(W / pg.w, H / pg.h) * 0.96; sv.ox = (W - pg.w * sv.zoom) / 2; sv.oy = (H - pg.h * sv.zoom) / 2; reqS();
}
export function gotoPage(i, fit = true) {
  const sch = S.sch; if (!sch) return; i = Math.max(0, Math.min(sch.pages.length - 1, i));
  if (i !== sv.page) { sv.page = i; SR.hi = null; }
  $("#pageSel").value = String(i); if (fit) fitSch(); reqS();
}
function updatePageSel() {
  const sel = $("#pageSel"); const sch = S.sch; if (!sch) { sel.innerHTML = ""; return; }
  const counts = new Array(sch.pages.length).fill(0);
  for (const name of S.hlSch.keys()) for (const t of sch.index.get(name) || []) counts[t.page]++;
  sel.innerHTML = sch.pages.map((p, i) => `<option value="${i}">${i + 1} / ${sch.pages.length}${counts[i] ? " · " + counts[i] + " hit" + (counts[i] > 1 ? "s" : "") : ""}</option>`).join("");
  sel.value = String(sv.page);
}
export function renderRegion(pi, sc, px, py, cw, ch) {
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const task = S.sch.pages[pi].render(c, sc, px, py);
  return { task, promise: task.promise.then(() => c, (e) => { if (!(e && e.name === "RenderingCancelledException")) console.warn(e); return null; }) };
}
function schNeeds() {
  const sch = S.sch; if (!sch) return; const pi = sv.page, pg = sch.pages[pi], d = dpr(); const big = Math.max(pg.w, pg.h);
  if ((!SR.base || SR.base.page !== pi) && SR.baseJob !== pi) {
    SR.baseJob = pi; const sc = Math.min(2.2, 2600 / big); const job = renderRegion(pi, sc, 0, 0, Math.ceil(pg.w * sc), Math.ceil(pg.h * sc));
    job.promise.then((c) => { if (SR.baseJob === pi) SR.baseJob = -1; if (c && S.sch === sch) { SR.base = { c, page: pi, scale: sc }; reqS(); } });
    return;
  }
  if (!SR.base || SR.base.page !== pi) return;
  const want = Math.min(sv.zoom * d, 12);
  if (want <= SR.base.scale * 1.15) return;
  const W = swrap.clientWidth, H = swrap.clientHeight;
  const x0 = Math.max(0, -sv.ox / sv.zoom), y0 = Math.max(0, -sv.oy / sv.zoom), x1 = Math.min(pg.w, (W - sv.ox) / sv.zoom), y1 = Math.min(pg.h, (H - sv.oy) / sv.zoom);
  if (x1 <= x0 || y1 <= y0) return;
  const hi = SR.hi;
  if (hi && hi.page === pi && Math.abs(Math.log(want / hi.scale)) < 0.33 && x0 >= hi.x0 && y0 >= hi.y0 && x1 <= hi.x1 && y1 <= hi.y1) return;
  clearTimeout(SR.t);
  SR.t = setTimeout(() => {
    if (S.sch !== sch || sv.page !== pi) return;
    const mx = (x1 - x0) * 0.3, my = (y1 - y0) * 0.3;
    let rx0 = Math.max(0, x0 - mx), ry0 = Math.max(0, y0 - my), rx1 = Math.min(pg.w, x1 + mx), ry1 = Math.min(pg.h, y1 + my);
    const cw = Math.min(4096, Math.ceil((rx1 - rx0) * want)), ch = Math.min(4096, Math.ceil((ry1 - ry0) * want));
    rx1 = rx0 + cw / want; ry1 = ry0 + ch / want;
    if (SR.hiTask) { try { SR.hiTask.cancel(); } catch (e) {} }
    const job = renderRegion(pi, want, rx0 * want, ry0 * want, cw, ch); SR.hiTask = job.task;
    job.promise.then((c) => { if (c && S.sch === sch) { SR.hi = { c, page: pi, scale: want, x0: rx0, y0: ry0, x1: rx1, y1: ry1 }; reqS(); } });
  }, 140);
}
function drawSch() {
  const [W, H, d] = sizeCanvas(scv, swrap); if (!W || !H) return;
  const ctx = scv.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = T.bg; ctx.fillRect(0, 0, scv.width, scv.height);
  const sch = S.sch; if (!sch) { canvasMsg(ctx, W, H, d, ["No schematic loaded", "Open a schematic PDF, or drop it here"]); return; }
  const pg = sch.pages[sv.page]; ctx.setTransform(d, 0, 0, d, 0, 0);
  const x = sv.ox, y = sv.oy, w = pg.w * sv.zoom, h = pg.h * sv.zoom;
  ctx.save(); ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 14; ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, w, h); ctx.restore();
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  if (SR.base && SR.base.page === sv.page) ctx.drawImage(SR.base.c, x, y, w, h);
  const hi = SR.hi; if (hi && hi.page === sv.page && SR.base && sv.zoom * d > SR.base.scale * 1.15) ctx.drawImage(hi.c, x + hi.x0 * sv.zoom, y + hi.y0 * sv.zoom, (hi.x1 - hi.x0) * sv.zoom, (hi.y1 - hi.y0) * sv.zoom);
  for (const [name, ci] of S.hlSch) for (const t of sch.index.get(name) || []) {
    if (t.page !== sv.page) continue;
    const pad = 1.5; const rx = x + (t.x - pad) * sv.zoom, ry = y + (t.y - pad) * sv.zoom, rw = (t.w + pad * 2) * sv.zoom, rh = (t.h + pad * 2) * sv.zoom;
    ctx.globalAlpha = 0.3; ctx.fillStyle = T.nets[ci]; ctx.fillRect(rx, ry, rw, rh); ctx.globalAlpha = 1;
    ctx.lineWidth = 2; ctx.strokeStyle = T.nets[ci]; ctx.strokeRect(rx, ry, rw, rh);
    if (rw < 10) { ctx.beginPath(); ctx.arc(rx + rw / 2, ry + rh / 2, 9, 0, Math.PI * 2); ctx.stroke(); }
  }
  const ht = S.hoverTok; if (ht && ht.page === sv.page) { ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = "#5a6b70"; ctx.strokeRect(x + (ht.x - 1.5) * sv.zoom, y + (ht.y - 1.5) * sv.zoom, (ht.w + 3) * sv.zoom, (ht.h + 3) * sv.zoom); ctx.setLineDash([]); }
  schNeeds();
}
function tokAt(sx, sy) {
  const sch = S.sch; if (!sch) return null; const px = (sx - sv.ox) / sv.zoom, py = (sy - sv.oy) / sv.zoom; const tol = 3 / sv.zoom + 1;
  let best = null, ba = Infinity;
  for (const t of sch.pages[sv.page].tokens) if (px >= t.x - tol && px <= t.x + t.w + tol && py >= t.y - tol && py <= t.y + t.h + tol) { const a = t.w * t.h; if (a < ba) { ba = a; best = t; } }
  return best;
}
export function sortedHits(name) { return ((S.sch && S.sch.index.get(String(name).toUpperCase())) || []).slice().sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x); }
export function focusSchOn(name, k, explicit) {
  const sch = S.sch; if (!sch) return false; const hits = sortedHits(name); if (!hits.length) return false;
  let t;
  if (k === 0 && !explicit) { t = hits.find((h) => h.page === sv.page) || hits[0]; S.hitCursor = hits.indexOf(t); }
  else { S.hitCursor = ((k % hits.length) + hits.length) % hits.length; t = hits[S.hitCursor]; }
  const pageChanged = t.page !== sv.page; if (pageChanged) gotoPage(t.page, true);
  const W = swrap.clientWidth, H = swrap.clientHeight;
  const target = Math.max(sv.fit * 2.2, 16 / Math.max(t.h, 4));
  if (pageChanged || sv.zoom < target * 0.55 || sv.zoom > target * 4) sv.zoom = Math.min(target, 40);
  sv.ox = W / 2 - (t.x + t.w / 2) * sv.zoom; sv.oy = H / 2 - (t.y + t.h / 2) * sv.zoom; reqS(); return true;
}

/* ---------------- PDF loading ---------------- */
function tokenizeItems(items, vt, page, out, Util) {
  for (const it of items) {
    const s = it.str; if (!s || !s.trim()) continue;
    const tx = Util.transform(vt, it.transform);
    const ul = Math.hypot(tx[0], tx[1]) || 1, dx = tx[0] / ul, dy = tx[1] / ul, vx = tx[2], vy = tx[3], ox = tx[4], oy = tx[5], Wd = it.width || ul * s.length * 0.55;
    const re = /[^\s,;()]+/g; let m;
    while ((m = re.exec(s))) {
      const raw = m[0].replace(/^[^\w+\-#\[\/]+/, "").replace(/[^\w+\-#\]]+$/, ""); if (!raw) continue;
      const a = m.index / s.length, e = (m.index + m[0].length) / s.length;
      const xs = [ox + dx * Wd * a, ox + dx * Wd * e], ys = [oy + dy * Wd * a, oy + dy * Wd * e]; xs.push(xs[0] + vx, xs[1] + vx); ys.push(ys[0] + vy, ys[1] + vy);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      out.push({ t: raw.toUpperCase(), raw, x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0), page });
    }
  }
}
function buildIndex(pages) { const idx = new Map(); pages.forEach((p) => p.tokens.forEach((t) => { if (!idx.has(t.t)) idx.set(t.t, []); idx.get(t.t).push(t); })); return idx; }
async function loadPdf(bytes, name) {
  const lib = await getPdf();
  const prog = $("#sprog"); prog.hidden = false; prog.textContent = "Opening PDF…";
  const base = new URL("../lib/", import.meta.url).href;
  const pdf = await lib.getDocument({ data: bytes, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/", wasmUrl: base + "wasm/" }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i); const vp = page.getViewport({ scale: 1 }); const tokens = [];
    try { const tc = await page.getTextContent(); tokenizeItems(tc.items, vp.transform, i - 1, tokens, lib.Util); } catch (e) { console.warn(e); }
    pages.push({ w: vp.width, h: vp.height, tokens, render: (c, sc, px, py) => page.render({ canvas: c, canvasContext: c.getContext("2d"), viewport: page.getViewport({ scale: sc, offsetX: -px, offsetY: -py }) }) });
    if (i % 4 === 0 || i === pdf.numPages) prog.textContent = `Indexing text · page ${i} of ${pdf.numPages}`;
  }
  prog.hidden = true;
  const nTok = pages.reduce((a, p) => a + p.tokens.length, 0);
  return { name, pages, index: buildIndex(pages), noText: nTok === 0 };
}

/* ---------------- sample board + schematic ---------------- */
function buildSample() {
  const parts = [], pins = [];
  const add = (name, side, x, y, pads, nets, desc = "") => { const p = { name, side, desc, pins: [] }; pads.forEach((d, i) => { pins.push({ x: x + d[0], y: y + d[1], part: parts.length, net: nets[i] || "", num: String(i + 1) }); p.pins.push(pins.length - 1); }); parts.push(p); };
  const two = (len, vert) => (vert ? [[0, len / 2], [0, -len / 2]] : [[-len / 2, 0], [len / 2, 0]]);
  const row = (n, pitch) => Array.from({ length: n }, (_, i) => [0, ((n - 1) / 2 - i) * pitch]);
  const qfn = (n, body, pitch) => { const per = n / 4, h = body / 2, o = (per - 1) / 2 * pitch, a = [];
    for (let i = 0; i < per; i++) a.push([-h, o - i * pitch]); for (let i = 0; i < per; i++) a.push([-o + i * pitch, -h]);
    for (let i = 0; i < per; i++) a.push([h, -o + i * pitch]); for (let i = 0; i < per; i++) a.push([o - i * pitch, h]); a.push([0, 0]); return a; };
  const sot5 = [[-37, -50], [0, -50], [37, -50], [37, 50], [-37, 50]];
  const G = "GND";
  add("J1", "T", 140, 1300, row(12, 48), [G, "PPVBUS_USBC", "USBC_CC1", "USB_DP", "USB_DN", "", "", "USB_DN", "USB_DP", "USBC_CC2", "PPVBUS_USBC", G], "USB-C RECEPTACLE");
  add("F1", "T", 560, 1700, two(120), ["PPVBUS_USBC", "PPVBUS_F"], "FUSE 3A");
  add("R1", "T", 860, 1700, two(100), ["PPVBUS_F", "PPDCIN"], "0.005R 1% SENSE");
  add("C1", "T", 1060, 1880, two(50, true), ["PPDCIN", G], "22UF 25V");
  add("C2", "T", 1140, 1880, two(50, true), ["PPDCIN", G], "22UF 25V");
  add("R14", "T", 420, 1000, two(40, true), ["USBC_CC1", G], "5.1K");
  add("R15", "T", 500, 1000, two(40, true), ["USBC_CC2", G], "5.1K");
  add("TP3", "T", 1000, 1520, [[0, 0]], ["PPDCIN"]);
  add("U1", "T", 1450, 1300, qfn(24, 200, 26), ["PPDCIN", "PPDCIN", "PMIC_SW", "PMIC_SW", "PMIC_BST", G, "PMIC_FB", "PMIC_COMP", "PMIC_EN", "I2C_SDA_PMIC", "I2C_SCL_PMIC", "PMIC_PG", "PP3V3_S5", "PMIC_ILIM", "", "USBC_CC1", "USBC_CC2", G, "PMIC_VCC", "PMIC_VCC", "", "PPDCIN", G, G, G], "BUCK CONTROLLER 3V3");
  add("C3", "T", 1450, 1060, two(40), ["PMIC_BST", "PMIC_SW"], "0.1UF");
  add("C11", "T", 1250, 1060, two(40), ["PMIC_VCC", G], "1UF");
  add("R16", "T", 1250, 980, two(40), ["PMIC_COMP", "PMIC_COMP_R"], "10K");
  add("C12", "T", 1170, 980, two(40, true), ["PMIC_COMP_R", G], "4.7NF");
  add("L1", "T", 1820, 1300, two(220, true), ["PMIC_SW", "PP3V3_S5"], "2.2UH");
  add("C4", "T", 2020, 1520, two(60, true), ["PP3V3_S5", G], "47UF");
  add("C5", "T", 2100, 1520, two(60, true), ["PP3V3_S5", G], "47UF");
  add("R2", "T", 1650, 1640, two(40), ["PP3V3_S5", "PMIC_FB"], "100K");
  add("R3", "T", 1650, 1720, two(40), ["PMIC_FB", G], "22.1K");
  add("R4", "T", 1250, 1640, two(40), ["PMIC_ILIM", G], "47K");
  add("TP1", "T", 2050, 1050, [[0, 0]], ["PP3V3_S5"]);
  add("R5", "T", 2300, 1350, two(40), ["PP3V3_S5", "PP3V3_EC"], "0R");
  add("FB1", "T", 2300, 1750, two(60), ["PP3V3_S5", "PP3V3_HUB"], "120R@100MHZ");
  add("U2", "T", 2950, 1300, qfn(32, 280, 30), ["PP3V3_EC", G, "EC_SDA", "EC_SCL", "EC_RST_L", "EC_PMIC_EN", "PMIC_PG", "EC_PWRBTN_L", "USB_DP", "USB_DN", "LED_PWR_R", "", "PP1V8_EC", G, "", "", "EC_UART_TX", "EC_UART_RX", "", "", "", "", "", "PP3V3_EC", "", "", "", "", "", "", G, "", G], "EC MCU");
  add("R6", "T", 2600, 1060, two(40), ["I2C_SDA_PMIC", "EC_SDA"], "33R");
  add("R7", "T", 2600, 990, two(40), ["I2C_SCL_PMIC", "EC_SCL"], "33R");
  add("R8", "B", 2450, 1050, two(40, true), ["PP3V3_EC", "I2C_SDA_PMIC"], "2.2K");
  add("R9", "B", 2520, 1050, two(40, true), ["PP3V3_EC", "I2C_SCL_PMIC"], "2.2K");
  add("R10", "T", 2600, 1580, two(40), ["PMIC_EN", "EC_PMIC_EN"], "0R");
  add("R11", "T", 3300, 1600, two(40, true), ["PP3V3_EC", "EC_RST_L"], "10K");
  add("C6", "T", 3380, 1600, two(40, true), ["EC_RST_L", G], "0.1UF");
  add("U3", "T", 2650, 2050, sot5, ["PP3V3_EC", G, "PP3V3_EC", "", "PP1V8_EC"], "LDO 1V8");
  add("C7", "T", 2850, 2050, two(40, true), ["PP1V8_EC", G], "1UF");
  add("TP2", "T", 2850, 2250, [[0, 0]], ["PP1V8_EC"]);
  add("C8", "B", 2900, 1300, two(40, true), ["PP3V3_EC", G], "0.1UF");
  add("C9", "B", 3010, 1300, two(60, true), ["PP3V3_EC", G], "10UF");
  add("C10", "B", 1450, 1300, two(40, true), ["PPDCIN", G], "0.1UF");
  add("TP4", "B", 3450, 1900, [[0, 0]], ["EC_RST_L"]);
  add("R12", "T", 3400, 900, two(40), ["LED_PWR_R", "LED_PWR_A"], "1K");
  add("D1", "T", 3600, 900, two(60), ["LED_PWR_A", G], "GREEN LED");
  add("SW1", "T", 3700, 1900, two(240), ["EC_PWRBTN_L", G], "POWER BUTTON");
  add("R13", "T", 3500, 2100, two(40, true), ["PP3V3_EC", "EC_PWRBTN_L"], "100K");
  add("J2", "T", 3950, 700, row(4, 100), ["PP3V3_EC", "EC_UART_TX", "EC_UART_RX", G], "DEBUG UART");
  add("J3", "BOTH", 3950, 1500, row(4, 100), ["PP3V3_HUB", "I2C_SDA_PMIC", "I2C_SCL_PMIC", G], "SENSOR HEADER (TH)");
  [[260, 240], [3960, 240], [3960, 2360], [260, 2360]].forEach((p, i) => add("MH" + (i + 1), "BOTH", p[0], p[1], [[0, 0]], [G]));
  const b = finalizeBoard({ name: "sample_usbc_power.brd", format: "Sample", outline: [[[0, 0], [4200, 0], [4200, 2600], [700, 2600], [700, 2420], [0, 2420]]], parts, pins });
  b.sample = true; return b;
}
function buildSampleSchematic(b) {
  const defs = [["POWER INPUT AND 3V3 BUCK", ["U1", "J1", "F1", "R1", "C1", "C2", "C10", "TP3", "R14", "R15", "C3", "C11", "R16", "C12", "L1", "C4", "C5", "R2", "R3", "R4", "TP1"]],
    ["EC, I2C AND RAILS", ["U2", "J2", "J3", "R5", "FB1", "R6", "R7", "R8", "R9", "R10", "R11", "C6", "TP4", "U3", "C7", "C8", "C9", "TP2", "R12", "D1", "SW1", "R13"]]];
  const PW = 1224, PH = 792, CH = 0.6; const pages = [];
  defs.forEach(([title, names], pgi) => {
    const ops = [], tokens = [];
    const text = (s, x, y, size, o = {}) => { const w = s.length * size * CH; const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
      ops.push({ k: "T", s, x: left, y, size, bold: o.bold, color: o.color }); if (o.reg) tokens.push({ t: s.toUpperCase(), raw: s, x: left, y: y - size * 0.82, w, h: size * 1.02, page: pgi }); return w; };
    const line = (pts, w = 1) => ops.push({ k: "L", pts, w });
    const netLabel = (s, x, y, right) => { if (!s) { text("NC", x, y + 3, 8, { align: right ? "left" : "right", color: "#8a9599" }); return; } text(s, x, y + 3, 9, { align: right ? "left" : "right", reg: true, color: "#1e4fa0" }); };
    let cx = 60, cy = 70, colW = 0; const maxY = PH - 120;
    const place = (w, h) => { if (cy + h > maxY) { cy = 70; cx += colW + 36; colW = 0; } const pos = [cx, cy]; cy += h + 22; colW = Math.max(colW, w); return pos; };
    const lw = (s) => (s ? s.length : 2) * 9 * CH;
    for (const nm of names) {
      const pi = b.partByName.get(nm); if (pi === undefined) continue; const part = b.parts[pi]; const pn = part.pins.map((i) => b.pins[i]);
      const pre = (nm.match(/^[A-Z]+/) || [""])[0]; const val = (part.desc || "").split(" ")[0];
      if (pn.length === 2) {
        const L = lw(pn[0].net), R = lw(pn[1].net), w = L + R + 6 + 22 + 44 + 22 + 6, h = 46; const [x, y] = place(w, h);
        const mx = x + L + 6 + 22 + 22, my = y + 24;
        line([[x + L + 6, my], [mx - 22, my]]); line([[mx + 22, my], [mx + 22 + 22, my]]);
        sym(pre, mx, my, line, ops);
        netLabel(pn[0].net, x + L + 3, my, false); netLabel(pn[1].net, mx + 44 + 3, my, true);
        text(nm, mx, my - 14, 10, { align: "center", bold: true, reg: true, color: "#111" }); if (val) text(val, mx, my + 20, 8, { align: "center", color: "#4b5a5f" });
      } else if (pn.length === 1) {
        const L = lw(pn[0].net), w = L + 6 + 30 + 12, h = 30; const [x, y] = place(w, h); const my = y + 16;
        line([[x + L + 6, my], [x + L + 30, my]]); ops.push({ k: "C", x: x + L + 35, y: my, r: 5 });
        netLabel(pn[0].net, x + L + 3, my, false); text(nm, x + L + 35, my - 10, 10, { align: "center", bold: true, reg: true, color: "#111" });
      } else {
        const conn = pre === "J"; const n = pn.length; const ln = conn ? 0 : Math.ceil(n / 2), rn = n - ln;
        const left = pn.slice(0, ln), right = pn.slice(ln); const Lm = Math.max(0, ...left.map((p) => lw(p.net))), Rm = Math.max(0, ...right.map((p) => lw(p.net)));
        const bw = conn ? 44 : 104, rows = Math.max(ln, rn), bh = rows * 15 + 14;
        const w = (ln ? Lm + 6 + 26 : 0) + bw + 26 + 6 + Rm, h = bh + 28; const [x, y] = place(w, h);
        const bx = x + (ln ? Lm + 6 + 26 : 0), by = y + 20;
        ops.push({ k: "R", x: bx, y: by, w: bw, h: bh });
        text(nm, bx, by - 6, 10, { bold: true, reg: true, color: "#111" }); text(part.desc || "", bx + bw, by - 6, 7, { align: "right", color: "#4b5a5f" });
        left.forEach((p, i) => { const yy = by + 14 + i * 15; line([[bx - 26, yy], [bx, yy]]); text(p.num, bx + 4, yy + 3, 7, { color: "#4b5a5f" }); netLabel(p.net, bx - 29, yy, false); });
        right.forEach((p, i) => { const yy = by + 14 + i * 15; line([[bx + bw, yy], [bx + bw + 26, yy]]); text(p.num, bx + bw - 4, yy + 3, 7, { align: "right", color: "#4b5a5f" }); netLabel(p.net, bx + bw + 29, yy, true); });
      }
    }
    ops.push({ k: "R", x: 20, y: 20, w: PW - 40, h: PH - 40, w2: 1.4 });
    ops.push({ k: "R", x: PW - 360, y: PH - 90, w: 340, h: 70, w2: 1.2 });
    text(title, PW - 350, PH - 62, 11, { bold: true, color: "#111" });
    text(`SAMPLE BOARD · SHEET ${pgi + 1} OF ${defs.length}`, PW - 350, PH - 42, 8, { color: "#4b5a5f" });
    text("TRACE LAB DEMO SCHEMATIC", PW - 350, PH - 28, 8, { color: "#4b5a5f" });
    pages.push({ w: PW, h: PH, tokens, render: (c, sc, px, py) => { const ctx = c.getContext("2d"); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.setTransform(sc, 0, 0, sc, -px, -py); drawOps(ctx, ops); return { promise: Promise.resolve(), cancel() {} }; } });
  });
  return { name: "sample_schematic.pdf", pages, index: buildIndex(pages), sample: true };
}
function sym(pre, x, y, line, ops) {
  const l = x - 22, r = x + 22;
  if (pre === "R") { const pts = [[l, y]]; for (let i = 0; i < 6; i++) pts.push([l + 3.67 + i * 7.33, y + (i % 2 ? 5 : -5)]); pts.push([r, y]); line(pts, 1.2); }
  else if (pre === "C") { line([[l, y], [x - 4, y]]); line([[x + 4, y], [r, y]]); line([[x - 4, y - 9], [x - 4, y + 9]], 1.6); line([[x + 4, y - 9], [x + 4, y + 9]], 1.6); }
  else if (pre === "L") { const pts = [[l, y]]; for (let k = 0; k < 4; k++) for (let a = 0; a <= 8; a++) { const t = Math.PI * a / 8; pts.push([l + k * 11 + 5.5 - 5.5 * Math.cos(t), y - 5.5 * Math.sin(t)]); } pts.push([r, y]); line(pts, 1.2); }
  else if (pre === "D") { line([[l, y], [x - 7, y]]); line([[x + 7, y], [r, y]]); line([[x - 7, y - 7], [x - 7, y + 7], [x + 7, y], [x - 7, y - 7]], 1.2); line([[x + 7, y - 7], [x + 7, y + 7]], 1.4); }
  else if (pre === "SW") { line([[l, y], [x - 10, y]]); line([[x + 10, y], [r, y]]); ops.push({ k: "C", x: x - 10, y, r: 2 }); ops.push({ k: "C", x: x + 10, y, r: 2 }); line([[x - 9, y - 2], [x + 9, y - 9]], 1.2); }
  else { ops.push({ k: "R", x: x - 15, y: y - 5, w: 30, h: 10 }); line([[l, y], [x - 15, y]]); line([[x + 15, y], [r, y]]); if (pre === "F") line([[x - 15, y], [x + 15, y]], 0.8); }
}
function drawOps(ctx, ops) {
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1d2b30"; ctx.textBaseline = "alphabetic";
  for (const o of ops) {
    if (o.k === "L") { ctx.beginPath(); o.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.lineWidth = o.w; ctx.stroke(); }
    else if (o.k === "R") { ctx.lineWidth = o.w2 || 1.2; ctx.strokeRect(o.x, o.y, o.w, o.h); }
    else if (o.k === "C") { ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2); ctx.lineWidth = 1.2; ctx.stroke(); }
    else if (o.k === "T") { ctx.font = `${o.bold ? 600 : 400} ${o.size}px Consolas, "Cascadia Mono", monospace`; ctx.fillStyle = o.color || "#1d2b30"; ctx.fillText(o.s, o.x, o.y); }
  }
}

/* ---------------- readings (per board, per net) ---------------- */
// Backed by the desktop database so good/bad values persist across sessions and boards.
// Falls back to localStorage when running without the backend (plain browser preview).
const rKey = () => "tl.readings." + (S.board ? S.board.name : "none");
let readingsCache = {};
let readingsBoard = null;
export function getReadings() { return readingsCache; }
async function loadReadings() {
  const name = S.board ? S.board.name : null; readingsBoard = name; readingsCache = {};
  if (!name) return;
  if (hasBackend) {
    try { const r = await api("/api/readings?board=" + encodeURIComponent(name)); if (r.ok) readingsCache = await r.json(); } catch (e) {}
  } else {
    try { readingsCache = JSON.parse(localStorage.getItem(rKey()) || "{}"); } catch (e) {}
  }
  if (S.sel && S.sel.type === "net") renderInspector();
}
// Edits go into a draft for the selected net; "Save to database" writes it and confirms.
// Moving to another net with unsaved edits saves them automatically so nothing is lost.
let draft = null, draftNet = null, draftBoard = null, lastSave = { net: null, ok: false, msg: "" };
const FIELDS = ["status", "diode", "volts", "ohms", "note"];
const sameReading = (a, b) => FIELDS.every((f) => (a[f] || "") === (b[f] || ""));
function draftFor(net) { if (draftNet !== net || draftBoard !== (S.board && S.board.name)) { draftNet = net; draftBoard = S.board && S.board.name; draft = Object.assign({}, readingsCache[net] || {}); } return draft; }
const isDirty = () => draft && draftNet && !sameReading(draft, readingsCache[draftNet] || {});
export const fmtTime = (t) => { if (!t) return ""; const d = new Date(t < 1e12 ? t * 1000 : t); return d.toLocaleDateString() === new Date().toLocaleDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(); };
async function saveDraft(quietNet) {
  if (!draft || !draftNet || !draftBoard) return false;
  const net = draftNet, board = draftBoard, rec = Object.assign({}, draft);
  const payload = { board, net }; FIELDS.forEach((f) => (payload[f] = (rec[f] || "").trim ? (rec[f] || "").trim() : rec[f] || ""));
  try {
    if (hasBackend) {
      const r = await api("/api/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
      if (board === (S.board && S.board.name)) { if (j.deleted) delete readingsCache[net]; else readingsCache[net] = Object.assign({}, j.saved); }
      lastSave = { net, ok: true, msg: j.deleted ? "Readings cleared" : "Saved to database", at: Date.now() };
      toast(j.deleted ? `Cleared readings for ${net}.` : `Saved ${net}${rec.status === "good" ? " as known good" : rec.status === "bad" ? " as a fault" : ""} to the readings database (${j.total} reading${j.total === 1 ? "" : "s"} stored).`);
    } else {
      if (sameReading(rec, {})) delete readingsCache[net]; else readingsCache[net] = Object.assign({ updated: Date.now() }, rec);
      try { localStorage.setItem(rKey(), JSON.stringify(readingsCache)); } catch (e) {}
      lastSave = { net, ok: true, msg: "Saved in this browser", at: Date.now() };
    }
    if (quietNet !== true && draftNet === net) draft = Object.assign({}, readingsCache[net] || {});
    return true;
  } catch (e) {
    lastSave = { net, ok: false, msg: "Not saved: " + e.message };
    toast(`${net} was NOT saved: ${e.message}`);
    return false;
  } finally { if (S.sel && S.sel.type === "net" && S.sel.name === net) updateReadingState(); }
}
function updateReadingState() {
  const el = $("#rdState"), btn = $("#rdSave"); if (!el || !S.sel) return;
  const net = S.sel.name, saved = readingsCache[net], dirty = isDirty() && draftNet === net;
  if (dirty) { el.className = "rdstate dirty"; el.textContent = "Unsaved changes"; }
  else if (lastSave.net === net && !lastSave.ok) { el.className = "rdstate bad"; el.textContent = lastSave.msg; }
  else if (saved) { el.className = "rdstate ok"; el.textContent = `✓ Saved to database · ${fmtTime(saved.updated)}`; }
  else { el.className = "rdstate"; el.textContent = "Nothing saved for this net yet"; }
  if (btn) { btn.disabled = !dirty; btn.classList.toggle("primary", dirty); }
}

// Save one or more fields for a net without touching the others (used by Flux's probe requests).
export async function saveReadingFor(net, patch) {
  const board = S.board && S.board.name; if (!board || !hasBackend) return { ok: false };
  const base = Object.assign({}, readingsCache[net] || {}, patch); const payload = { board, net };
  FIELDS.forEach((f) => (payload[f] = String(base[f] || "").trim()));
  try {
    const r = await api("/api/readings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    if (board === (S.board && S.board.name)) { readingsCache[net] = Object.assign({}, j.saved); if (draftNet === net && !isDirty()) draft = Object.assign({}, readingsCache[net]); }
    if (draftNet === net && draft) Object.keys(patch).forEach((k) => (draft[k] = readingsCache[net][k]));
    lastSave = { net, ok: true, msg: "Saved to database", at: Date.now() };
    if (S.sel && S.sel.type === "net" && S.sel.name === net) renderInspector();
    return { ok: true, total: j.total };
  } catch (e) { toast(`${net} reading was NOT saved: ${e.message}`); return { ok: false }; }
}

/* ---------------- inspector ---------------- */
function hitsHTML(name) {
  if (!S.sch) return `<p>Open a schematic PDF to see where this appears.</p>`;
  if (S.sch.noText) return `<p class="err-msg">This PDF has no searchable text (it’s probably scanned), so it can’t be linked.</p>`;
  const hits = sortedHits(name); if (!hits.length) return `<p>No exact match for <b>${esc(name)}</b> in the schematic text.</p>`;
  const by = new Map(); hits.forEach((h) => by.set(h.page, (by.get(h.page) || 0) + 1));
  return `<p>${hits.length} match${hits.length > 1 ? "es" : ""} on ${by.size} page${by.size > 1 ? "s" : ""}. Click a page to jump; click again to step through.</p><div class="chips">${[...by].map(([p, c]) => `<button class="chip" data-page="${p}" data-name="${esc(name)}">p.${p + 1}${c > 1 ? " ×" + c : ""}</button>`).join("")}</div>`;
}
let lastErr = null;
export function showError(msg, kind) { lastErr = { msg, kind }; renderInspector(); }
let goodNote = null;
export function renderInspector() {
  const el = $("#insp"), b = S.board, sel = S.sel; let h = "";
  if (goodNote) h += `<div class="notice good">${esc(goodNote)} <button class="btn" data-act="dismissGood">OK</button></div>`;
  if (lastErr) h += `<div class="notice err">${esc(lastErr.msg)}${lastErr.kind ? `<br><button class="btn" data-act="settings">Open Settings</button>` : ""}<br><button class="btn" data-act="dismiss">Dismiss</button></div>`;
  if ((b && b.sample) || (S.sch && S.sch.sample)) h += `<div class="notice"><b>Sample board loaded.</b> Open your boardview and schematic PDF above, or drop them anywhere on the window.</div>`;
  if (!sel) {
    h += `<div class="sec"><h3>How to use</h3><ol class="howto">
      <li>Click a pin to select its net. Click a part’s body to select the part.</li>
      <li>Click a net name or designator in the schematic to find it on the board.</li>
      <li>Subnets follow a net through resistors, inductors, ferrites, fuses and jumpers.</li>
      <li>Log diode-mode, voltage and resistance readings on any net. Flux, the repair assistant, uses them.</li>
      <li><span class="kbd">/</span> search · <span class="kbd">B</span> flip side · <span class="kbd">F</span> fit · <span class="kbd">A</span> Flux · <span class="kbd">Esc</span> clear</li></ol></div>
      <div class="sec"><h3>Boardview formats</h3><ul class="fmtlist">${FORMATS.map(([n, e]) => `<li><b>${esc(e)}</b> ${esc(n)}</li>`).join("")}</ul></div>`;
    if (b && !b.sample) h += `<p class="foot">${esc(b.name)} · ${esc(b.format)} · ${b.parts.length} parts · ${b.nets.size} nets</p>`;
  } else if (sel.type === "net") {
    const pins = b ? b.nets.get(sel.name) || [] : []; const parts = new Set(pins.map((i) => b.pins[i].part));
    const top = pins.filter((i) => vis(b, b.pins[i], "T")).length, bot = pins.filter((i) => vis(b, b.pins[i], "B")).length, gnd = b && b.gnd.has(sel.name);
    const fromPin = S.pinSel >= 0 ? b.pins[S.pinSel] : null;
    const rd = draftFor(sel.name);
    h += `<div class="selh"><div class="kind">Net${gnd ? " · ground" : ""}</div><h2>${esc(sel.name)}</h2>
      <div class="meta">${pins.length} pins · ${parts.size} parts · top ${top} / bottom ${bot}</div>
      <div class="row">${fromPin ? `<button class="btn" data-part="${esc(b.parts[fromPin.part].name)}">Part ${esc(b.parts[fromPin.part].name)} · pin ${esc(fromPin.num)}</button>` : ""}<button class="btn" data-act="ask">Ask Flux</button><button class="btn" data-act="probe" title="Flux asks you to probe points and diagnoses from the readings">Probe with Flux</button><button class="btn" data-act="clear">Clear</button></div></div>
      <div class="sec"><h3>Your readings${rd.status === "good" ? ` <span class="tag good">known good</span>` : rd.status === "bad" ? ` <span class="tag bad">fault</span>` : ""}</h3>
        <div class="statrow" role="group" aria-label="Mark this net">
          <button class="statbtn${rd.status === "good" ? " on good" : ""}" data-status="good" title="Mark this net known-good">Good</button>
          <button class="statbtn${rd.status === "bad" ? " on bad" : ""}" data-status="bad" title="Mark this net faulty">Fault</button>
          <button class="statbtn${!rd.status ? " on" : ""}" data-status="" title="No label">—</button></div>
        <div class="readings">
        <label>DIODE (V)<input id="rDiode" data-f="diode" value="${esc(rd.diode || "")}" placeholder="–"></label>
        <label>VOLTAGE (V)<input id="rVolts" data-f="volts" value="${esc(rd.volts || "")}" placeholder="–"></label>
        <label>TO GND (Ω)<input id="rOhms" data-f="ohms" value="${esc(rd.ohms || "")}" placeholder="–"></label>
        <input class="rnote" id="rNote" data-f="note" value="${esc(rd.note || "")}" placeholder="Note, e.g. gets warm, charger plugged in"></div>
        <div class="rdbar"><button class="btn" id="rdSave" data-act="saveReading">Save to database</button><span id="rdState" class="rdstate"></span></div>
        <button class="linkbtn" data-act="openDb">Open readings database…</button></div>`;
    if (gnd) h += `<div class="notice">Ground is shared by most of the board, so subnet tracing and airwires are off for it.</div>`;
    else {
      h += `<div class="sec"><h3>Subnets<span class="seg" role="group" aria-label="Depth">${[1, 2, 3, 4].map((n) => `<button data-depth="${n}" aria-pressed="${S.depth === n}">${n}</button>`).join("")}</span></h3>
        <p>Nets reached through series parts, ${S.depth} step${S.depth > 1 ? "s" : ""} deep.</p>
        <label class="chk" style="margin-bottom:8px"><input type="checkbox" id="capsChk" ${S.caps ? "checked" : ""}>Also walk through capacitors</label>
        <div class="tree">${S.tree.map((n) => { const cnt = (b.nets.get(n.net) || []).length, sh = sortedHits(n.net).length;
          return `<button class="node" style="--d:${n.depth}" data-focus="${esc(n.net)}" title="${esc(n.net)}${n.viaDesc ? " via " + esc(n.via + " " + n.viaDesc) : ""}"><i class="sw" style="background:var(--n${n.color})"></i><span class="nn">${esc(n.net)}</span>${n.via ? `<span class="via">via ${esc(n.via)}</span>` : ""}<span class="cnt" title="${cnt} pins${S.sch ? ", " + sh + " schematic matches" : ""}">${cnt}p</span>${n.depth ? `<span class="go" data-net="${esc(n.net)}" role="button" tabindex="0" title="Select ${esc(n.net)}">›</span>` : ""}</button>`; }).join("")}</div>
        ${S.tree.length === 1 ? `<p style="margin-top:8px">No series parts on this net at this depth.</p>` : ""}</div>`;
    }
    h += `<div class="sec"><h3>In schematic</h3>${hitsHTML(sel.name)}</div>`;
    const list = [...parts].map((i) => b.parts[i]).sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true })).slice(0, 200);
    h += `<div class="sec"><h3>Parts on this net</h3><div class="chips">${list.map((p) => { const pn = p.pins.filter((i) => b.pins[i].net === sel.name).map((i) => b.pins[i].num).slice(0, 4).join(",");
      return `<button class="chip${p.side === "B" ? " dim" : ""}" data-part="${esc(p.name)}" title="${esc((p.desc ? p.desc + " · " : "") + (p.side === "B" ? "Bottom side" : p.side === "BOTH" ? "Through-hole" : "Top side"))}">${esc(p.name)}.${esc(pn)}</button>`; }).join("")}${parts.size > 200 ? `<span class="foot">+${parts.size - 200} more</span>` : ""}</div></div>`;
    if (!gnd && S.airwires) h += `<p class="foot">Lines on the board are airwires: the shortest pin-to-pin links within a net. Boardview files store pins and nets, not copper routing.</p>`;
  } else if (sel.type === "part") {
    const i = b ? b.partByName.get(sel.name.toUpperCase()) : undefined; const p = i !== undefined ? b.parts[i] : null;
    h += `<div class="selh"><div class="kind">Part</div><h2>${esc(sel.name)}</h2>${p && p.desc ? `<div class="desc">${esc(p.desc)}</div>` : ""}<div class="meta">${p ? `${p.side === "B" ? "Bottom side" : p.side === "BOTH" ? "Through-hole / both sides" : "Top side"} · ${p.pins.length} pin${p.pins.length > 1 ? "s" : ""}` : "Not in boardview"}</div><div class="row"><button class="btn" data-act="ask">Ask Flux</button><button class="btn" data-act="clear">Clear</button></div></div>`;
    h += `<div class="sec"><h3>In schematic</h3>${hitsHTML(sel.name)}</div>`;
    if (p) {
      const rows = p.pins.slice(0, 800).map((pi) => { const q = b.pins[pi]; return `<tr><td>${esc(q.num)}</td><td>${q.net ? `<button class="${b.gnd.has(q.net) ? "g" : ""}" data-net="${esc(q.net)}" data-pin="${pi}">${esc(q.net)}</button>` : `<span class="g">no connection</span>`}</td></tr>`; }).join("");
      h += `<div class="sec"><h3>Pins</h3><table class="pins"><tbody>${rows}</tbody></table></div>`;
    }
  } else {
    h += `<div class="selh"><div class="kind">Schematic text</div><h2>${esc(sel.name)}</h2><div class="meta">${b ? "Not a net or part in the boardview" : "No boardview loaded"}</div><div class="row"><button class="btn" data-act="clear">Clear</button></div></div>
      <div class="sec"><h3>In schematic</h3>${hitsHTML(sel.name)}</div>`;
  }
  el.innerHTML = h;
  if (sel && sel.type === "net") updateReadingState();
}
$("#insp").addEventListener("click", (e) => {
  const sb = e.target.closest("[data-status]");
  if (sb && S.sel && S.sel.type === "net") {
    const d = draftFor(S.sel.name); d.status = sb.dataset.status === (d.status || "") ? "" : sb.dataset.status;
    document.querySelectorAll("#insp .statbtn").forEach((x) => { const on = (x.dataset.status || "") === (d.status || ""); x.className = "statbtn" + (on ? " on" + (x.dataset.status ? " " + x.dataset.status : "") : ""); });
    updateReadingState(); return;
  }
  const act0 = e.target.closest("[data-act]");
  if (act0 && act0.dataset.act === "saveReading") { saveDraft(); return; }
  if (act0 && act0.dataset.act === "openDb") { openDbDialog(); return; }
  const t = e.target.closest("[data-net],[data-part],[data-focus],[data-depth],[data-page],[data-act]"); if (!t) return;
  const act = t.dataset.act;
  if (act === "clear") { select(null); return; }
  if (act === "dismiss") { lastErr = null; renderInspector(); return; }
  if (act === "dismissGood") { goodNote = null; renderInspector(); return; }
  if (act === "settings") { openSettings(); return; }
  if (act === "ask") { app.assistant && app.assistant.askAboutSelection(); return; }
  if (act === "probe") { app.assistant && app.assistant.guideCard(); return; }
  if (t.dataset.depth) { S.depth = +t.dataset.depth; refreshTree(); return; }
  if (t.dataset.page !== undefined) {
    const name = t.dataset.name, pg = +t.dataset.page; const hits = sortedHits(name);
    const cur = hits[S.hitCursor]; let k;
    if (cur && cur.page === pg && sv.page === pg) { k = S.hitCursor + 1; if (!hits[k] || hits[k].page !== pg) k = hits.findIndex((h) => h.page === pg); } else k = hits.findIndex((h) => h.page === pg);
    if (S.layout === "board") setLayout("split"); focusSchOn(name, Math.max(0, k), true); return;
  }
  if (t.dataset.net) { e.stopPropagation(); select({ type: "net", name: t.dataset.net }, { pin: t.dataset.pin ? +t.dataset.pin : -1 }); return; }
  if (t.dataset.part) { select({ type: "part", name: t.dataset.part }); return; }
  if (t.dataset.focus) { focusBoardOn("net", t.dataset.focus); focusSchOn(t.dataset.focus, 0); }
});
$("#insp").addEventListener("change", (e) => { if (e.target.id === "capsChk") { S.caps = e.target.checked; refreshTree(); } });
$("#insp").addEventListener("input", (e) => { const f = e.target.dataset && e.target.dataset.f; if (f && S.sel && S.sel.type === "net") { draftFor(S.sel.name)[f] = e.target.value; updateReadingState(); } });
$("#insp").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset && e.target.dataset.f) { e.preventDefault(); saveDraft(); } });

/* ---------------- interaction ---------------- */
function interact(canvas, apiH) {
  const pts = new Map(); let moved = 0, pinch = 0;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); pts.set(e.pointerId, { x, y }); if (pts.size === 1) moved = 0;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); } apiH.leave(); });
  canvas.addEventListener("pointermove", (e) => { const [x, y] = pos(e); const p = pts.get(e.pointerId); if (!p) { apiH.hover(x, y); return; }
    if (pts.size === 1) { apiH.pan(x - p.x, y - p.y); moved += Math.abs(x - p.x) + Math.abs(y - p.y); }
    else if (pts.size === 2) { p.x = x; p.y = y; const [a, b] = [...pts.values()]; const dd = Math.hypot(a.x - b.x, a.y - b.y); if (pinch > 0) apiH.zoom(dd / pinch, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch = dd; moved += 10; return; }
    p.x = x; p.y = y; });
  const up = (e) => { const had = pts.has(e.pointerId); pts.delete(e.pointerId); if (had && pts.size === 0 && moved < 5 && e.type === "pointerup") { const [x, y] = pos(e); apiH.click(x, y, e); } };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", () => { if (!pts.size) apiH.leave(); });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); const [x, y] = pos(e); apiH.zoom(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016)), x, y); }, { passive: false });
}
function showTip(tip, wrap, x, y, html) { if (!html) { tip.hidden = true; return; } tip.innerHTML = html; tip.hidden = false; const W = wrap.clientWidth; const tw = tip.offsetWidth; tip.style.left = Math.max(4, Math.min(x + 14, W - tw - 6)) + "px"; tip.style.top = Math.max(4, y - 34) + "px"; }
interact(bc, {
  pan(dx, dy) { bv.ox += dx; bv.oy += dy; reqB(); },
  zoom(f, x, y) { if (!S.board) return; const ns = Math.max(bv.fit * 0.3, Math.min(bv.fit * 600, bv.scale * f)); f = ns / bv.scale; bv.scale = ns; bv.ox = x - (x - bv.ox) * f; bv.oy = y - (y - bv.oy) * f; reqB(); },
  click(x, y, e) {
    const b = S.board; if (!b) return; const [wx, wy] = s2b(x, y); const pi = hitPin(wx, wy, 5 / bv.scale);
    if (pi >= 0 && !e.shiftKey) { const p = b.pins[pi]; if (p.net) { select({ type: "net", name: p.net }, { focusBoard: false, pin: pi }); return; } select({ type: "part", name: b.parts[p.part].name }, { focusBoard: false }); return; }
    const pt = pi >= 0 ? b.pins[pi].part : hitPart(wx, wy); if (pt >= 0) select({ type: "part", name: b.parts[pt].name }, { focusBoard: false });
  },
  hover(x, y) {
    const b = S.board; if (!b) return; const [wx, wy] = s2b(x, y); const pi = hitPin(wx, wy, 5 / bv.scale);
    if (pi >= 0) { const p = b.pins[pi]; const pt = b.parts[p.part]; bc.style.cursor = "pointer"; showTip(btip, bwrap, x, y, `<b>${esc(pt.name)}</b><span>.${esc(p.num)}</span> ${p.net ? esc(p.net) : "<span>no net</span>"}${pt.desc ? ` <span>· ${esc(pt.desc)}</span>` : ""}`); return; }
    const pt = hitPart(wx, wy); bc.style.cursor = pt >= 0 ? "pointer" : "crosshair"; showTip(btip, bwrap, x, y, pt >= 0 ? `<b>${esc(b.parts[pt].name)}</b> <span>${b.parts[pt].pins.length} pins${b.parts[pt].desc ? " · " + esc(b.parts[pt].desc) : ""}</span>` : "");
  },
  leave() { btip.hidden = true; },
});
interact(scv, {
  pan(dx, dy) { sv.ox += dx; sv.oy += dy; reqS(); },
  zoom(f, x, y) { if (!S.sch) return; const nz = Math.max(sv.fit * 0.4, Math.min(60, sv.zoom * f)); f = nz / sv.zoom; sv.zoom = nz; sv.ox = x - (x - sv.ox) * f; sv.oy = y - (y - sv.oy) * f; reqS(); },
  click(x, y) {
    const t = tokAt(x, y); if (!t) return; const b = S.board;
    if (b && b.netByUpper.has(t.t)) select({ type: "net", name: b.netByUpper.get(t.t) }, { focusSch: false });
    else if (b && b.partByName.has(t.t)) select({ type: "part", name: b.parts[b.partByName.get(t.t)].name }, { focusSch: false });
    else select({ type: "text", name: t.t }, { focusBoard: false, focusSch: false });
  },
  hover(x, y) {
    const t = tokAt(x, y); if (t !== S.hoverTok) { S.hoverTok = t; reqS(); } const b = S.board;
    if (!t) { scv.style.cursor = "crosshair"; stip.hidden = true; return; } scv.style.cursor = "pointer";
    let info = "<span>not in boardview</span>";
    if (b && b.netByUpper.has(t.t)) info = `<span>net · ${(b.nets.get(b.netByUpper.get(t.t)) || []).length} pins</span>`;
    else if (b && b.partByName.has(t.t)) { const p = b.parts[b.partByName.get(t.t)]; info = `<span>part · ${p.side === "B" ? "bottom" : p.side === "BOTH" ? "both sides" : "top"}${p.desc ? " · " + esc(p.desc) : ""}</span>`; }
    showTip(stip, swrap, x, y, `<b>${esc(t.t)}</b> ${info}`);
  },
  leave() { stip.hidden = true; if (S.hoverTok) { S.hoverTok = null; reqS(); } },
});

/* ---------------- search ---------------- */
const q = $("#q"), sugg = $("#sugg"); let sItems = [], sIdx = 0;
export function searchAll(v, limit = 12) {
  v = String(v).trim().toUpperCase(); if (!v) return [];
  const b = S.board, out = []; const score = (n) => (n === v ? 0 : n.startsWith(v) ? 1 : 2);
  if (b) {
    for (const [u, i] of b.partByName) if (u.includes(v) || (b.parts[i].desc && b.parts[i].desc.toUpperCase().includes(v))) out.push({ type: "part", name: b.parts[i].name, s: u.includes(v) ? score(u) : 3, c: b.parts[i].pins.length + " pins" + (b.parts[i].desc ? " · " + b.parts[i].desc : "") });
    for (const [u, n] of b.netByUpper) if (u.includes(v)) out.push({ type: "net", name: n, s: score(u), c: b.nets.get(n).length + " pins" });
  }
  out.sort((a, c) => a.s - c.s || a.name.length - c.name.length || a.name.localeCompare(c.name, undefined, { numeric: true }));
  const res = out.slice(0, limit);
  if (res.length < limit && S.sch) { const have = new Set(res.map((s) => s.name.toUpperCase())); for (const [u, arr] of S.sch.index) { if (res.length >= limit) break; if (u.length > 1 && u.includes(v) && !have.has(u) && !(b && (b.netByUpper.has(u) || b.partByName.has(u)))) res.push({ type: "text", name: u, c: arr.length + " in schematic" }); } }
  return res;
}
function runSuggest() {
  sItems = searchAll(q.value); if (!q.value.trim()) { sugg.hidden = true; return; } sIdx = 0;
  sugg.innerHTML = sItems.length ? sItems.map((s, i) => `<button role="option" data-i="${i}" aria-selected="${i === 0}"><span class="k">${s.type === "text" ? "sch" : s.type}</span>${esc(s.name)}<span class="c">${esc(s.c)}</span></button>`).join("") : `<div class="foot" style="padding:8px">No nets, parts or schematic text match.</div>`;
  sugg.hidden = false;
}
function pick(i) { const s = sItems[i]; if (!s) return; sugg.hidden = true; q.value = s.name; q.blur(); if (s.type === "text") select({ type: "text", name: s.name }, { focusBoard: false }); else select({ type: s.type, name: s.name }); }
q.addEventListener("input", runSuggest);
q.addEventListener("focus", () => { if (q.value) runSuggest(); });
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!sItems.length) return; sIdx = (sIdx + (e.key === "ArrowDown" ? 1 : -1) + sItems.length) % sItems.length; sugg.querySelectorAll("button").forEach((x, i) => x.setAttribute("aria-selected", i === sIdx)); }
  else if (e.key === "Enter") { e.preventDefault(); pick(sIdx); }
  else if (e.key === "Escape") { sugg.hidden = true; q.blur(); }
});
sugg.addEventListener("mousedown", (e) => { const t = e.target.closest("button[data-i]"); if (t) { e.preventDefault(); pick(+t.dataset.i); } });
q.addEventListener("blur", () => setTimeout(() => (sugg.hidden = true), 120));

/* ---------------- controls ---------------- */
export function setLayout(l) { S.layout = l; $("#work").dataset.layout = l; document.querySelectorAll("#layoutSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.l === l)); requestAnimationFrame(() => { reqB(); reqS(); }); }
$("#layoutSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setLayout(b.dataset.l); setTimeout(() => { fitBoard(); fitSch(); }, 30); } });
$("#sideSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSide(b.dataset.s); });
$("#airw").addEventListener("change", (e) => { S.airwires = e.target.checked; renderInspector(); reqB(); });
$("#fitB").addEventListener("click", fitBoard);
$("#fitS").addEventListener("click", fitSch);
$("#pPrev").addEventListener("click", () => gotoPage(sv.page - 1));
$("#pNext").addEventListener("click", () => gotoPage(sv.page + 1));
$("#pageSel").addEventListener("change", (e) => gotoPage(+e.target.value));
// Flux floats over the board in a chat bubble, so the board and schematic keep the full width.
function toggleAI(on) {
  const pane = $("#aiPane"); on = on === undefined ? pane.hidden : on;
  pane.hidden = !on; $("#aiBubble").hidden = on; if (on) $("#aiDot").hidden = true;
  try { localStorage.setItem("tl.ai", on ? "1" : "0"); } catch (e) {}
  if (on) setTimeout(() => { const i = $("#aiInput"); if (!document.activeElement || !document.activeElement.closest("#aiPane")) i.focus(); }, 30);
}
$("#aiBubble").addEventListener("click", () => toggleAI(true));
$("#guideBtn").addEventListener("click", () => app.assistant && app.assistant.guideCard());
$("#tbOpenBoard").addEventListener("click", () => $("#fBoard").click());
$("#tbOpenSch").addEventListener("click", () => $("#fSch").click());

/* ---------------- menu bar ---------------- */
let openMenu = null, openedAt = 0;
function closeMenus() { if (!openMenu) return; const btn = document.querySelector(`.menu[data-menu="${openMenu}"]`); if (btn) btn.setAttribute("aria-expanded", "false"); const d = $("#menu-" + openMenu); if (d) d.hidden = true; openMenu = null; }
function showMenu(name) {
  closeMenus(); const btn = document.querySelector(`.menu[data-menu="${name}"]`), d = $("#menu-" + name); if (!btn || !d) return;
  openedAt = Date.now();
  // reflect live state as checkmarks
  d.querySelectorAll("[data-cmd]").forEach((b) => b.removeAttribute("aria-checked"));
  const chk = (cmd, on) => { const b = d.querySelector(`[data-cmd="${cmd}"]`); if (b) b.setAttribute("aria-checked", on ? "true" : "false"); };
  if (name === "view") { chk("split-side", splitDir === "side"); chk("split-stack", splitDir === "stack"); chk("view-split", S.layout === "split"); chk("view-board", S.layout === "board"); chk("view-sch", S.layout === "sch"); chk("side-top", S.side === "T"); chk("side-bottom", S.side === "B"); chk("airwires", S.airwires); const m = config.theme_mode || "system"; chk("theme-system", m === "system"); chk("theme-light", m === "light"); chk("theme-dark", m === "dark"); }
  if (name === "assistant") chk("ai-toggle", !$("#aiPane").hidden);
  if (name === "file") fillRecentMenu();
  if (name === "bench" && app.bench) { $("#benchMenu").innerHTML = app.bench.menuItems().map((i) => `<button role="menuitem" data-cmd="bench-show" data-id="${esc(i.id)}" aria-checked="${i.show}">${esc(i.name)}<span class="acc">${esc(i.status)}</span></button>`).join("") || `<div class="mlabel" style="text-transform:none;letter-spacing:0">No instruments yet</div>`; chk("bench-bar", app.bench.barOn); }
  d.style.left = Math.min(btn.offsetLeft, window.innerWidth - d.offsetWidth - 10) + "px";
  btn.setAttribute("aria-expanded", "true"); d.hidden = false; openMenu = name;
}
$("#menus").addEventListener("click", (e) => { const m = e.target.closest(".menu"); if (!m) return; if (openMenu === m.dataset.menu) { if (Date.now() - openedAt > 350) closeMenus(); } else showMenu(m.dataset.menu); });
$("#menus").addEventListener("mouseover", (e) => { const m = e.target.closest(".menu"); if (m && openMenu && openMenu !== m.dataset.menu) showMenu(m.dataset.menu); });
async function saveTheme(mode) { applyAppearance(mode, config.accent); config.theme_mode = mode; if (hasBackend) { try { await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ theme_mode: mode }) }); } catch (e) {} } }
const MENU_CMDS = {
  "open-board": () => $("#fBoard").click(), "open-sch": () => $("#fSch").click(),
  reload: () => location.reload(), exit: () => { if (hasBackend) api("/api/quit", { method: "POST" }).catch(() => {}); },
  "view-split": () => doLayout("split"), "view-board": () => doLayout("board"), "view-sch": () => doLayout("sch"),
  "split-side": () => setSplitDir("side", true), "split-stack": () => setSplitDir("stack", true),
  "open-db": () => openDbDialog(), tutorial: () => startTour(),
  "side-top": () => setSide("T"), "side-bottom": () => setSide("B"), fit: () => { fitBoard(); fitSch(); },
  airwires: () => { const a = $("#airw"); a.checked = !a.checked; a.dispatchEvent(new Event("change")); },
  "theme-system": () => saveTheme("system"), "theme-light": () => saveTheme("light"), "theme-dark": () => saveTheme("dark"),
  "ai-toggle": () => toggleAI(), "ai-new": () => $("#aiNew").click(), "ai-ask": () => app.assistant && app.assistant.askAboutSelection(),
  guided: () => app.assistant && app.assistant.guideCard(), sample: () => loadSample(),
  "bench-setup": () => app.bench && app.bench.openSetup(), "bench-demo": () => app.bench && app.bench.addDemo(), "bench-bar": () => app.bench && app.bench.toggleBar(),
  "bench-show": (b) => app.bench && app.bench.toggleShow(b.dataset.id),
  "recent-open": (b) => openRecent(b.dataset.id), "recent-clear": async () => { await api("/api/recent", { method: "DELETE" }).catch(() => {}); recentCache = { items: [], last: {} }; toast("Recent files cleared."); },
  "check-updates": async () => {
    if (!config.update_repo) { openSettings(); toast("Enter your GitHub repo under Settings → Updates first."); return; }
    toast("Checking GitHub for updates…"); const u = await checkUpdates(true);
    if (u && u.error) toast(u.error);
    else if (u && u.newer && !u.asset) toast(`Version ${u.latest} is out, but its release has no installer attached.`);
    else if (u && !u.newer && u.latest) toast(`You’re up to date (${u.current}).`);
  },
  github: () => { if (config.update_repo && hasBackend) api("/api/open?url=" + encodeURIComponent("https://github.com/" + config.update_repo), { method: "POST" }); else toast("Set your GitHub repo under Settings → Updates first."); },
  about: () => toast(`Trace Lab ${config.version || ""} — boardview & schematic viewer with AI repair assistant.`),
};
let toastT = 0;
function toast(msg) {
  let el = $("#toast"); if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 4000);
}
function doLayout(l) { setLayout(l); setTimeout(() => { fitBoard(); fitSch(); }, 30); }
document.querySelectorAll(".dropdown").forEach((d) => d.addEventListener("click", (e) => { const b = e.target.closest("[data-cmd]"); if (!b) return; closeMenus(); const fn = MENU_CMDS[b.dataset.cmd]; if (fn) fn(b); }));
document.addEventListener("click", (e) => { if (openMenu && !e.target.closest(".menubar")) closeMenus(); });
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,select,textarea")) { if (e.key === "Escape") closeMenus(); return; }
  if (e.ctrlKey && (e.key === "o" || e.key === "O")) { e.preventDefault(); $("#fBoard").click(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); q.focus(); }
  else if (e.key === "Escape") { if (openMenu) closeMenus(); else select(null); }
  else if (e.key === "b" || e.key === "B") setSide(S.side === "T" ? "B" : "T");
  else if (e.key === "f" || e.key === "F") { fitBoard(); fitSch(); }
  else if (e.key === "a" || e.key === "A") toggleAI();
  else if (e.key === "PageDown") gotoPage(sv.page + 1);
  else if (e.key === "PageUp") gotoPage(sv.page - 1);
});

/* ---------------- file loading ---------------- */
const boardListeners = new Set();
export function onBoardChange(fn) { boardListeners.add(fn); }
function setBoard(b) {
  if (!b.sample) hideWelcome();
  S.board = b; if (S.sch && S.sch.sample && !b.sample) { S.sch = null; resetSR(); updatePageSel(); $("#schName").textContent = ""; }
  $("#boardName").textContent = `${b.name} · ${b.format} · ${b.parts.length} parts · ${b.nets.size} nets`;
  S.side = "T"; document.querySelectorAll("#sideSeg button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.s === "T"));
  lastErr = null; select(null); fitBoard(); loadReadings();
  boardListeners.forEach((f) => { try { f(b); } catch (e) {} });
}
function setSch(sch) {
  if (!sch.sample) hideWelcome();
  S.sch = sch; resetSR(); sv.page = 0; if (S.board && S.board.sample && !sch.sample) { S.board = null; $("#boardName").textContent = ""; }
  $("#schName").textContent = `${sch.name} · ${sch.pages.length} pages`;
  lastErr = null;
  select(S.sel && S.board ? S.sel : null, { focusBoard: false }); updatePageSel(); fitSch(); reqB();
  if (sch.noText) showError("This PDF has no text layer (it’s probably scanned), so names can’t be linked to the board. The assistant can still look at its pages as images.");
  boardListeners.forEach((f) => { try { f(S.board); } catch (e) {} });
}
export async function openBoardBytes(files, meta = {}) {
  const prog = $("#bprog"); prog.hidden = false; prog.textContent = "Reading " + files[0].name + "…";
  const keep = meta.recentId || meta.startup ? files : files.map((f) => ({ name: f.name, blob: new Blob([f.bytes]) })); // copy before parsing can detach the buffers
  try {
    await new Promise((r) => setTimeout(r, 10));
    const m = await parseBoardFiles(files, { fz: "", xzz: config.xzz_key, cae: config.cae_key, fzBuiltin: builtinKeys.fz, caeBuiltin: builtinKeys.cae });
    const b = finalizeBoard(m); setBoard(b);
    remember("board", keep, `${b.format} · ${b.parts.length} parts · ${b.nets.size} nets`, meta);
    return true;
  } catch (err) { console.error(err); showError(err.message || "Couldn’t read that boardview file.", err instanceof NeedKeyError ? err.kind : null); return false; }
  finally { prog.hidden = true; }
}
export async function openSchBytes(bytes, name, meta = {}) {
  const keep = [{ name, blob: meta.recentId || meta.startup ? null : new Blob([bytes]) }]; // pdf.js transfers (empties) the buffer, so copy it first
  try { const sch = await loadPdf(bytes, name); setSch(sch); remember("schematic", keep, `${sch.pages.length} pages`, meta); return true; }
  catch (err) { console.error(err); $("#sprog").hidden = true; showError("Couldn’t open that PDF: " + (err.message || err)); return false; }
}

/* ---------------- recent files + reopen prompt ---------------- */
// Opened files are copied to the app's data folder (the page never learns their paths), so they can be
// reopened from File → Open recent and from the prompt shown when Trace Lab starts.
let recentCache = { items: [], last: {} }; const curIds = { board: "", schematic: "" };
async function loadRecent() { if (!hasBackend) return recentCache; try { const r = await api("/api/recent"); if (r.ok) { recentCache = await r.json(); recentCache.items = recentCache.items || []; } } catch (e) {} return recentCache; }
function saveSession() { if (hasBackend) api(`/api/recent/session?board=${encodeURIComponent(curIds.board)}&schematic=${encodeURIComponent(curIds.schematic)}`, { method: "POST" }).catch(() => {}); }
async function remember(kind, files, info, meta) {
  if (!hasBackend) return;
  try {
    let r;
    if (meta.recentId) r = await api("/api/recent/add?touch=" + encodeURIComponent(meta.recentId), { method: "POST" });
    else {
      const fd = new FormData(); fd.append("kind", kind); fd.append("info", info || "");
      if (meta.startup) fd.append("startup", meta.startup.join(","));
      else files.forEach((f) => fd.append("files", f.blob || new Blob([f.bytes]), f.name));
      r = await api("/api/recent/add", { method: "POST", body: fd });
    }
    if (!r.ok) return; const e = await r.json(); curIds[kind] = e.id;
    if (kind === "board" && (!S.sch || S.sch.sample)) curIds.schematic = "";
    saveSession(); loadRecent();
  } catch (e) { console.warn("recent", e); }
}
const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 90 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : s < 86400 * 2 ? "yesterday" : new Date(t).toLocaleDateString(); };
async function fetchRecentFiles(e) { return Promise.all(e.files.map(async (f, i) => { const r = await api(`/api/recent/file?id=${encodeURIComponent(e.id)}&i=${i}`); if (!r.ok) throw new Error(`${f.name} isn't available any more.`); return { name: f.name, bytes: new Uint8Array(await r.arrayBuffer()) }; })); }
export async function openRecent(id) {
  const e = recentCache.items.find((x) => x.id === id); if (!e) { toast("That file isn't in the recent list any more."); return false; }
  try {
    const files = await fetchRecentFiles(e);
    return e.kind === "board" ? await openBoardBytes(files, { recentId: id }) : await openSchBytes(files[0].bytes, files[0].name, { recentId: id });
  } catch (err) { toast(err.message); return false; }
}
async function reopenLast() {
  const { board, schematic } = recentCache.last || {}; const btn = $("#wReopen"); if (btn) { btn.disabled = true; btn.textContent = "Opening…"; }
  if (board) await openRecent(board);
  if (schematic) await openRecent(schematic);
  curIds.board = board || ""; curIds.schematic = schematic || ""; saveSession();
}
function fillRecentMenu() {
  const el = $("#recentMenu"); const paint = () => {
    el.innerHTML = recentCache.items.length ? recentCache.items.slice(0, 8).map((e) => `<button role="menuitem" class="recent" data-cmd="recent-open" data-id="${esc(e.id)}" title="${esc(e.files.map((f) => f.name).join(", "))}"><span class="k">${e.kind === "board" ? "BRD" : "PDF"}</span>${esc(e.files[0].name)}${e.files.length > 1 ? " +" + (e.files.length - 1) : ""}<span class="acc">${esc(ago(e.opened))}</span></button>`).join("") + `<button role="menuitem" data-cmd="recent-clear">Clear recent files</button>`
      : `<div class="mlabel" style="text-transform:none;letter-spacing:0">Nothing opened yet</div>`;
  };
  paint(); loadRecent().then(() => { if (openMenu === "file") paint(); });
}
function hideWelcome() { const w = $("#welcome"); if (w) w.hidden = true; }
async function showWelcome() {
  await loadRecent(); const w = $("#welcome"); const rc = recentCache; const by = (id) => rc.items.find((e) => e.id === id);
  const lb = by(rc.last && rc.last.board), ls = by(rc.last && rc.last.schematic);
  const fileRow = (e) => `<div class="wfile"><span class="ic ${e.kind === "board" ? "" : "pdf"}">${e.kind === "board" ? "BRD" : "PDF"}</span><div class="t"><b title="${esc(e.files.map((f) => f.name).join(", "))}">${esc(e.files[0].name)}${e.files.length > 1 ? ` +${e.files.length - 1}` : ""}</b><span>${esc(e.info || "")}${e.info ? " · " : ""}opened ${esc(ago(e.opened))}</span></div></div>`;
  const others = rc.items.filter((e) => e !== lb && e !== ls).slice(0, 6);
  const recentList = others.length ? `<div class="dlg-sec">Recent files</div><div class="wrecent">${others.map((e) => `<button data-recent="${esc(e.id)}"><span class="k">${e.kind === "board" ? "BRD" : "PDF"}</span><span class="n">${esc(e.files[0].name)}</span><span class="d">${esc(ago(e.opened))}</span></button>`).join("")}</div>` : "";
  const openRow = `<div class="row2"><button class="btn" data-w="board">Open boardview…</button><button class="btn" data-w="sch">Open schematic…</button><span class="spacer"></span><button class="linkbtn" data-w="sample" style="margin:0">Try the sample board</button></div>`;
  w.innerHTML = lb || ls ? `<div class="wcard" role="dialog" aria-labelledby="wH"><h2 id="wH">Pick up where you left off?</h2><p>Reopen the files you had open last time.</p>
      <div class="wfiles">${lb ? fileRow(lb) : ""}${ls ? fileRow(ls) : ""}</div>
      <div class="row2"><button class="btn primary" id="wReopen" data-w="reopen">Reopen ${lb && ls ? "both" : "it"}</button><button class="btn" data-w="empty">Start empty</button></div>${recentList}<div class="dlg-sec"></div>${openRow}</div>`
    : `<div class="wcard" role="dialog" aria-labelledby="wH"><h2 id="wH">Open a board to get started</h2><p>Open a boardview and its schematic PDF, or drop them anywhere on the window. Trace Lab reads ${FORMATS.length}+ boardview formats.</p>${recentList}${openRow}</div>`;
  w.hidden = false; const rb = $("#wReopen"); if (rb) setTimeout(() => rb.focus(), 50);
}
$("#welcome").addEventListener("click", async (e) => {
  const r = e.target.closest("[data-recent]"); if (r) { await openRecent(r.dataset.recent); return; }
  const b = e.target.closest("[data-w]"); if (!b) return; const a = b.dataset.w;
  if (a === "reopen") reopenLast(); else if (a === "empty") hideWelcome(); else if (a === "board") $("#fBoard").click(); else if (a === "sch") $("#fSch").click(); else if (a === "sample") { hideWelcome(); loadSample(); }
});
async function loadSample() {
  S.board = buildSample(); S.sch = buildSampleSchematic(S.board); resetSR(); sv.page = 0;
  $("#boardName").textContent = `${S.board.name} · ${S.board.parts.length} parts · ${S.board.nets.size} nets`;
  $("#schName").textContent = `${S.sch.name} · ${S.sch.pages.length} pages`;
  await new Promise((r) => requestAnimationFrame(r));
  fitBoard(); fitSch(); updatePageSel(); loadReadings(); select({ type: "net", name: "PP3V3_S5" }, { focusBoard: false });
  boardListeners.forEach((f) => { try { f(S.board); } catch (e) {} });
}
async function filesToBytes(list) { return Promise.all([...list].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))); }
async function routeFiles(list) {
  const arr = [...list]; const pdfs = arr.filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf"); const rest = arr.filter((f) => !pdfs.includes(f));
  if (rest.length) await openBoardBytes(await filesToBytes(rest));
  if (pdfs.length) { const f = pdfs[0]; await openSchBytes(new Uint8Array(await f.arrayBuffer()), f.name); }
}
$("#fBoard").addEventListener("change", (e) => { if (e.target.files.length) routeFiles(e.target.files); e.target.value = ""; });
$("#fSch").addEventListener("change", (e) => { if (e.target.files.length) routeFiles(e.target.files); e.target.value = ""; });
let dragN = 0; const drop = $("#drop");
window.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragN++; drop.hidden = false; } });
window.addEventListener("dragleave", () => { dragN = Math.max(0, dragN - 1); if (!dragN) drop.hidden = true; });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); dragN = 0; drop.hidden = true; if (e.dataTransfer.files.length) routeFiles(e.dataTransfer.files); });

async function openStartupFiles() {
  if (!hasBackend) return false;
  try {
    const r = await api("/api/startup"); if (!r.ok) return false; const s = await r.json(); if (!s.files || !s.files.length) return false;
    const fetchF = async (f) => ({ name: f.name, bytes: new Uint8Array(await (await api("/api/file?id=" + f.id)).arrayBuffer()) });
    const bfs = s.files.filter((f) => f.kind === "board"); const boards = await Promise.all(bfs.map(fetchF));
    const pdf = s.files.find((f) => f.kind === "schematic");
    if (boards.length) await openBoardBytes(boards, { startup: bfs.map((f) => f.id) });
    if (pdf) { const f = await fetchF(pdf); await openSchBytes(f.bytes, f.name, { startup: [pdf.id] }); }
    return boards.length > 0 || !!pdf;
  } catch (e) { console.warn(e); return false; }
}

/* ---------------- settings ---------------- */
const dlg = $("#settings");
export const PROVIDERS = {
  anthropic: { label: "Anthropic", key: "sk-ant-…", host: "api.anthropic.com", getKey: "console.anthropic.com", vision: true,
    models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-4-8"], def: "claude-sonnet-5-5" },
  openai: { label: "OpenAI", key: "sk-…", host: "api.openai.com", getKey: "platform.openai.com/api-keys", vision: true,
    models: ["gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "o4-mini"], def: "gpt-4.1" },
  gemini: { label: "Google Gemini", key: "AIza…", host: "generativelanguage.googleapis.com", getKey: "aistudio.google.com/apikey", vision: true,
    models: ["gemini-3.8-flash"], def: "gemini-3.8-flash" },
  openrouter: { label: "OpenRouter", key: "sk-or-…", host: "openrouter.ai", getKey: "openrouter.ai/keys", vision: true,
    models: ["anthropic/claude-sonnet-4.5", "openai/gpt-4.1", "google/gemini-2.5-pro", "meta-llama/llama-3.3-70b-instruct"], def: "anthropic/claude-sonnet-4.5" },
  custom: { label: "your AI service", key: "API key (leave blank if the server needs none)", host: "your endpoint", getKey: "", vision: false,
    models: ["llama-3.1-8b-instruct", "qwen2.5-coder-7b-instruct"], def: "" },
};
const lsModel = (p) => { try { return localStorage.getItem("tl.model." + p) || ""; } catch (e) { return ""; } };
const setLsModel = (p, m) => { try { localStorage.setItem("tl.model." + p, m); } catch (e) {} };
function keyStatus() {
  const cae = parseKeyWords($("#sCae").value), x = $("#sXzz").value.trim();
  const st = (el, ok, txt) => { el.className = "st " + (ok === null ? "" : ok ? "ok" : "bad"); el.textContent = txt; };
  st($("#sCaeSt"), cae.length ? cae.length === 44 : null, cae.length ? (cae.length === 44 ? "44 words" : cae.length + " of 44 words") : "");
  st($("#sXzzSt"), x ? checkXZZKey(parseHexKey64(x)) : null, x ? (checkXZZKey(parseHexKey64(x)) ? "Key looks valid" : "Key must be 16 hex digits and pass the parity check") : "");
}
// ---- model picker: a real dropdown, grouped and labelled free / paid ----
let modelMeta = new Map(); // id -> {free:true|false|null, label, vision:true|false|null}
const isLocalUrl = (u) => /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(u || "");
const per1M = (v) => { const n = parseFloat(v) * 1e6; return n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(2).replace(/\.?0+$/, "") : n.toFixed(3).replace(/\.?0+$/, ""); };
function modelInfo(provider, id, raw) {
  if (provider === "openrouter" && raw && raw.pricing) {
    const pin = parseFloat(raw.pricing.prompt) || 0, pout = parseFloat(raw.pricing.completion) || 0;
    const mods = raw.architecture && raw.architecture.input_modalities; const vision = Array.isArray(mods) ? mods.includes("image") : null;
    return pin === 0 && pout === 0 ? { free: true, label: "Free", vision } : { free: false, label: `$${per1M(raw.pricing.prompt)} in / $${per1M(raw.pricing.completion)} out per 1M tokens`, vision };
  }
  if (provider === "openrouter") return /:free$/.test(id) ? { free: true, label: "Free", vision: null } : { free: false, label: "Paid", vision: null };
  if (provider === "gemini") return /flash/i.test(id) && !/image|omni/i.test(id) ? { free: true, label: "Free tier (daily limits; Google may use free-tier data)", vision: true } : { free: false, label: "Paid only", vision: true };
  if (provider === "custom") return isLocalUrl($("#sBase").value || config.base_url) ? { free: true, label: "Free · runs on your own PC", vision: null } : { free: null, label: "Pricing set by the service", vision: null };
  return { free: false, label: provider === "openai" ? "Paid · billed per use to your OpenAI credit" : "Paid · billed per use", vision: true };
}
function fillModelSelect(provider, ids, rawById, wanted) {
  modelMeta = new Map(); const groups = { free: [], paid: [], other: [] };
  for (const id of ids) { const m = modelInfo(provider, id, rawById && rawById.get(id)); modelMeta.set(id, m); (m.free === true ? groups.free : m.free === false ? groups.paid : groups.other).push(id); }
  const opt = (id) => { const m = modelMeta.get(id); return `<option value="${esc(id)}">${esc(id)}  —  ${esc(m.label)}${m.vision === false ? " · can't read images" : ""}</option>`; };
  const grp = (name, list) => (list.length ? `<optgroup label="${name}">${list.map(opt).join("")}</optgroup>` : "");
  $("#sModelSel").innerHTML = grp("Free", groups.free) + grp("Paid", groups.paid) + grp("Other", groups.other) + `<option value="__custom__">Type a model name…</option>`;
  setModel(wanted);
}
function setModel(id) {
  const sel = $("#sModelSel"), inp = $("#sModel");
  if (id && [...sel.options].some((o) => o.value === id)) { sel.value = id; inp.hidden = true; inp.value = id; }
  else if (id) { sel.value = "__custom__"; inp.hidden = false; inp.value = id; }
  else { const first = [...sel.options].find((o) => o.value !== "__custom__"); if (first) { sel.value = first.value; inp.value = first.value; inp.hidden = true; } else { sel.value = "__custom__"; inp.hidden = false; } }
  showModelHint();
}
function showModelHint() {
  const p = $("#sProvider").value, id = $("#sModel").value.trim(), m = modelMeta.get(id) || modelInfo(p, id, null);
  const cost = m.free === true ? "This model is free to use" + (p === "gemini" ? " within Google's free-tier limits." : ".") : m.free === false ? `Paid: ${m.label}.` : "";
  const img = m.vision === false ? " It can't read images, so the assistant won't be able to look at schematic pages." : " The assistant sends schematic and board images, so pick a model that can read images.";
  $("#sModelHint").textContent = (cost + img).trim();
}
$("#sModelSel").addEventListener("change", () => { const v = $("#sModelSel").value; if (v === "__custom__") { $("#sModel").hidden = false; $("#sModel").value = ""; $("#sModel").focus(); } else { $("#sModel").hidden = true; $("#sModel").value = v; } showModelHint(); });
$("#sModel").addEventListener("input", showModelHint);
function syncProvider(initial) {
  const p = $("#sProvider").value, info = PROVIDERS[p] || PROVIDERS.anthropic;
  const hasKey = !!(config.keyProviders && config.keyProviders[p]);
  $("#sKeyLabel").textContent = p === "custom" ? "API key (optional)" : info.label + " API key";
  $("#sKey").placeholder = hasKey ? "Key saved. Type a new one to replace it." : info.key;
  $("#sKeyHint").innerHTML = hasBackend
    ? `Stored on this PC in your user profile; sent only to ${esc(info.host)}.` + (info.getKey ? ` Get a key at <button class="btn" type="button" data-open="https://${esc(info.getKey)}" style="height:auto;padding:1px 6px">${esc(info.getKey)}</button>` : "")
    : "The assistant needs the Trace Lab desktop app.";
  $("#sBaseWrap").hidden = p !== "custom";
  const want = initial && p === config.provider ? config.model || lsModel(p) || info.def : lsModel(p) || info.def;
  const ids = info.models.slice(); if (want && !ids.includes(want)) ids.unshift(want);
  fillModelSelect(p, ids, null, want);
}
function syncDbSettings() {
  const r = config.readings || {}; const mode = r.mode || "local";
  const od = $("#sDbMode").querySelector('option[value="onedrive"]');
  od.disabled = !r.onedrive; od.textContent = r.onedrive ? "OneDrive (backed up and synced to your other PCs)" : "OneDrive (not set up on this PC)";
  $("#sDbMode").value = mode; $("#sDbDir").value = config.readings_dir || ""; $("#sDbDirWrap").hidden = mode !== "custom";
  $("#sDbPath").textContent = "Currently stored at: " + (r.path || "this PC") + (mode === "onedrive" ? " (synced by OneDrive)" : mode === "custom" ? " (synced by that folder's service, if any)" : "");
}
$("#sDbMode").addEventListener("change", () => { $("#sDbDirWrap").hidden = $("#sDbMode").value !== "custom"; const r = config.readings || {}; if ($("#sDbMode").value === "onedrive" && r.onedrive) $("#sDbPath").textContent = "Will be stored at: " + r.onedrive + "\\Trace Lab\\readings.json (synced by OneDrive). Existing readings move with it."; });
$("#sDbOpen").addEventListener("click", () => { dlg.close("cancel"); openDbDialog(); });
$("#sDbReveal").addEventListener("click", () => { if (hasBackend) api("/api/readings/reveal").catch(() => {}); });
$("#sSplitSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setSplitDir(b.dataset.dir, true); });
$("#sTutorial").addEventListener("click", () => { dlg.close("cancel"); setTimeout(startTour, 120); });
export function openSettings() {
  $("#sProvider").value = PROVIDERS[config.provider] ? config.provider : "anthropic";
  $("#sKey").value = ""; $("#sBase").value = config.base_url || "";
  syncProvider(true);
  $("#sXzz").value = config.xzz_key || ""; $("#sCae").value = config.cae_key || "";
  const mode = config.theme_mode || "system", accent = config.accent || "copper";
  document.querySelectorAll("#sThemeSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
  document.querySelectorAll("#sAccent .sw").forEach((b) => b.setAttribute("aria-pressed", b.dataset.accent === accent));
  document.querySelectorAll("#sSplitSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.dir === splitDir));
  syncDbSettings();
  $("#sRepo").value = config.update_repo || ""; $("#sGh").value = ""; $("#sGh").placeholder = config.hasGitHubToken ? "Token saved. Type a new one to replace it." : "github_pat_…";
  $("#sAuto").checked = config.auto_update !== false; $("#sUpdSt").textContent = ""; $("#sUpdSt").className = "st";
  $("#sVer").textContent = "Trace Lab " + (config.version || "");
  $("#sModelSt").textContent = "";
  keyStatus(); dlg.showModal();
  if (config.keyProviders && config.keyProviders[$("#sProvider").value]) loadModels(true); // refresh the model list quietly
}
["#sXzz", "#sCae"].forEach((s) => $(s).addEventListener("input", keyStatus));
$("#sProvider").addEventListener("change", () => { syncProvider(false); $("#sModelSt").textContent = ""; if (config.keyProviders && config.keyProviders[$("#sProvider").value]) loadModels(true); });
$("#sBase").addEventListener("change", showModelHint);
// Ask the chosen service which models this key can use. Saves the typed key/URL first so the backend can call it.
async function loadModels(quiet) {
  const st = $("#sModelSt"); const say = (t, ok) => { st.textContent = t; st.className = "st " + (ok === undefined ? "" : ok ? "ok" : "bad"); };
  if (!hasBackend) return;
  const provider = $("#sProvider").value, key = $("#sKey").value.trim(), base = $("#sBase").value.trim();
  if (key || base !== (config.base_url || "")) {
    const body = { provider, base_url: base }; if (key) body.api_key = key;
    try { const r = await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); if (r.ok) Object.assign(config, await r.json()); } catch (e) {}
    if (key) { $("#sKey").value = ""; $("#sKey").placeholder = "Key saved. Type a new one to replace it."; }
  }
  if (!quiet) say("Asking " + (PROVIDERS[provider] || {}).label + "…");
  try {
    const r = await api("/api/models?provider=" + encodeURIComponent(provider)); let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
    if (Array.isArray(j)) j = j[0];
    if ($("#sProvider").value !== provider) return; // user switched while we waited
    if (!r.ok) { const em = j && ((j.error && j.error.message) || j.message); if (!quiet) say((r.status === 401 || r.status === 403 ? "The key was rejected." : "Couldn't list models.") + (em ? " " + String(em).slice(0, 160) : ""), false); return; }
    const raw = (j && (j.data || j.models)) || []; const byId = new Map();
    for (const m of raw) { const id = String(m.id || m.name || "").replace(/^models\//, ""); if (id) byId.set(id, m); }
    // keep chat models; drop embeddings, speech, image-generation and moderation models
    let ids = [...byId.keys()].filter((id) => !/embed|whisper|tts|dall-e|image|moderation|audio|realtime|transcri|search|veo|imagen|aqa|live|translate|banana|omni/i.test(id));
    if (!ids.length) { if (!quiet) say("The service returned no chat models.", false); return; }
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if ($("#sModelSel").value === "__custom__") { // user is typing their own name: refresh the list but leave their choice alone
      const typed = $("#sModel").value; fillModelSelect(provider, ids, byId, null);
      $("#sModelSel").value = "__custom__"; $("#sModel").hidden = false; $("#sModel").value = typed; showModelHint();
      if (!quiet) say(`${ids.length} models available.`, true); return;
    }
    const cur = $("#sModel").value.trim();
    const pick = ids.includes(cur) ? cur : ids.find((m) => /flash|sonnet|mini|4\.1|gpt-5/i.test(m) && modelInfo(provider, m, byId.get(m)).free !== false) || ids.find((m) => /flash|sonnet|mini|4\.1|gpt-5/i.test(m)) || ids[0];
    fillModelSelect(provider, ids, byId, pick);
    const nFree = ids.filter((id) => modelMeta.get(id).free === true).length;
    say(`${ids.length} models available${nFree ? `, ${nFree} free` : ""}.` + (cur && cur !== pick ? ` "${cur}" isn't one of them, so "${pick}" is selected — click Save to keep it.` : ""), true);
  } catch (e) { if (!quiet) say("Couldn't list models: " + e.message, false); }
}
$("#sLoadModels").addEventListener("click", () => loadModels(false));
$("#settingsBtn").addEventListener("click", openSettings);
// live theme preview while the dialog is open
$("#sThemeSeg").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; document.querySelectorAll("#sThemeSeg button").forEach((x) => x.setAttribute("aria-pressed", x === b)); applyAppearance(b.dataset.mode, currentAccent()); });
$("#sAccent").addEventListener("click", (e) => { const b = e.target.closest(".sw"); if (!b) return; document.querySelectorAll("#sAccent .sw").forEach((x) => x.setAttribute("aria-pressed", x === b)); applyAppearance(currentMode(), b.dataset.accent); });
$("#settings").addEventListener("click", (e) => { const o = e.target.closest("[data-open]"); if (o && hasBackend) { e.preventDefault(); api("/api/open?url=" + encodeURIComponent(o.dataset.open), { method: "POST" }).catch(() => {}); } });
const currentMode = () => (document.querySelector("#sThemeSeg button[aria-pressed=true]") || {}).dataset?.mode || "system";
const currentAccent = () => (document.querySelector("#sAccent .sw[aria-pressed=true]") || {}).dataset?.accent || "copper";
dlg.addEventListener("close", async () => {
  if (dlg.returnValue !== "save") { applyAppearance(config.theme_mode, config.accent); return; } // revert live preview on cancel
  const provider = $("#sProvider").value, model = $("#sModel").value.trim();
  setLsModel(provider, model);
  const body = { provider, model, base_url: $("#sBase").value.trim(), xzz_key: $("#sXzz").value.trim(), cae_key: $("#sCae").value.trim(),
    theme_mode: currentMode(), accent: currentAccent(), readings_mode: $("#sDbMode").value, readings_dir: $("#sDbDir").value.trim() };
  const k = $("#sKey").value.trim(); if (k) body.api_key = k;
  body.update_repo = $("#sRepo").value.trim(); body.auto_update = $("#sAuto").checked;
  const gh = $("#sGh").value.trim(); if (gh) body.github_token = gh;
  const prevPath = (config.readings || {}).path;
  Object.assign(config, { provider, model, base_url: body.base_url, xzz_key: body.xzz_key, cae_key: body.cae_key, theme_mode: body.theme_mode, accent: body.accent });
  applyAppearance(config.theme_mode, config.accent);
  if (hasBackend) {
    try {
      const r = await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({}));
      if (r.ok) { Object.assign(config, j); const np = (config.readings || {}).path; if (np && np !== prevPath) { toast("Readings database moved to " + np); loadReadings(); } else toast("Settings saved."); }
      else { toast("Settings not saved: " + ((j.error && j.error.message) || "HTTP " + r.status)); showError((j.error && j.error.message) || "Settings weren't saved."); }
    } catch (e) { showError("Couldn’t save settings: " + e.message); }
  }
  app.assistant && app.assistant.refresh();
  if (body.update_repo && config.auto_update !== false) checkUpdates(false);
});

/* ---------------- readings database browser ---------------- */
const dbDlg = $("#dbDlg"); let dbAll = [], dbConfirm = null;
export async function openDbDialog() {
  if (!hasBackend) { toast("The readings database needs the Trace Lab desktop app."); return; }
  $("#dbRows").innerHTML = `<tr><td colspan="9" class="foot">Loading…</td></tr>`; if (!dbDlg.open) dbDlg.showModal();
  try {
    const r = await api("/api/readings/all"); const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    dbAll = j.readings || []; const st = j.storage || {};
    $("#dbWhere").textContent = `Stored at ${st.path}` + (st.mode === "onedrive" ? " · synced by OneDrive" : st.mode === "custom" ? " · in your chosen folder" : " · this PC only (Settings → Readings database to move it to OneDrive)");
    $("#dbCount").textContent = `${dbAll.length} reading${dbAll.length === 1 ? "" : "s"} · ${j.boards} board${j.boards === 1 ? "" : "s"}`;
    renderDb();
  } catch (e) { $("#dbRows").innerHTML = `<tr><td colspan="9" class="err-msg">Couldn't open the database: ${esc(e.message)}</td></tr>`; }
}
function renderDb() {
  const f = $("#dbFilter").value.trim().toUpperCase(), stf = $("#dbStatus").value, cur = S.board && S.board.name;
  const rows = dbAll.filter((r) => (!stf || r.status === stf) && (!f || (r.board + " " + r.net + " " + (r.note || "")).toUpperCase().includes(f)));
  $("#dbRows").innerHTML = rows.length ? rows.map((r, i) => {
    const key = r.board + "\u0000" + r.net; const here = r.board === cur;
    return `<tr class="${here ? "cur" : ""}"><td>${esc(r.board)}</td><td class="m">${here ? `<button class="net" data-go="${esc(r.net)}" title="Show on the open board">${esc(r.net)}</button>` : esc(r.net)}</td>
      <td>${r.status === "good" ? '<span class="tag good">good</span>' : r.status === "bad" ? '<span class="tag bad">fault</span>' : ""}</td>
      <td class="m">${esc(r.diode || "")}</td><td class="m">${esc(r.volts || "")}</td><td class="m">${esc(r.ohms || "")}</td><td>${esc(r.note || "")}</td><td>${esc(fmtTime(r.updated))}</td>
      <td>${dbConfirm === key ? `<button class="btn" data-del="${i}" style="height:24px;color:var(--bad)">Delete?</button>` : `<button class="x" data-ask="${i}" title="Delete this reading">✕</button>`}</td></tr>`;
  }).join("") : `<tr><td colspan="9" class="foot">${dbAll.length ? "No readings match." : "No readings saved yet. Select a net, enter readings, and press Save to database."}</td></tr>`;
  $("#dbRows").dataset.rows = JSON.stringify(rows.map((r) => [r.board, r.net]));
}
$("#dbFilter").addEventListener("input", renderDb); $("#dbStatus").addEventListener("change", renderDb);
$("#dbRows").addEventListener("click", async (e) => {
  const rows = JSON.parse($("#dbRows").dataset.rows || "[]");
  const ask = e.target.closest("[data-ask]"), del = e.target.closest("[data-del]"), go = e.target.closest("[data-go]");
  if (ask) { const [b, n] = rows[+ask.dataset.ask]; dbConfirm = b + "\u0000" + n; renderDb(); return; }
  if (del) {
    const [b, n] = rows[+del.dataset.del]; dbConfirm = null;
    const r = await api("/api/readings?board=" + encodeURIComponent(b) + "&net=" + encodeURIComponent(n), { method: "DELETE" });
    if (r.ok) { dbAll = dbAll.filter((x) => !(x.board === b && x.net === n)); if (S.board && b === S.board.name) { delete readingsCache[n]; if (draftNet === n) draft = {}; renderInspector(); } toast(`Deleted the reading for ${n} (${b}).`); $("#dbCount").textContent = `${dbAll.length} readings`; }
    else toast("Couldn't delete that reading."); renderDb(); return;
  }
  if (go) { dbDlg.close(); selectByName(go.dataset.go); }
});
$("#dbExport").addEventListener("click", async () => { const r = await api("/api/readings/export", { method: "POST" }); const j = await r.json().catch(() => ({})); toast(r.ok ? "Exported to " + j.path : "Export failed: " + ((j.error && j.error.message) || r.status)); });
$("#dbReveal").addEventListener("click", () => api("/api/readings/reveal").catch(() => {}));
$("#dbClose").addEventListener("click", () => dbDlg.close());

/* ---------------- split direction ---------------- */
let splitDir = "side";
function setSplitDir(dir, save) {
  splitDir = dir === "stack" ? "stack" : "side"; $("#work").dataset.split = splitDir;
  const ln = $("#splitDirLine"); if (ln) ln.setAttribute("d", splitDir === "stack" ? "M1.5 8h13" : "M8 2.5v11");
  $("#splitDirBtn").title = splitDir === "stack" ? "Split is stacked (top / bottom). Click for side by side." : "Split is side by side. Click to stack top / bottom.";
  document.querySelectorAll("#sSplitSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.dir === splitDir));
  if (S.layout !== "split") setLayout("split");
  setTimeout(() => { reqB(); reqS(); fitBoard(); fitSch(); }, 40);
  if (save) { config.split_dir = splitDir; if (hasBackend) api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ split_dir: splitDir }) }).catch(() => {}); }
}
$("#splitDirBtn").addEventListener("click", () => setSplitDir(splitDir === "stack" ? "side" : "stack", true));

/* ---------------- first-run tutorial ---------------- */
const TOUR = [
  { t: null, h: "Welcome to Trace Lab", p: "A one-minute tour of the main parts. You can replay it any time from Help → Tutorial or Settings → Help." },
  { t: ".menus", h: "Menu bar", p: "File opens boardviews, schematic PDFs and your readings database. View changes the layout, board side and theme. Help has updates and this tutorial." },
  { t: "#tbOpenBoard", h: "Open your files", p: "Open a boardview here, then its schematic PDF with the button beside it. You can also drag files onto the window. File → Open recent, and the prompt at start-up, reopen what you had open last time." },
  { t: ".search", h: "Find anything", p: "Type a net, a part or any word from the schematic. Press / to jump here from anywhere." },
  { t: "#boardPane", h: "Board view", p: "Click a pin to select its net, or a part's body to select the part. Scroll to zoom, drag to pan, and press B to flip to the bottom side." },
  { t: "#schPane", h: "Schematic", p: "Click a net name or designator in the PDF to find it on the board. Every match is highlighted in the same colour on both sides." },
  { t: "#insp", h: "Net details and readings", p: "See subnets, the parts on a net and where it appears in the schematic. Mark a net Good or Fault, enter diode, voltage and resistance readings, then press Save to database. A green ✓ confirms the save." },
  { t: "#layoutSeg", h: "Layout", p: "Show the board, the schematic, or both. The button just to the right switches the split between side by side and stacked top/bottom." },
  { t: "#aiBubble", alt: "#aiPane", h: "Flux, your repair assistant", p: "Click the bubble (or press A) to chat. Flux reads this board and its schematic, your saved readings including known-good values from other boards, and any instruments you connect." },
  { t: "#guideBtn", h: "Guided diagnosis", p: "Flux asks you to probe one point at a time, highlights it on the board, reads your meter live and captures the value when it's steady, then works out the fault from the readings." },
  { t: "#benchBar", h: "Bench instruments", p: "Connect a multimeter, bench power supply or oscilloscope over USB or the network. Click an instrument here to show or hide its live readout. Try Bench → Add demo instruments without any hardware." },
  { t: "#settingsBtn", h: "Settings", p: "Pick your AI service and model (free and paid models are labelled), colours, the split direction, and where your readings database lives. Store it in OneDrive to back it up and share it between PCs." },
];
let tourI = -1, tourEls = null;
export function startTour() {
  closeMenus(); if (dlg.open) dlg.close("cancel");
  if (!tourEls) {
    const block = document.createElement("div"); block.className = "tour-block";
    const hole = document.createElement("div"); hole.className = "tour-hole";
    const card = document.createElement("div"); card.className = "tour-card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-live", "polite");
    card.innerHTML = `<h3 id="tourH"></h3><p id="tourP"></p><div class="row2"><span class="step" id="tourStep"></span><button class="btn" id="tourSkip">Skip</button><button class="btn" id="tourBack">Back</button><button class="btn primary" id="tourNext">Next</button></div>`;
    document.body.append(block, hole, card); tourEls = { block, hole, card };
    card.querySelector("#tourNext").onclick = () => tourGo(tourI + 1); card.querySelector("#tourBack").onclick = () => tourGo(tourI - 1); card.querySelector("#tourSkip").onclick = endTour;
    window.addEventListener("resize", () => tourI >= 0 && tourGo(tourI));
    document.addEventListener("keydown", (e) => { if (tourI < 0) return; if (e.key === "Escape") endTour(); else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); tourGo(tourI + 1); } else if (e.key === "ArrowLeft") tourGo(tourI - 1); }, true);
  }
  tourEls.block.hidden = tourEls.hole.hidden = tourEls.card.hidden = false; tourGo(0);
}
function tourGo(i) {
  if (i >= TOUR.length) { endTour(); return; } tourI = Math.max(0, i);
  const st = TOUR[tourI], { hole, card } = tourEls;
  card.querySelector("#tourH").textContent = st.h; card.querySelector("#tourP").textContent = st.p;
  card.querySelector("#tourStep").textContent = `${tourI + 1} of ${TOUR.length}`; card.querySelector("#tourBack").disabled = tourI === 0;
  card.querySelector("#tourNext").textContent = tourI === TOUR.length - 1 ? "Finish" : "Next";
  let el = st.t && document.querySelector(st.t); if (el && !el.offsetWidth && st.alt) el = document.querySelector(st.alt);
  const W = window.innerWidth, H = window.innerHeight, cw = card.offsetWidth || 380, ch = card.offsetHeight || 180;
  if (!el || !el.offsetWidth) { hole.style.cssText = `left:${W / 2}px;top:${H / 2}px;width:0;height:0`; card.style.left = (W - cw) / 2 + "px"; card.style.top = (H - ch) / 2 + "px"; return; }
  const r = el.getBoundingClientRect(), pad = 6;
  hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
  let x, y;
  if (r.bottom + 14 + ch < H) { y = r.bottom + 14; x = r.left; }
  else if (r.top - 14 - ch > 0) { y = r.top - 14 - ch; x = r.left; }
  else if (r.right + 14 + cw < W) { x = r.right + 14; y = r.top + 20; }
  else { x = r.left - 14 - cw; y = r.top + 20; }
  card.style.left = Math.max(10, Math.min(W - cw - 10, x)) + "px"; card.style.top = Math.max(10, Math.min(H - ch - 10, y)) + "px";
}
function endTour() {
  tourI = -1; if (tourEls) tourEls.block.hidden = tourEls.hole.hidden = tourEls.card.hidden = true;
  config.tutorial_done = true;
  if (hasBackend) api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tutorial_done: true }) }).catch(() => {});
  else { try { localStorage.setItem("tl.tour", "1"); } catch (e) {} }
}

/* ---------------- updates (GitHub releases) ---------------- */
let updInfo = null;
const updBtn = $("#updBtn"), updDlg = $("#updDlg");
async function checkUpdates(manual, repoOverride) {
  if (!hasBackend) return null;
  const st = $("#sUpdSt"); const say = (t, ok) => { if (manual) { st.textContent = t; st.className = "st " + (ok === undefined ? "" : ok ? "ok" : "bad"); } };
  say("Checking GitHub…");
  try {
    const r = await api("/api/update/check" + (repoOverride ? "?repo=" + encodeURIComponent(repoOverride) : "")); const u = await r.json();
    if (!u.configured) { say("Enter your GitHub repo above first.", false); return u; }
    if (u.error) { say(u.error, false); return u; }
    if (u.newer && u.asset) { updInfo = u; updBtn.textContent = "Update to " + u.latest; updBtn.hidden = false; say(`Version ${u.latest} is available.`, true); if (manual) openUpdate(); }
    else if (u.newer) say(`Version ${u.latest} is out, but its release has no TraceLab-Setup .exe attached.`, false);
    else { updBtn.hidden = true; say(`You're up to date (${u.current}). Latest release: ${u.latest}.`, true); }
    return u;
  } catch (e) { say("Couldn't check for updates: " + e.message, false); return null; }
}
function openUpdate() {
  const u = updInfo; if (!u) return; if (dlg.open) dlg.close();
  $("#updTitle").textContent = `Trace Lab ${u.latest} is available`;
  $("#updMeta").textContent = `You have ${u.current}. From ${u.repo}${u.published ? " · released " + new Date(u.published).toLocaleDateString() : ""}${u.size ? " · " + (u.size / 1048576).toFixed(1) + " MB" : ""}${u.checksum ? " · checksum verified on download" : ""}.`;
  const nt = (u.notes || "No release notes.").trim(); if (app.assistant && app.assistant.md) { $("#updNotes").innerHTML = app.assistant.md(nt); $("#updNotes").style.whiteSpace = "normal"; } else $("#updNotes").textContent = nt;
  $("#updLink").href = u.url || "#"; $("#updSt").textContent = ""; $("#updGo").disabled = false;
  $("#updGo").hidden = !u.can_self_update;
  if (!u.can_self_update) $("#updSt").textContent = "Download the new installer from the release page.";
  updDlg.showModal();
}
updBtn.addEventListener("click", openUpdate);
$("#updLink").addEventListener("click", (e) => { const h = $("#updLink").href; if (hasBackend && h.startsWith("https://")) { e.preventDefault(); api("/api/open?url=" + encodeURIComponent(h), { method: "POST" }); } });
$("#updLater").addEventListener("click", () => updDlg.close());
$("#updGo").addEventListener("click", async () => {
  const st = $("#updSt"); $("#updGo").disabled = true; st.className = "st"; st.textContent = "Downloading the update…";
  try {
    const r = await api("/api/update/install", { method: "POST" }); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "HTTP " + r.status);
    st.className = "st ok"; st.textContent = `Installing ${j.version}. Trace Lab will close and reopen in a few seconds.`;
  } catch (e) { st.className = "st bad"; st.textContent = "Update failed: " + e.message; $("#updGo").disabled = false; }
});
$("#sCheck").addEventListener("click", async () => {
  const repo = $("#sRepo").value.trim();
  if (repo && repo !== config.update_repo) { await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ update_repo: repo }) }).then((r) => r.json()).then((j) => Object.assign(config, j)).catch(() => {}); }
  checkUpdates(true);
});

/* ---------------- exported app API (used by the assistant) ---------------- */
export const app = {
  S, sv, config, api, hasBackend, select, selectByName, searchAll, expand, isSeries, sortedHits, getReadings, renderRegion,
  focusBoardOn, focusSchOn, gotoPage, setLayout, setSide, openSettings, reqB, reqS, onSelect, onBoardChange, esc, PROVIDERS, applyAppearance,
  startTour, openDbDialog, setSplitDir, get splitDir() { return splitDir; }, saveReadingFor, toast, toggleAI, openRecent, bench: null,
  captureBoard(maxW = 1400) {
    drawBoard(); const W = bc.width, H = bc.height; const s = Math.min(1, maxW / W); const c = document.createElement("canvas");
    c.width = Math.round(W * s); c.height = Math.round(H * s); c.getContext("2d").drawImage(bc, 0, 0, c.width, c.height); return c;
  },
  assistant: null,
};
window.TraceLab = app;

/* ---------------- boot ---------------- */
readTheme();
const mq = window.matchMedia("(prefers-color-scheme: dark)"); const rethem = () => { readTheme(); reqB(); reqS(); };
try { mq.addEventListener("change", rethem); } catch (e) {}
new MutationObserver(rethem).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent"] });
export function applyAppearance(mode, accent) {
  const el = document.documentElement;
  if (mode === "light" || mode === "dark") el.setAttribute("data-theme", mode); else el.removeAttribute("data-theme");
  el.setAttribute("data-accent", accent || "copper");
}
let aiPref = "0"; try { aiPref = localStorage.getItem("tl.ai") || "0"; } catch (e) {}
toggleAI(aiPref === "1");
[bwrap, swrap].forEach((w) => new ResizeObserver(() => { reqB(); reqS(); }).observe(w));
(async () => {
  await loadConfig();
  applyAppearance(config.theme_mode, config.accent);
  setSplitDir(config.split_dir || "side", false);
  await loadBuiltinKeys();
  if (config.just_updated) goodNote = `Trace Lab was updated to ${config.version}.`;
  if (config.update_repo && config.auto_update !== false) setTimeout(() => checkUpdates(false), 2500);
  if (hasBackend) app.bench = initBench(app); else $("#benchBar").hidden = true;
  app.assistant = initAssistant(app);
  const opened = await openStartupFiles();
  // Open empty, and offer to reopen the last files (or start with the sample when there's no backend).
  if (!opened) { if (hasBackend) await showWelcome(); else await loadSample(); }
  renderInspector(); updatePageSel();
  let seen = config.tutorial_done; if (!hasBackend) { try { seen = localStorage.getItem("tl.tour") === "1"; } catch (e) {} }
  if (!seen) setTimeout(startTour, 700);
})();
