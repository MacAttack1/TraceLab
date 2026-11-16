// Trace Lab repair assistant: Claude with tools that read the loaded boardview and schematic.
const $ = (s) => document.querySelector(s);

const SYSTEM = `You are the repair assistant inside Trace Lab, a boardview and schematic viewer used by technicians doing component-level repair of laptop, desktop, phone, console and GPU motherboards.

You can inspect the board the user has open through tools:
- board_overview: parts, likely power rails, ICs, connectors, schematic page headings.
- find: search nets, parts and schematic text.
- get_net / get_part: pins, connected parts with values, subnets reached through series parts (resistors, inductors, ferrites, fuses, jumpers), schematic pages, and the user's logged readings.
- read_schematic_text: the words on a schematic page or around a name.
- view_schematic: an image of a schematic page or a zoomed crop around a name. Use this whenever wiring matters (what drives an enable pin, which MOSFET switches a rail, divider values, pull-ups), because extracted text loses the connections.
- view_board: an image of the board view (optionally focused on a net or part).
- highlight: select a net or part in the viewer so the user can see it.
- get_readings: the user's diode-mode, voltage and resistance readings.

How to work:
- Ground every specific claim (designators, net names, pin numbers, values, page numbers) in tool results. Never invent a designator, net or value. If the files don't show something, say so and say how the user can measure or check it.
- Look before you answer: for a rail or signal question, call get_net first, then view_schematic on the page that generates it.
- Think like an experienced bench tech. Typical flow: visual inspection and liquid damage, then main input/battery rail for shorts (resistance and diode mode to ground), always-on rails (often named G3H, ALW, AON, S5, DSW or RTC), EC/SMC/PCH standby power, power button and enable chain, power-good signals, then sleep-state rails (S3/S0), CPU/GPU core, memory. Check the regulator's input, enable, feedback, bootstrap, switching node and output in that order.
- For shorts: identify the rail, the parts on it and their locations, then suggest finding the hot component with voltage injection (current-limited, never above the rail's nominal voltage), a thermal camera, freeze spray or isopropyl/rosin, or by lifting inductors/jumpers to split the rail. Point out the rail's subnets and the series parts that can be lifted to isolate sections.
- Interpret the user's readings. Diode-mode and resistance values vary by board, so describe typical ranges as typical, compare against similar rails on the same board when possible, and recommend comparing with a known-good board.
- Mention safety where relevant: ESD, battery disconnection, current limits when injecting, hot air near plastic connectors and BGA underfill.

Style:
- Be concise and practical. Use short numbered steps for procedures.
- Write net and part names exactly as they appear in the files (for example PP3V3_S5, U1, R5) so the app can link them; don't put them in code formatting.
- When a step names a measurement, say where to probe (part and pin or test point) and what reading would point which way.
- Say clearly when something is a guess or depends on the board model.`;

const TOOLS = [
  { name: "board_overview", description: "Summary of the open boardview and schematic: format, counts, ICs, likely power rails with pin and capacitor counts, connectors, ground nets, schematic page count and headings.", input_schema: { type: "object", properties: {} } },
  { name: "find", description: "Search nets, parts (by designator or value/description) and schematic text. Use to resolve vague names like 'the 3.3V rail' or a chip number.", input_schema: { type: "object", properties: { query: { type: "string", description: "Text to search for, case-insensitive substring" } }, required: ["query"] } },
  { name: "get_net", description: "Details for one net: every part and pin on it with values, subnets reached through series parts, schematic pages that mention it, and logged readings.", input_schema: { type: "object", properties: { name: { type: "string" }, depth: { type: "integer", description: "Subnet search depth, 1-4. Default 2." }, through_caps: { type: "boolean", description: "Also walk through 2-pin capacitors. Default false." } }, required: ["name"] } },
  { name: "get_part", description: "Details for one part: value/description, side, every pin with its net and how many pins share that net, and schematic pages.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "read_schematic_text", description: "Text on a schematic page, as lines in reading order. Give 'near' to get only the text around each place a name appears on that page.", input_schema: { type: "object", properties: { page: { type: "integer", description: "1-based page number. Optional if 'near' is given." }, near: { type: "string", description: "Net or part name to centre on" } } } },
  { name: "view_schematic", description: "Image of a schematic page. With 'near', a zoomed crop around that name with its occurrences boxed in orange. Use this to read wiring, values and enable chains.", input_schema: { type: "object", properties: { page: { type: "integer", description: "1-based page number. Optional if 'near' is given (first page with a match)." }, near: { type: "string" }, occurrence: { type: "integer", description: "Which match of 'near' to centre on, 1-based. Default 1." } } } },
  { name: "view_board", description: "Image of the board viewer. With 'focus', selects that net or part first so it is highlighted (primary net orange, subnets in other colours, pins on the far side as dashed rings).", input_schema: { type: "object", properties: { focus: { type: "string" }, side: { type: "string", enum: ["top", "bottom"] } } } },
  { name: "highlight", description: "Select a net or part in the viewer so the user sees it on the board and schematic.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_readings", description: "All diode-mode, voltage and resistance readings the user has logged for this board, by net.", input_schema: { type: "object", properties: {} } },
];
TOOLS[TOOLS.length - 1].cache_control = { type: "ephemeral" };

const RAIL_RE = /^(PP|\+)|^V[A-Z0-9_]*$|\d+V\d*|\dP\d+V|VCC|VDD|VIN|VBUS|VBAT|DCIN|ADAPTER|BATT|_RTC|VCORE|VGFX|VDDQ|VTT/i;
const prefix = (n) => (n.match(/^[A-Za-z]+/) || [""])[0].toUpperCase();
const sideName = (s) => (s === "B" ? "bottom" : s === "BOTH" ? "both/TH" : "top");

export function initAssistant(app) {
  const { S } = app;
  const log = $("#aiLog"), input = $("#aiInput"), form = $("#aiForm"), sendBtn = $("#aiSend"), quick = $("#aiQuick"), ctxEl = $("#aiCtx");
  let messages = [], busy = false, ctrl = null;

  /* ---------------- tool implementations ---------------- */
  const board = () => S.board;
  function resolveNet(name) { const b = board(); if (!b || !name) return null; const u = String(name).trim().toUpperCase(); return b.netByUpper.get(u) || null; }
  function resolvePart(name) { const b = board(); if (!b || !name) return null; const i = b.partByName.get(String(name).trim().toUpperCase()); return i === undefined ? null : b.parts[i]; }
  function suggest(name) { const r = app.searchAll(name, 8); return r.length ? " Closest matches: " + r.map((x) => `${x.name} (${x.type})`).join(", ") + "." : ""; }
  function pagesOf(name) { const h = app.sortedHits(name); const by = new Map(); h.forEach((t) => by.set(t.page + 1, (by.get(t.page + 1) || 0) + 1)); return [...by].map(([p, c]) => (c > 1 ? `p${p}×${c}` : `p${p}`)).join(", "); }
  function pageHeadings(pg) {
    const toks = pg.tokens.filter((t) => t.raw && t.raw.length > 2 && !/^[\d.]+$/.test(t.raw)).sort((a, b) => b.h - a.h);
    const out = []; const seen = new Set(); let lastH = toks.length ? toks[0].h : 0;
    for (const t of toks) { if (out.length >= 7 || t.h < lastH * 0.75) break; if (!seen.has(t.t)) { seen.add(t.t); out.push(t.raw); } }
    return out.join(" ");
  }
  function linesFromTokens(toks) {
    toks = toks.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    const rows = []; for (const t of toks) { const r = rows.find((r) => Math.abs(r.y - t.y) < Math.max(2.5, t.h * 0.5)); if (r) r.t.push(t); else rows.push({ y: t.y, t: [t] }); }
    return rows.map((r) => r.t.sort((a, b) => a.x - b.x).map((t) => t.raw || t.t).join(" ")).join("\n");
  }
  const T = {
    board_overview() {
      const b = board(); if (!b) return "No boardview is loaded.";
      const L = [`Board file: ${b.name} (${b.format || "?"})${b.sample ? " — this is Trace Lab's built-in sample board, not the user's" : ""}`, `Parts: ${b.parts.length}, pins: ${b.pins.length}, nets: ${b.nets.size}, bottom-side parts: ${b.parts.filter((p) => p.side === "B").length}`];
      const ics = b.parts.filter((p) => p.pins.length >= 8 && !p.nail).sort((a, c) => c.pins.length - a.pins.length).slice(0, 45);
      L.push("", "Largest parts (ICs/connectors):", ...ics.map((p) => `${p.name}: ${p.pins.length} pins, ${sideName(p.side)}${p.desc ? ", " + p.desc : ""}`));
      const rails = [...b.nets].filter(([n]) => !b.gnd.has(n) && RAIL_RE.test(n)).map(([n, arr]) => { const caps = new Set(arr.map((i) => b.pins[i].part).filter((pi) => /^P?C$/.test(prefix(b.parts[pi].name)))); return [n, arr.length, caps.size]; }).sort((a, c) => c[1] - a[1]).slice(0, 70);
      L.push("", "Likely power rails (by name), pins / capacitors:", ...rails.map(([n, c, k]) => `${n}: ${c} pins, ${k} caps`));
      const big = [...b.nets].filter(([n, a]) => !b.gnd.has(n) && !RAIL_RE.test(n) && a.length >= 20).sort((a, c) => c[1].length - a[1].length).slice(0, 15);
      if (big.length) L.push("", "Other high-fanout nets:", big.map(([n, a]) => `${n} (${a.length})`).join(", "));
      L.push("", "Ground nets: " + ([...b.gnd].slice(0, 12).join(", ") || "none detected"));
      const conn = b.parts.filter((p) => /^(J|CN|CON|P|JP)\d/i.test(p.name) && p.pins.length > 2).slice(0, 30);
      if (conn.length) L.push("", "Connectors: " + conn.map((p) => `${p.name} (${p.pins.length}p${p.desc ? ", " + p.desc : ""})`).join("; "));
      const sch = S.sch;
      if (sch) { L.push("", `Schematic: ${sch.name}, ${sch.pages.length} pages${sch.noText ? " (no text layer; use view_schematic)" : ""}.`); if (!sch.noText) sch.pages.slice(0, 120).forEach((pg, i) => L.push(`p${i + 1}: ${pageHeadings(pg)}`)); }
      else L.push("", "No schematic PDF is loaded.");
      const rd = app.getReadings(); const nr = Object.keys(rd).length; if (nr) L.push("", `User has logged readings on ${nr} net(s); call get_readings.`);
      return L.join("\n");
    },
    find({ query }) {
      const r = app.searchAll(query || "", 40); if (!r.length) return `Nothing matches "${query}".`;
      return r.map((x) => `${x.type === "text" ? "schematic text" : x.type}: ${x.name} — ${x.c}${x.type !== "text" && S.sch ? (pagesOf(x.name) ? "; schematic " + pagesOf(x.name) : "") : ""}`).join("\n");
    },
    get_net({ name, depth = 2, through_caps = false }) {
      const b = board(); if (!b) return "No boardview is loaded.";
      const n = resolveNet(name); if (!n) return `No net named "${name}".` + suggest(name);
      const arr = b.nets.get(n) || []; const byPart = new Map();
      arr.forEach((i) => { const p = b.pins[i]; if (!byPart.has(p.part)) byPart.set(p.part, []); byPart.get(p.part).push(p.num); });
      const kinds = {}; byPart.forEach((_, pi) => { const k = prefix(b.parts[pi].name) || "?"; kinds[k] = (kinds[k] || 0) + 1; });
      const L = [`Net ${n}: ${arr.length} pins on ${byPart.size} parts${b.gnd.has(n) ? " (treated as ground)" : ""}.`, "Part types: " + Object.entries(kinds).sort((a, c) => c[1] - a[1]).map(([k, c]) => `${k}×${c}`).join(" ")];
      const list = [...byPart].map(([pi, nums]) => { const p = b.parts[pi]; const other = p.pins.length === 2 ? b.pins[p.pins.find((x) => b.pins[x].net !== n) ?? p.pins[0]].net : null;
        return `${p.name}.${nums.slice(0, 12).join(",")}${nums.length > 12 ? "…" : ""} [${sideName(p.side)}${p.desc ? ", " + p.desc : ""}]${p.pins.length === 2 && other && other !== n ? " → other pin: " + other : ""}${p.pins.length > 2 ? ` (${p.pins.length}-pin)` : ""}`; })
        .sort((a, c) => a.localeCompare(c, undefined, { numeric: true }));
      L.push("", "Parts on this net:", ...list.slice(0, 220)); if (list.length > 220) L.push(`…and ${list.length - 220} more`);
      if (!b.gnd.has(n)) {
        const tree = app.expand(n, Math.max(1, Math.min(4, depth | 0 || 2)), !!through_caps);
        if (tree.length > 1) L.push("", "Subnets via series parts:", ...tree.slice(1).map((t) => `${"  ".repeat(t.depth - 1)}- ${t.net} via ${t.via}${t.viaDesc ? " (" + t.viaDesc + ")" : ""}, ${(b.nets.get(t.net) || []).length} pins`));
        else L.push("", "No subnets through series parts at this depth.");
      }
      if (S.sch) L.push("", "Schematic: " + (pagesOf(n) || "name not found in schematic text"));
      const rd = app.getReadings(); const mine = [n, ...app.expand(n, 2, false).map((t) => t.net)].filter((k, i, a) => rd[k] && a.indexOf(k) === i);
      if (mine.length) L.push("", "Logged readings:", ...mine.map((k) => fmtReading(k, rd[k])));
      return L.join("\n");
    },
    get_part({ name }) {
      const b = board(); if (!b) return "No boardview is loaded.";
      const p = resolvePart(name); if (!p) return `No part named "${name}".` + suggest(name);
      const L = [`Part ${p.name}: ${p.pins.length} pins, ${sideName(p.side)} side${p.desc ? ", value/description: " + p.desc : ", no value in the boardview (check the schematic)"}.`];
      if (S.sch) L.push("Schematic: " + (pagesOf(p.name) || "designator not found in schematic text"));
      L.push("", "Pins (number: net [pins on that net]):");
      p.pins.slice(0, 700).forEach((i) => { const q = b.pins[i]; L.push(`${q.num}: ${q.net ? q.net + ` [${(b.nets.get(q.net) || []).length}]${b.gnd.has(q.net) ? " ground" : ""}` : "not connected"}`); });
      if (p.pins.length > 700) L.push(`…${p.pins.length - 700} more pins`);
      return L.join("\n");
    },
    read_schematic_text({ page, near }) {
      const sch = S.sch; if (!sch) return "No schematic PDF is loaded.";
      if (sch.noText) return "This PDF has no text layer. Use view_schematic to look at it.";
      let pi = page ? page - 1 : -1; let hits = [];
      if (near) { hits = app.sortedHits(near); if (!hits.length) return `"${near}" doesn't appear in the schematic text.` + suggest(near); if (pi < 0) pi = hits[0].page; hits = hits.filter((h) => h.page === pi); }
      if (pi < 0 || pi >= sch.pages.length) return `Page must be 1–${sch.pages.length}.`;
      const pg = sch.pages[pi]; let toks = pg.tokens;
      if (near) { if (!hits.length) return `"${near}" isn't on page ${pi + 1}. It appears on: ${pagesOf(near)}.`; toks = toks.filter((t) => hits.some((h) => Math.abs(t.x - h.x) < 170 && Math.abs(t.y - h.y) < 110)); }
      let txt = linesFromTokens(toks); const cap = near ? 9000 : 14000; if (txt.length > cap) txt = txt.slice(0, cap) + "\n…(truncated)";
      return `Schematic page ${pi + 1} of ${sch.pages.length}${near ? `, text near ${near}` : ""}:\n${txt}`;
    },
    async view_schematic({ page, near, occurrence = 1 }) {
      const sch = S.sch; if (!sch) return "No schematic PDF is loaded.";
      let pi = page ? page - 1 : -1, hit = null, hits = [];
      if (near) { hits = app.sortedHits(near); if (pi >= 0) hits = hits.filter((h) => h.page === pi); if (!hits.length && pi < 0) return `"${near}" doesn't appear in the schematic text.` + suggest(near); if (hits.length) { hit = hits[Math.max(0, Math.min(hits.length - 1, (occurrence | 0) - 1))]; pi = hit.page; } }
      if (pi < 0) pi = app.sv.page;
      if (pi >= sch.pages.length) return `Page must be 1–${sch.pages.length}.`;
      const pg = sch.pages[pi]; let x0 = 0, y0 = 0, w = pg.w, h = pg.h, scale;
      if (hit) { w = Math.min(pg.w, 640); h = Math.min(pg.h, 440); x0 = Math.max(0, Math.min(pg.w - w, hit.x + hit.w / 2 - w / 2)); y0 = Math.max(0, Math.min(pg.h - h, hit.y + hit.h / 2 - h / 2)); scale = 1500 / w; }
      else scale = 1600 / Math.max(pg.w, pg.h);
      const job = app.renderRegion(pi, scale, x0 * scale, y0 * scale, Math.round(w * scale), Math.round(h * scale)); const c = await job.promise;
      if (!c) return "The page didn't render.";
      if (hit) { const g = c.getContext("2d"); g.strokeStyle = "#ff7a00"; g.lineWidth = 3; app.sortedHits(near).filter((t) => t.page === pi).forEach((t) => g.strokeRect((t.x - x0 - 2) * scale, (t.y - y0 - 2) * scale, (t.w + 4) * scale, (t.h + 4) * scale)); }
      if (hit) app.focusSchOn(near, app.sortedHits(near).indexOf(hit), true); else app.gotoPage(pi);
      const data = c.toDataURL("image/png").split(",")[1];
      const note = `Schematic page ${pi + 1} of ${sch.pages.length}${hit ? `, zoomed on ${near} (match ${hits.indexOf(hit) + 1} of ${hits.length} on this page; all pages: ${pagesOf(near)})` : ""}.`;
      return [{ type: "text", text: note }, { type: "image", source: { type: "base64", media_type: "image/png", data } }];
    },
    async view_board({ focus, side }) {
      const b = board(); if (!b) return "No boardview is loaded.";
      let what = "";
      if (focus) { const k = app.selectByName(focus); if (!k) return `No net or part named "${focus}".` + suggest(focus); what = `${k} ${focus} selected. `; }
      if (side) app.setSide(side === "bottom" ? "B" : "T");
      if (S.layout === "sch") app.setLayout("split");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = app.captureBoard(1400); const data = c.toDataURL("image/png").split(",")[1];
      return [{ type: "text", text: `${what}Board view, ${S.side === "B" ? "bottom side (mirrored)" : "top side"}. Primary net is orange; subnets use other colours; dashed rings are pins of highlighted nets on the other side; dark pins are ground.` }, { type: "image", source: { type: "base64", media_type: "image/png", data } }];
    },
    highlight({ name }) { const k = app.selectByName(name); return k ? `Selected ${k} ${name} in the viewer.` : `Nothing named "${name}".` + suggest(name); },
    get_readings() { const rd = app.getReadings(); const k = Object.keys(rd); return k.length ? k.map((n) => fmtReading(n, rd[n])).join("\n") : "The user hasn't logged any readings for this board yet. They can add them in the net panel (diode mode, voltage, resistance to ground)."; },
  };
  function fmtReading(n, r) { return `${n}: ` + [r.diode && `diode ${r.diode}`, r.volts && `voltage ${r.volts} V`, r.ohms && `to GND ${r.ohms} Ω`, r.note && `note: ${r.note}`].filter(Boolean).join(", "); }
  const TOOL_LABEL = { board_overview: () => "Reading board overview", find: (i) => `Searching “${i.query || ""}”`, get_net: (i) => `Checking net ${i.name || ""}`, get_part: (i) => `Checking part ${i.name || ""}`,
    read_schematic_text: (i) => `Reading schematic ${i.near ? "near " + i.near : "p." + (i.page || "")}`, view_schematic: (i) => `Viewing schematic ${i.near ? "at " + i.near : "p." + (i.page || "")}`, view_board: (i) => `Viewing board${i.focus ? " at " + i.focus : ""}`, highlight: (i) => `Highlighting ${i.name || ""}`, get_readings: () => "Reading your measurements" };

  /* ---------------- context + UI ---------------- */
  function contextBlock() {
    const b = board(), sch = S.sch, sel = S.sel; const L = [];
    L.push(b ? `Board: ${b.name} (${b.format || "?"}), ${b.parts.length} parts, ${b.nets.size} nets${b.sample ? " [built-in sample, not the user's board]" : ""}.` : "Board: none loaded.");
    L.push(sch ? `Schematic: ${sch.name}, ${sch.pages.length} pages${sch.noText ? ", no text layer" : ""}. Viewer is on page ${app.sv.page + 1}.` : "Schematic: none loaded.");
    if (sel) L.push(`Current selection: ${sel.type} ${sel.name}.`);
    const rd = app.getReadings(); const ks = Object.keys(rd); if (ks.length) L.push("Logged readings:\n" + ks.slice(0, 40).map((k) => fmtReading(k, rd[k])).join("\n"));
    return `<app_context>\n${L.join("\n")}\n</app_context>`;
  }
  function renderCtx() {
    const b = board(), sel = S.sel;
    ctxEl.innerHTML = b ? `Context: <b>${app.esc(b.name)}</b>${S.sch ? " + schematic" : ""}${sel ? ` · selected <b>${app.esc(sel.name)}</b>` : ""}` : "Open a boardview to give the assistant something to read.";
    const qs = !sel ? ["The board won't power on. Where do I start?", "Map the main power rails and what creates each one", "Walk me through this board's power-on sequence"]
      : sel.type === "net" ? [`Diagnose ${sel.name}`, `What generates ${sel.name} and what enables it?`, `${sel.name} is shorted to ground. How do I find the short?`, `What readings should ${sel.name} have?`]
      : sel.type === "part" ? [`What does ${sel.name} do?`, `How do I test ${sel.name}?`, `What powers ${sel.name}?`] : [`Where is ${sel.name} used?`];
    quick.innerHTML = busy ? "" : qs.map((t) => `<button type="button">${app.esc(t)}</button>`).join("");
    $("#aiModel").textContent = (app.config.model || "").replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2");
  }
  quick.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) send(b.textContent); });
  let boardId = null;
  app.onSelect(renderCtx);
  app.onBoardChange((b) => {
    const id = b ? b.name + "|" + b.pins.length : null;
    if (boardId !== null && id !== boardId && messages.length) { if (busy && ctrl) ctrl.abort(); messages = []; emptyState(); const n = document.createElement("p"); n.className = "foot"; n.textContent = "New board opened, so the assistant started a fresh conversation."; log.prepend(n); }
    boardId = id; renderCtx();
  });
  function emptyState() {
    log.innerHTML = `<div class="ai-empty"><h3>Repair assistant</h3><div>Ask about a fault, a rail or a part. The assistant reads this board and its schematic, looks at schematic pages, and uses the readings you log on each net.</div>${app.config.hasKey ? "" : `<div class="notice">Add your Anthropic API key in <button class="btn" data-act="settings">Settings</button> to turn the assistant on.</div>`}</div>`;
  }
  log.addEventListener("click", (e) => {
    const r = e.target.closest(".ref"); if (r) { app.selectByName(r.dataset.name); return; }
    if (e.target.closest("[data-act=settings]")) app.openSettings();
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); if (busy) { ctrl && ctrl.abort(); return; } const t = input.value.trim(); if (t) send(t); });
  $("#aiNew").addEventListener("click", () => { if (busy && ctrl) ctrl.abort(); messages = []; emptyState(); renderCtx(); });

  function addUser(text) { const d = document.createElement("div"); d.className = "msg user"; d.textContent = text; log.appendChild(d); scroll(); }
  function addBot() { const d = document.createElement("div"); d.className = "msg bot"; log.appendChild(d); return d; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function setBusy(v) { busy = v; sendBtn.textContent = v ? "Stop" : "Send"; renderCtx(); }

  /* ---------------- API loop ---------------- */
  async function send(text) {
    if (busy) return;
    if (!app.hasBackend) { const d = addBot(); d.innerHTML = `<p class="err-msg">The assistant runs through the Trace Lab desktop app, which keeps your API key off the page. Open this page from TraceLab.exe.</p>`; return; }
    if (!app.config.hasKey) { const d = addBot(); d.innerHTML = `<p>Add your Anthropic API key in <button class="btn" data-act="settings">Settings</button> first.</p>`; scroll(); return; }
    if (!messages.length) log.innerHTML = "";
    input.value = ""; input.style.height = "auto"; addUser(text);
    const base = messages.length;
    messages.push({ role: "user", content: [{ type: "text", text: contextBlock() + "\n\n" + text }] });
    setBusy(true); ctrl = new AbortController();
    let bubble = addBot();
    try {
      for (let turn = 0; turn < 16; turn++) {
        const res = await stream(bubble, ctrl.signal);
        messages.push({ role: "assistant", content: res.content });
        if (res.stop_reason !== "tool_use") { if (res.stop_reason === "max_tokens") appendNote(bubble, "Reply was cut off at the length limit. Ask it to continue."); break; }
        const results = [];
        for (const blk of res.content.filter((c) => c.type === "tool_use")) {
          const chip = bubble.querySelector(`[data-tool="${blk.id}"]`);
          let out; try { const fn = T[blk.name]; out = fn ? await fn(blk.input || {}) : `Unknown tool ${blk.name}`; } catch (err) { out = "Tool error: " + (err.message || err); }
          if (chip) chip.classList.remove("run");
          results.push({ type: "tool_result", tool_use_id: blk.id, content: typeof out === "string" ? out : out });
        }
        messages.push({ role: "user", content: results });
        bubble = addBot();
      }
    } catch (err) {
      if (err.name === "AbortError") appendNote(bubble, "Stopped.");
      else { const p = document.createElement("p"); p.className = "err-msg"; p.innerHTML = app.esc(err.message || String(err)) + (err.settings ? ` <button class="btn" data-act="settings">Open Settings</button>` : ""); bubble.appendChild(p); }
      // roll history back to before this question so the next request is well-formed
      messages.length = base;
    } finally {
      bubble.querySelectorAll(".tool.run").forEach((c) => c.classList.remove("run"));
      if (!bubble.textContent.trim()) bubble.remove();
      setBusy(false); ctrl = null; scroll();
    }
  }
  function appendNote(bubble, t) { const p = document.createElement("p"); p.className = "foot"; p.textContent = t; bubble.appendChild(p); }
  function prepared() {
    // keep images only in the three most recent tool-result turns to bound context size
    const out = JSON.parse(JSON.stringify(messages)); let keep = 3;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]; if (m.role !== "user") continue; const tr = m.content.filter((c) => c.type === "tool_result" && Array.isArray(c.content) && c.content.some((x) => x.type === "image"));
      if (!tr.length) continue; if (keep > 0) { keep--; continue; }
      tr.forEach((c) => (c.content = c.content.map((x) => (x.type === "image" ? { type: "text", text: "[earlier image removed to save context; call the view tool again if needed]" } : x))));
    }
    // cache the conversation prefix
    const lastUser = [...out].reverse().find((m) => m.role === "user"); if (lastUser) { const c = lastUser.content[lastUser.content.length - 1]; if (c && c.type !== "image") c.cache_control = { type: "ephemeral" }; }
    return out;
  }
  async function stream(bubble, signal) {
    const body = { model: app.config.model || "claude-sonnet-5-5", max_tokens: 4096, stream: true, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], tools: TOOLS, messages: prepared() };
    const r = await app.api("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!r.ok) {
      let msg = `The assistant request failed (HTTP ${r.status}).`; let j = null; try { j = await r.json(); } catch (e) {}
      const em = j && j.error && j.error.message;
      if (r.status === 401) { const e = new Error("Your Anthropic API key was rejected. Check it in Settings."); e.settings = true; throw e; }
      if (r.status === 428) { const e = new Error("Add your Anthropic API key in Settings first."); e.settings = true; throw e; }
      if (r.status === 404 && em && /model/i.test(em)) { const e = new Error(`The model "${body.model}" isn't available on your API key. Pick another model in Settings.`); e.settings = true; throw e; }
      if (r.status === 429) msg = "Rate limited by the API. Wait a moment and try again.";
      else if (r.status === 529 || r.status === 503) msg = "The API is overloaded right now. Try again in a minute.";
      else if (r.status === 502) msg = "Trace Lab couldn't reach api.anthropic.com. Check your internet connection." + (em ? " (" + em + ")" : "");
      else if (em) msg += " " + em;
      throw new Error(msg);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    const content = []; let stop = null; const partial = new Map(); let textEl = null, textAcc = "", raf = 0;
    const paint = () => { raf = 0; if (textEl) { textEl.innerHTML = md(textAcc); linkify(textEl); scroll(); } };
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx; while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const dl = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); if (!dl) continue;
        let ev; try { ev = JSON.parse(dl); } catch (e) { continue; }
        if (ev.type === "content_block_start") {
          const cb = ev.content_block; content[ev.index] = cb.type === "text" ? { type: "text", text: "" } : cb.type === "tool_use" ? { type: "tool_use", id: cb.id, name: cb.name, input: {} } : cb;
          if (cb.type === "text") { textEl = document.createElement("div"); bubble.appendChild(textEl); textAcc = ""; }
          if (cb.type === "tool_use") { partial.set(ev.index, ""); const chip = document.createElement("span"); chip.className = "tool run"; chip.dataset.tool = cb.id; chip.textContent = (TOOL_LABEL[cb.name] || (() => cb.name))({}); bubble.appendChild(chip); scroll(); }
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta") { content[ev.index].text += d.text; textAcc += d.text; if (!raf) raf = requestAnimationFrame(paint); }
          else if (d.type === "input_json_delta") partial.set(ev.index, (partial.get(ev.index) || "") + d.partial_json);
        } else if (ev.type === "content_block_stop") {
          const blk = content[ev.index];
          if (blk && blk.type === "tool_use") { try { blk.input = JSON.parse(partial.get(ev.index) || "{}"); } catch (e) { blk.input = {}; } const chip = bubble.querySelector(`[data-tool="${blk.id}"]`); if (chip) chip.textContent = (TOOL_LABEL[blk.name] || (() => blk.name))(blk.input); }
          if (blk && blk.type === "text") { paint(); textEl = null; }
        } else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
        else if (ev.type === "error") { throw new Error("API error: " + ((ev.error && ev.error.message) || "unknown")); }
      }
    }
    if (raf) { cancelAnimationFrame(raf); paint(); }
    return { content: content.filter(Boolean).filter((c) => !(c.type === "text" && !c.text)), stop_reason: stop };
  }

  /* ---------------- markdown ---------------- */
  function inline(s) {
    return s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  }
  function md(src) {
    const esc = app.esc; const lines = src.replace(/\r/g, "").split("\n"); let html = "", i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) { let code = ""; i++; while (i < lines.length && !/^```/.test(lines[i])) code += lines[i++] + "\n"; i++; html += `<pre><code>${esc(code)}</code></pre>`; continue; }
      const h = l.match(/^(#{1,4})\s+(.*)$/); if (h) { html += `<h${h[1].length + 1}>${inline(esc(h[2]))}</h${h[1].length + 1}>`; i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const row = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(esc(c.trim())));
        html += "<table><tr>" + row(l).map((c) => `<th>${c}</th>`).join("") + "</tr>"; i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { html += "<tr>" + row(lines[i]).map((c) => `<td>${c}</td>`).join("") + "</tr>"; i++; }
        html += "</table>"; continue;
      }
      if (/^\s*([-*]|\d+[.)])\s+/.test(l)) {
        const ordered = /^\s*\d+[.)]/.test(l); html += ordered ? "<ol>" : "<ul>";
        while (i < lines.length && /^\s*([-*]|\d+[.)])\s+/.test(lines[i])) { let item = lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ""); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+[.)])\s+/.test(lines[i])) item += " " + lines[i++].trim(); html += `<li>${inline(esc(item))}</li>`; }
        html += ordered ? "</ol>" : "</ul>"; continue;
      }
      if (!l.trim()) { i++; continue; }
      let para = l; i++; while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para += "\n" + lines[i++];
      html += `<p>${inline(esc(para)).replace(/\n/g, "<br>")}</p>`;
    }
    return html;
  }
  function linkify(root) {
    const b = board(); if (!b) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = /[A-Za-z0-9_+\-\/#\[\]]*[A-Za-z][A-Za-z0-9_+\-\/#\[\]]*/g;
    for (const n of nodes) {
      if (n.parentElement.closest(".ref,pre")) continue;
      const s = n.nodeValue; let m, last = 0, frag = null;
      re.lastIndex = 0;
      while ((m = re.exec(s))) {
        const w = m[0].replace(/[.\-\/]+$/, ""); const u = w.toUpperCase();
        if (w.length < 2 || !(b.netByUpper.has(u) || b.partByName.has(u))) continue;
        frag = frag || document.createDocumentFragment();
        frag.appendChild(document.createTextNode(s.slice(last, m.index)));
        const btn = document.createElement("button"); btn.type = "button"; btn.className = "ref"; btn.dataset.name = w; btn.textContent = w; btn.title = b.netByUpper.has(u) ? "Show net on board" : "Show part on board";
        frag.appendChild(btn); last = m.index + w.length;
      }
      if (frag) { frag.appendChild(document.createTextNode(s.slice(last))); n.parentNode.replaceChild(frag, n); }
    }
  }

  emptyState(); renderCtx();
  return {
    refresh() { if (!messages.length) emptyState(); renderCtx(); },
    askAboutSelection() {
      const sel = S.sel; if (!sel) return;
      const w = $("#work"); if (!w.classList.contains("ai")) $("#aiToggle").click();
      send(sel.type === "net" ? `Diagnose ${sel.name}: what creates it, what it feeds, and how to check it.` : sel.type === "part" ? `What does ${sel.name} do, and how do I test it?` : `Where is ${sel.name} used?`);
    },
    tools: T, md,
  };
}
