// Flux, Trace Lab's repair assistant: an AI model with tools that read the loaded boardview and
// schematic, the user's readings database and live bench instruments, and that can walk the user
// through probing points one at a time.
const $ = (s) => document.querySelector(s);

const SYSTEM = `You are Flux, the repair assistant inside Trace Lab, a boardview and schematic viewer used by technicians doing component-level repair of laptop, desktop, phone, console and GPU motherboards.

You can inspect the board the user has open through tools:
- board_overview: parts, likely power rails, ICs, connectors, schematic page headings.
- find: search nets, parts and schematic text.
- get_net / get_part: pins, connected parts with values, subnets reached through series parts (resistors, inductors, ferrites, fuses, jumpers), schematic pages, and the user's logged readings.
- read_schematic_text: the words on a schematic page or around a name.
- view_schematic: an image of a schematic page or a zoomed crop around a name. Use this whenever wiring matters (what drives an enable pin, which MOSFET switches a rail, divider values, pull-ups), because extracted text loses the connections.
- view_board: an image of the board view (optionally focused on a net or part).
- highlight: select a net or part in the viewer so the user can see it.
- get_readings: the user's diode-mode, voltage and resistance readings for this board, and which nets they marked known-good or faulty.
- known_readings: search every board the user has worked on for a net name, to compare against a known-good value measured before or to see where a rail has failed previously.
- bench_status / measure / instrument_history / scope_screenshot: live bench instruments the user has connected (multimeter, bench power supply, oscilloscope). measure takes a reading now; instrument_history shows how a value changed (e.g. the supply's current draw while the board tries to power on); scope_screenshot shows the scope's screen.
- request_probe: ask the user to put the meter leads on one point. The app highlights the point on the board, switches a connected meter to the right function, shows the live reading and captures it when it's steady (or the user types it). You get the measured value back, and it's saved to the readings database.

How to work:
- Ground every specific claim (designators, net names, pin numbers, values, page numbers) in tool results. Never invent a designator, net or value. If the files don't show something, say so and say how the user can measure or check it.
- Look before you answer: for a rail or signal question, call get_net first, then view_schematic on the page that generates it.
- Think like an experienced bench tech. Typical flow: visual inspection and liquid damage, then main input/battery rail for shorts (resistance and diode mode to ground), always-on rails (often named G3H, ALW, AON, S5, DSW or RTC), EC/SMC/PCH standby power, power button and enable chain, power-good signals, then sleep-state rails (S3/S0), CPU/GPU core, memory. Check the regulator's input, enable, feedback, bootstrap, switching node and output in that order.
- For shorts: identify the rail, the parts on it and their locations, then suggest finding the hot component with voltage injection (current-limited, never above the rail's nominal voltage), a thermal camera, freeze spray or isopropyl/rosin, or by lifting inductors/jumpers to split the rail. Point out the rail's subnets and the series parts that can be lifted to isolate sections.
- Interpret the user's readings. Diode-mode and resistance values vary by board, so describe typical ranges as typical, compare against similar rails on the same board, and call known_readings to compare against a known-good value the user logged on another board before guessing. When the user marks a net known-good or faulty, treat that as ground truth.
- Mention safety where relevant: ESD, battery disconnection, current limits when injecting, hot air near plastic connectors and BGA underfill.

Bench instruments and guided diagnosis:
- <app_context> lists connected instruments and their live readings. Use them: a supply stuck at a few tens of mA usually means only standby rails are up; current that rises then drops back means a protection or power-good failure; high current at low voltage or a supply in CC (current limiting) means a short.
- When the user starts a guided diagnosis, or whenever a measurement is the next step, drive the session with request_probe: ONE point per call, chosen to split the problem in half. Say in 'why' what the reading will tell you, give an 'expected' range when you can, and state the board condition needed in 'condition' (e.g. "charger connected, board off" for voltages; "no power, battery disconnected" for diode and resistance).
- After each reading, explain in one or two sentences what it means, then request the next probe. Use known_readings to compare with known-good values. Don't make the user type readings into chat.
- Trace Lab only reads the power supply. Never claim to change its output; if the user needs to change voltage or current limit or inject voltage, tell them the exact values to set themselves.
- Finish by summarising the readings that matter, the most likely faulty part(s) with designators, and how to confirm and fix.

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
  { name: "view_board", description: "Image of the board viewer. With 'focus', selects that net or part first so it is highlighted (primary net orange, subnets in other colours, pins on the far side as dashed rings).", input_schema: { type: "object", properties: { focus: { type: "string" }, side: { type: "string", enum: ["top", "bottom", "both"], description: "'both' shows the butterfly view: top on the left, bottom mirrored on the right" } } } },
  { name: "highlight", description: "Select a net or part in the viewer so the user sees it on the board and schematic.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_readings", description: "All diode-mode, voltage and resistance readings the user has logged for the CURRENT board, by net, including which nets they marked known-good or faulty.", input_schema: { type: "object", properties: {} } },
  { name: "bench_status", description: "The bench instruments the user has connected (multimeter, power supply, oscilloscope) with their live readings.", input_schema: { type: "object", properties: {} } },
  { name: "measure", description: "Take a reading right now from a connected instrument, without asking the user to move the probes. Use it to read the bench supply's voltage and current draw, what the meter shows at the moment, or scope measurements.", input_schema: { type: "object", properties: { instrument: { type: "string", enum: ["multimeter", "power_supply", "oscilloscope"] }, mode: { type: "string", enum: ["voltage", "diode", "resistance", "ac_voltage", "continuity"], description: "Multimeter only: switch the meter to this function first (if it can be switched remotely)." }, channels: { type: "array", items: { type: "string" }, description: "Oscilloscope only: channels, e.g. [\"1\",\"2\"]" } }, required: ["instrument"] } },
  { name: "instrument_history", description: "How a live reading changed over the last N seconds: min, max, average and a time series. Use it for the supply's current draw during power-on (stuck, cycling, rising) or a drifting meter reading.", input_schema: { type: "object", properties: { instrument: { type: "string", enum: ["power_supply", "multimeter"] }, seconds: { type: "integer", description: "5 to 600, default 60" } }, required: ["instrument"] } },
  { name: "scope_screenshot", description: "Grab the connected oscilloscope's screen as an image, to see waveform shape (switching node, clock, ripple, PWM, data activity).", input_schema: { type: "object", properties: {} } },
  { name: "request_probe", description: "Ask the user to place the meter leads on ONE point and wait for the reading. The app highlights the point on the board, switches a connected multimeter to the right function, shows the live value, captures it when steady (or the user types it), saves it to the readings database and returns it. Call it once per measurement.", input_schema: { type: "object", properties: {
    net: { type: "string", description: "Net to measure, exactly as named in the boardview" }, part: { type: "string", description: "Optional: probe on this part's pin" }, pin: { type: "string", description: "Optional: pin number/name of that part" },
    mode: { type: "string", enum: ["voltage", "diode", "resistance", "ac_voltage", "continuity"] },
    leads: { type: "string", description: "Optional lead placement if not the default (default: voltage/resistance red on the point, black on ground; diode mode red on ground, black on the point)" },
    why: { type: "string", description: "One sentence: what this reading will tell us" }, expected: { type: "string", description: "Expected/healthy range, e.g. '0.35-0.65 V' or '≈3.3 V'" }, condition: { type: "string", description: "Board state for the measurement, e.g. 'charger connected, board off'" } }, required: ["mode", "why"] } },
  { name: "known_readings", description: "Search the readings database across ALL boards the user has worked on for a net name, to compare the current board against a known-good value measured on another board, or to see where this rail has failed before. Returns board, net, good/bad label and values.", input_schema: { type: "object", properties: { net: { type: "string", description: "Net name or partial name to look up, e.g. PP3V3 or VCORE. Leave empty to list the most recent readings on every board." }, status: { type: "string", enum: ["good", "bad"], description: "Optional: only known-good or only faulty readings" } } } },
];

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
      if (side === "both") app.setButterfly(true); else if (side) app.setSide(side === "bottom" ? "B" : "T");
      if (S.layout === "sch") app.setLayout("split");
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const c = app.captureBoard(1400); const data = c.toDataURL("image/png").split(",")[1];
      return [{ type: "text", text: `${what}Board view, ${app.isButterfly && app.isButterfly() ? "butterfly: top side on the left, bottom side mirrored on the right" : S.side === "B" ? "bottom side (mirrored)" : "top side"}. Primary net is orange; subnets use other colours; dashed rings are pins of highlighted nets on the other side; dark pins are ground.` }, { type: "image", source: { type: "base64", media_type: "image/png", data } }];
    },
    highlight({ name }) { const k = app.selectByName(name); return k ? `Selected ${k} ${name} in the viewer.` : `Nothing named "${name}".` + suggest(name); },
    get_readings() { const rd = app.getReadings(); const k = Object.keys(rd); return k.length ? k.map((n) => fmtReading(n, rd[n])).join("\n") : "The user hasn't logged any readings for this board yet. They can add them in the net panel (good/fault label, diode mode, voltage, resistance to ground)."; },
    async known_readings({ net, status }) {
      if (!app.hasBackend) return "The readings database needs the Trace Lab desktop app.";
      const b = board();
      try {
        const qs = new URLSearchParams({ net: net || "" }); if (status) qs.set("status", status); if (b) qs.set("exclude", b.name);
        const r = await app.api("/api/readings/search?" + qs.toString()); if (!r.ok) return "Couldn't search the readings database.";
        const hits = await r.json();
        if (!hits.length) return `No saved readings match "${net || "anything"}"${status ? " (" + status + ")" : ""} on any board yet. Known-good values build up as the user marks nets.`;
        return `${net ? `Readings matching "${net}"` : "Most recent readings"} across boards (most recent first):\n` + hits.map((h) => `${h.board} · ${h.net}${h.status ? " [" + (h.status === "good" ? "known good" : "fault") + "]" : ""}: ` + [h.diode && `diode ${h.diode}`, h.volts && `${h.volts} V`, h.ohms && `${h.ohms} Ω to GND`, h.note && `note: ${h.note}`].filter(Boolean).join(", ")).join("\n");
      } catch (e) { return "Couldn't search the readings database: " + e.message; }
    },
    bench_status() { const bn = app.bench; if (!bn) return "Bench instruments need the desktop app."; return bn.summary() + (bn.hasAny() ? "" : "\nNothing is connected right now. request_probe still works: the user types the reading."); },
    async measure({ instrument, mode, channels }) {
      const bn = app.bench; if (!bn) return "Bench instruments need the desktop app.";
      const kind = { multimeter: "dmm", power_supply: "psu", oscilloscope: "scope" }[instrument] || "dmm";
      const q = { kind }; if (mode) q.mode = MODES[mode]; if (channels && channels.length) { q.channels = channels.map(String); q.items = ["vpp", "vmax", "vmin", "vavg", "freq"]; }
      if (kind === "scope" && !q.items) q.items = ["vpp", "vmax", "vmin", "vavg", "freq"];
      try {
        const x = await bn.measure(q); const it = x.instrument;
        if (x.scope) return `${it.name} (oscilloscope): ${x.scope.text}`;
        return bn.describe(it);
      } catch (e) { return "Couldn't read it: " + e.message; }
    },
    async instrument_history({ instrument, seconds = 60 }) {
      const bn = app.bench; if (!bn) return "Bench instruments need the desktop app.";
      const kind = instrument === "multimeter" ? "dmm" : "psu"; seconds = Math.max(5, Math.min(600, seconds | 0 || 60));
      try {
        const h = await bn.history(kind, seconds); const sm = h.samples || []; if (!sm.length) return `No ${kind === "psu" ? "supply" : "meter"} readings recorded in the last ${seconds} s.`;
        const vs = sm.map((x) => x.v), unit = kind === "psu" ? "A" : ""; const t1 = sm[sm.length - 1].t;
        const mn = Math.min(...vs), mx = Math.max(...vs), avg = vs.reduce((a, b) => a + b, 0) / vs.length;
        const step = Math.max(1, Math.ceil(sm.length / 40)); const series = [];
        for (let i = 0; i < sm.length; i += step) { const x = sm[i]; series.push(`${((x.t - t1) / 1000).toFixed(1)}s: ${x.v.toFixed(4)}${unit}${kind === "psu" ? ` @ ${x.w.toFixed(2)}V` : ""}`); }
        return `${h.instrument}, last ${seconds} s (${sm.length} samples${kind === "dmm" ? ", mode " + h.mode : ""}): min ${mn.toFixed(4)}${unit}, max ${mx.toFixed(4)}${unit}, average ${avg.toFixed(4)}${unit}.\nSeries (seconds before now):\n${series.join("\n")}`;
      } catch (e) { return "Couldn't read the history: " + e.message; }
    },
    async scope_screenshot() {
      const bn = app.bench; if (!bn) return "Bench instruments need the desktop app.";
      try { const png = await bn.screenshot(); const s2 = bn.connected("scope"); return [{ type: "text", text: `Screen of ${s2 ? s2.name : "the oscilloscope"}${s2 && s2.state.scope ? ". Measurements: " + s2.state.scope.text : ""}.` }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]; }
      catch (e) { return "Couldn't grab the scope screen: " + e.message; }
    },
    request_probe(input) { return probe(input); },
  };
  const MODES = { voltage: "dcv", diode: "diode", resistance: "res", ac_voltage: "acv", continuity: "cont" };
  const MODE_NAME = { dcv: "DC voltage", diode: "Diode mode", res: "Resistance", acv: "AC voltage", cont: "Continuity" };

  /* ---------------- probe requests ---------------- */
  let probeN = 0, activeProbe = null, curBubble = null, curSignal = null;
  function pinNet(part, pin) {
    const b = board(); const p = resolvePart(part); if (!b || !p) return null;
    const pi = p.pins.find((i) => String(b.pins[i].num).toUpperCase() === String(pin).toUpperCase()); return pi === undefined ? null : { pi, net: b.pins[pi].net };
  }
  // A handy place to put the probe on a net: a test point or small 2-pin part on the visible side.
  function probeSpot(net) {
    const b = board(); if (!b) return null; const arr = b.nets.get(net) || []; let best = null, score = -1;
    for (const i of arr) { const p = b.pins[i], part = b.parts[p.part]; const pre = prefix(part.name);
      let sc = pre === "TP" || part.nail ? 5 : /^P?C$/.test(pre) && part.pins.length === 2 ? 4 : part.pins.length === 2 ? 3 : 1; if (part.side === "T") sc += 0.5;
      if (sc > score) { score = sc; best = { part: part.name, pin: p.num, side: part.side, pi: i }; } }
    return best;
  }
  const fmtDb = (mode, v, ol) => ol ? "OL" : mode === "res" || mode === "cont" ? (v >= 1e6 ? (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? (v / 1e3).toFixed(2) + "k" : v.toFixed(1)) : v.toFixed(3);
  function parseManual(t) {
    t = String(t).trim(); if (!t) return null; if (/^o\.?l\.?$|^open$|^inf/i.test(t)) return { v: 9.9e37, ol: true };
    const m = t.replace(",", ".").match(/^([-+]?\d*\.?\d+)\s*([kKmMuµ]?)/); if (!m) return null;
    const mult = { k: 1e3, K: 1e3, M: 1e6, m: 1e-3, u: 1e-6, "µ": 1e-6 }[m[2]] || 1; return { v: parseFloat(m[1]) * mult, ol: false };
  }
  function probe(inp) {
    const b = board(); if (!b) return "No boardview is loaded, so there's nothing to point the user at.";
    const mode = MODES[inp.mode] || "dcv"; let net = inp.net ? resolveNet(inp.net) : null, pinInfo = null;
    if (inp.part && inp.pin) { pinInfo = pinNet(inp.part, inp.pin); if (!pinInfo) return `Part ${inp.part} has no pin ${inp.pin}.` + suggest(inp.part); if (!net) net = pinInfo.net; }
    if (!net && inp.net) return `No net named "${inp.net}".` + suggest(inp.net);
    if (!net) return "Give a net (or a part and pin) to probe.";
    const spot = pinInfo ? { part: resolvePart(inp.part).name, pin: inp.pin, pi: pinInfo.pi, side: b.parts[b.pins[pinInfo.pi].part].side } : probeSpot(net);
    app.select({ type: "net", name: net }, spot ? { pin: spot.pi } : {});
    const gnd = [...b.gnd][0] || "GND";
    const where = spot ? `${spot.part} pin ${spot.pin} (${sideName(spot.side)} side)` : "any pin on the net";
    const leads = inp.leads || (mode === "diode" ? `Red lead on ${gnd}, black lead on ${net}` : mode === "res" || mode === "cont" ? `Red lead on ${net}, black lead on ${gnd}` : `Red lead on ${net}, black lead on ${gnd}`);
    open(true);
    const bn = app.bench; const meter = bn && bn.connected("dmm"); const remote = meter && (meter.modes || []).includes(mode);
    if (bn) { bn.hint(net); bn.setFast(true); if (remote && meter.state.meter && meter.state.meter.mode !== mode) bn.setMode(mode); }
    const n = ++probeN; const card = document.createElement("div"); card.className = "probe";
    const auto = (() => { try { return localStorage.getItem("tl.autocap") !== "0"; } catch (e) { return true; } })();
    card.innerHTML = `<div class="ph">Probe ${n}<span class="mode">${MODE_NAME[mode]}</span></div>
      <div class="leads"><span class="k red">Point</span><span><b>${app.esc(net)}</b> · e.g. ${app.esc(where)} <button class="linkbtn" data-p="show" style="margin:0">Show</button></span>
        <span class="k blk">Leads</span><span>${app.esc(leads)}</span>
        ${inp.condition ? `<span class="k blk">Board</span><span>${app.esc(inp.condition)}</span>` : ""}</div>
      <div class="why">${app.esc(inp.why || "")}</div>${inp.expected ? `<div class="exp">Expected: ${app.esc(inp.expected)}</div>` : ""}
      ${meter ? `<div class="live"><div class="lcd ol" data-p="lcd">—</div><div class="st" data-p="st">${remote ? "Meter set to " + MODE_NAME[mode] : "Set " + app.esc(meter.name) + " to " + MODE_NAME[mode]}</div></div><div class="bar2"><i data-p="bar"></i></div>
        <div class="row2"><button class="btn primary" data-p="cap">Capture <span class="kbd" style="margin-left:4px">Space</span></button><label class="chk"><input type="checkbox" data-p="auto" ${auto ? "checked" : ""}>Capture when steady</label></div>` :
        `<div class="foot">No multimeter connected, so type what your meter reads. <button class="linkbtn" data-p="setup" style="margin:0">Connect a meter</button></div>`}
      <div class="row2"><input data-p="man" placeholder="${meter ? "Or type a value" : "Reading, e.g. 0.452 or 3.31 or 12k or OL"}" aria-label="Type the reading"><button class="btn${meter ? "" : " primary"}" data-p="use">Use value</button><button class="btn" data-p="skip" title="Can't reach this point, or want to skip it">Skip</button></div>`;
    (curBubble || log).appendChild(card); scroll();
    const q = (k) => card.querySelector(`[data-p="${k}"]`);
    return new Promise((resolve) => {
      let samples = [], baseline = null, t0 = Date.now(), last = null, done = false, lastUpd = 0;
      const finish = async (val, how) => {
        if (done) return; done = true; activeProbe = null; unsub && unsub(); if (bn) bn.setFast(false); document.removeEventListener("keydown", onKey, true);
        card.classList.add("done");
        let saved = false, text;
        if (val === null) { text = `The user skipped ${net}${how ? ": " + how : ""}. Choose another point or approach.`; card.querySelectorAll(".row2,.live,.bar2").forEach((e) => e.remove()); card.insertAdjacentHTML("beforeend", `<div class="res skip">Skipped${how ? ": " + app.esc(how) : ""}</div>`); }
        else {
          const disp = val.ol ? "OL (open / over range)" : val.text || fmtDb(mode, val.v, false) + (mode === "res" || mode === "cont" ? " Ω" : " V");
          const field = { diode: "diode", dcv: "volts", res: "ohms", cont: "ohms" }[mode];
          if (field && app.saveReadingFor) { const r = await app.saveReadingFor(net, { [field]: fmtDb(mode, val.v, val.ol) }); saved = r && r.ok; }
          const psu = bn && bn.connected("psu"); const ps = psu && psu.state.psu ? ` Bench supply at that moment: ${psu.state.psu.volts.toFixed(2)} V, ${psu.state.psu.amps.toFixed(4)} A${psu.state.psu.cc ? " (current limiting)" : ""}.` : "";
          text = `Measured ${net}${spot ? ` at ${spot.part}.${spot.pin}` : ""}, ${MODE_NAME[mode]}${mode === "diode" ? " (" + leads + ")" : ""}: ${disp} (${how}).${saved ? " Saved to the readings database." : ""}${ps}`;
          card.querySelectorAll(".row2,.live,.bar2").forEach((e) => e.remove()); card.insertAdjacentHTML("beforeend", `<div class="res">✓ ${app.esc(disp)} <span class="foot" style="font-family:var(--f-ui);font-weight:400">· ${app.esc(how)}${saved ? " · saved to database" : ""}</span></div>`);
        }
        scroll(); resolve(text);
      };
      activeProbe = { finish, net };
      const capture = (how) => { if (last && last.meter) finish({ v: last.meter.value, ol: last.meter.ol, text: last.meter.text }, how || `captured from ${meter.name}`); };
      const onKey = (e) => { if (e.key === " " && !e.target.closest("input,textarea,select,button")) { e.preventDefault(); capture(); } };
      document.addEventListener("keydown", onKey, true);
      let unsub = null;
      if (meter) {
        unsub = bn.onUpdate((items) => {
          const m = items.find((i) => i.id === meter.id); if (!m || !m.state.meter || done) return; last = m.state; if (m.state.updated === lastUpd) return; lastUpd = m.state.updated;
          const r = m.state.meter, lcd = q("lcd"), st = q("st"), bar = q("bar"); if (!lcd) return;
          lcd.textContent = r.text; lcd.classList.toggle("ol", !!r.ol);
          const wrongMode = r.mode !== mode && !(mode === "cont" && r.mode === "res");
          const now = Date.now(); samples.push({ t: now, v: r.value, ol: r.ol }); samples = samples.filter((x) => x.t > now - 1300);
          if (!baseline && now - t0 > 500) baseline = { v: r.value, ol: r.ol };
          const tol = Math.max(Math.abs(r.value) * 0.01, mode === "res" || mode === "cont" ? 0.5 : 0.004);
          const steady = samples.length >= 3 && samples[0].t < now - 1000 && samples.every((x) => !x.ol && Math.abs(x.v - r.value) <= tol);
          const span = samples.length ? Math.min(1, (now - samples.findLast((x, i) => i === 0 || x.ol || Math.abs(x.v - r.value) > tol).t) / 1200) : 0;
          if (bar) bar.style.width = (r.ol ? 0 : Math.round(span * 100)) + "%";
          const moved = baseline && (baseline.ol ? !r.ol : Math.abs(r.value - baseline.v) > tol * 3);
          if (wrongMode) { st.className = "st"; st.textContent = `Meter is on ${(app.bench.modeLabels()[r.mode] || r.mode)}. Switch it to ${MODE_NAME[mode]}.`; return; }
          st.className = "st" + (steady ? " ok" : ""); st.textContent = r.ol ? "Waiting for the leads…" : steady ? (moved ? "Steady" : "Steady. Press Capture if this is the point") : "Settling…";
          const ac = q("auto"); if (steady && moved && ac && ac.checked) capture(`captured from ${meter.name} when steady`);
        });
      }
      card.addEventListener("click", (e) => {
        const t = e.target.closest("[data-p]"); if (!t) return; const k = t.dataset.p;
        if (k === "show") { app.select({ type: "net", name: net }, spot ? { pin: spot.pi } : {}); if (spot) app.selectByName(net); }
        else if (k === "cap") capture();
        else if (k === "setup") bn && bn.openSetup();
        else if (k === "use") { const v = parseManual(q("man").value); if (!v) { q("man").focus(); q("man").placeholder = "Enter a number, e.g. 0.452, 12k or OL"; return; } finish({ v: v.v, ol: v.ol }, "typed by the user"); }
        else if (k === "skip") finish(null, q("man").value.trim());
      });
      card.addEventListener("change", (e) => { if (e.target.dataset.p === "auto") { try { localStorage.setItem("tl.autocap", e.target.checked ? "1" : "0"); } catch (x) {} } });
      card.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.dataset.p === "man") { e.preventDefault(); q("use").click(); } });
      if (curSignal) curSignal.addEventListener("abort", () => finish(null, "session stopped"), { once: true });
      setTimeout(() => (meter ? card : q("man")).focus && (meter ? null : q("man").focus()), 50);
    });
  }
  function fmtReading(n, r) { return `${n}: ` + [r.status && (r.status === "good" ? "KNOWN GOOD" : "FAULT"), r.diode && `diode ${r.diode}`, r.volts && `voltage ${r.volts} V`, r.ohms && `to GND ${r.ohms} Ω`, r.note && `note: ${r.note}`].filter(Boolean).join(", "); }
  const TOOL_LABEL = { board_overview: () => "Reading board overview", find: (i) => `Searching “${i.query || ""}”`, get_net: (i) => `Checking net ${i.name || ""}`, get_part: (i) => `Checking part ${i.name || ""}`,
    read_schematic_text: (i) => `Reading schematic ${i.near ? "near " + i.near : "p." + (i.page || "")}`, view_schematic: (i) => `Viewing schematic ${i.near ? "at " + i.near : "p." + (i.page || "")}`, view_board: (i) => `Viewing board${i.focus ? " at " + i.focus : ""}`, highlight: (i) => `Highlighting ${i.name || ""}`, get_readings: () => "Reading your measurements", known_readings: (i) => `Known readings for ${i.net || ""}`,
    bench_status: () => "Checking the bench", measure: (i) => `Reading the ${(i.instrument || "meter").replace("_", " ")}`, instrument_history: (i) => `Looking at ${(i.instrument || "").replace("_", " ")} history`,
    scope_screenshot: () => "Grabbing the scope screen", request_probe: (i) => `Probe ${i.net || (i.part ? i.part + "." + (i.pin || "") : "")}` };

  /* ---------------- context + UI ---------------- */
  function contextBlock() {
    const b = board(), sch = S.sch, sel = S.sel; const L = [];
    L.push(b ? `Board: ${b.name} (${b.format || "?"}), ${b.parts.length} parts, ${b.nets.size} nets${b.sample ? " [built-in sample, not the user's board]" : ""}.` : "Board: none loaded.");
    L.push(sch ? `Schematic: ${sch.name}, ${sch.pages.length} pages${sch.noText ? ", no text layer" : ""}. Viewer is on page ${app.sv.page + 1}.` : "Schematic: none loaded.");
    if (sel) L.push(`Current selection: ${sel.type} ${sel.name}.`);
    const rd = app.getReadings(); const ks = Object.keys(rd); if (ks.length) L.push("Logged readings:\n" + ks.slice(0, 40).map((k) => fmtReading(k, rd[k])).join("\n"));
    if (app.bench && app.bench.items.length) L.push("Bench instruments:\n" + app.bench.summary());
    return `<app_context>\n${L.join("\n")}\n</app_context>`;
  }
  function renderCtx() {
    const b = board(), sel = S.sel;
    const nb = app.bench ? app.bench.items.filter((i) => i.state.status === "connected").length : 0;
    ctxEl.innerHTML = b ? `Context: <b>${app.esc(b.name)}</b>${S.sch ? " + schematic" : ""}${sel ? ` · selected <b>${app.esc(sel.name)}</b>` : ""}${nb ? ` · ${nb} instrument${nb > 1 ? "s" : ""} live` : ""}` : "Open a boardview to give Flux something to read.";
    const qs = !sel ? ["The board won't power on. Where do I start?", "Map the main power rails and what creates each one", "Walk me through this board's power-on sequence"]
      : sel.type === "net" ? [`Diagnose ${sel.name}`, `What generates ${sel.name} and what enables it?`, `${sel.name} is shorted to ground. How do I find the short?`, `What readings should ${sel.name} have?`]
      : sel.type === "part" ? [`What does ${sel.name} do?`, `How do I test ${sel.name}?`, `What powers ${sel.name}?`] : [`Where is ${sel.name} used?`];
    quick.innerHTML = busy ? "" : qs.map((t) => `<button type="button">${app.esc(t)}</button>`).join("");
    const mdl = (app.config.model || "").replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/^.*\//, "");
    if (app.refreshModelPicker) app.refreshModelPicker(); else $("#aiModelSel").innerHTML = `<option>${app.esc(mdl)}</option>`;
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
    const ready = app.config.hasKey || app.config.provider === "custom" || (app.config.provider === "local" && app.config.local_model);
    log.innerHTML = `<div class="ai-empty"><h3>Hi, I'm Flux.</h3><div>Ask about a fault, a rail or a part. I read this board and its schematic, your saved readings, and any meter, supply or scope you connect.</div><div>Press <button class="btn" data-act="guide">Guided diagnosis</button> and I'll ask you to probe points one at a time and work out the fault from your readings.</div>${ready ? "" : `<div class="notice">Turn me on with a free <button class="btn" data-act="offline">Offline AI</button> model that runs on this PC, or connect a cloud service (Claude, OpenAI, Gemini, OpenRouter) in <button class="btn" data-act="settings">Settings</button>.</div>`}</div>`;
  }
  log.addEventListener("click", (e) => {
    const r = e.target.closest(".ref"); if (r) { app.selectByName(r.dataset.name); return; }
    if (e.target.closest("[data-act=settings]")) app.openSettings();
    if (e.target.closest("[data-act=guide]")) guideCard();
    if (e.target.closest("[data-act=offline]")) app.openLocalAI();
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(180, input.scrollHeight) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", (e) => { e.preventDefault(); if (busy) { ctrl && ctrl.abort(); return; } const t = input.value.trim(); if (t) send(t); });
  $("#aiNew").addEventListener("click", () => { if (busy && ctrl) ctrl.abort(); messages = []; emptyState(); renderCtx(); });
  $("#aiGuide").addEventListener("click", () => guideCard());

  /* ---------------- floating panel ---------------- */
  const panel = $("#aiPane");
  function open(on) { app.toggleAI(on === undefined ? true : on); }
  (() => { // drag the panel by its header; remember where it was left
    const head = $("#aiHead"); let d = null;
    try { const p = JSON.parse(localStorage.getItem("tl.fluxpos") || "null"); if (p) { panel.style.right = p.r + "px"; panel.style.bottom = p.b + "px"; } } catch (e) {}
    head.addEventListener("pointerdown", (e) => { if (e.target.closest("button,select")) return; const r = panel.getBoundingClientRect(); d = { x: e.clientX, y: e.clientY, r: window.innerWidth - r.right, b: window.innerHeight - r.bottom }; head.setPointerCapture(e.pointerId); });
    head.addEventListener("pointermove", (e) => { if (!d) return; const r = Math.max(0, Math.min(window.innerWidth - 200, d.r - (e.clientX - d.x))), bb = Math.max(0, Math.min(window.innerHeight - 120, d.b - (e.clientY - d.y))); panel.style.right = r + "px"; panel.style.bottom = bb + "px"; });
    head.addEventListener("pointerup", () => { if (!d) return; d = null; try { localStorage.setItem("tl.fluxpos", JSON.stringify({ r: parseInt(panel.style.right) || 18, b: parseInt(panel.style.bottom) || 58 })); } catch (e) {} });
    head.addEventListener("dblclick", (e) => { if (e.target.closest("button")) return; panel.style.right = ""; panel.style.bottom = ""; panel.style.width = ""; panel.style.height = ""; try { localStorage.removeItem("tl.fluxpos"); } catch (x) {} });
  })();
  $("#aiMin").addEventListener("click", () => open(false));

  /* ---------------- guided diagnosis ---------------- */
  const SYMPTOMS = ["Dead, no power", "Won't charge", "Short on a rail", "Powers on, no display", "Turns off or restarts", "Liquid damage"];
  function guideCard() {
    open(true);
    if (!messages.length) log.innerHTML = "";
    log.querySelectorAll(".guide").forEach((g) => g.remove());
    const sel = S.sel && S.sel.type === "net" ? S.sel.name : null; const bn = app.bench;
    const live = bn ? bn.items.filter((i) => i.state.status === "connected") : [];
    const card = document.createElement("div"); card.className = "guide";
    card.innerHTML = `<h4>Guided diagnosis</h4><p>I'll ask you to probe one point at a time, read your meter live, and narrow down the fault from the readings. Every reading is saved to your database.</p>
      <div class="chips" role="group" aria-label="Symptom">${SYMPTOMS.map((t) => `<button type="button" class="chip" aria-pressed="false">${t}</button>`).join("")}</div>
      <textarea placeholder="Anything else? e.g. 20 V at 0.02 A on the supply, fan spins then stops, was dropped" aria-label="Details"></textarea>
      ${sel ? `<label class="chk"><input type="checkbox" data-g="from" checked>Start from ${app.esc(sel)}</label>` : ""}
      <div class="tools">${live.length ? "Live: " + live.map((i) => `<i class="sdot connected" style="display:inline-block;margin:0 4px 0 6px"></i>${app.esc(i.name)}`).join("") + (live.some((i) => i.kind === "dmm") ? ". I'll switch the meter's function for each probe when it supports it." : ". No meter connected, so you'll type readings in.")
        : `No instruments connected, so you'll type readings in. <button class="linkbtn" data-g="setup" style="margin:0">Connect a meter or supply</button>`}</div>
      <div class="row2"><button class="btn primary" data-g="go"${board() ? "" : " disabled"}>Start guided diagnosis</button>${board() ? "" : `<span class="foot">Open a boardview first.</span>`}</div>`;
    log.appendChild(card); scroll();
    card.addEventListener("click", (e) => {
      const c = e.target.closest(".chip"); if (c) { c.setAttribute("aria-pressed", c.getAttribute("aria-pressed") !== "true"); return; }
      const g = e.target.closest("[data-g]"); if (!g) return;
      if (g.dataset.g === "setup") bn && bn.openSetup();
      if (g.dataset.g === "go") {
        const sym = [...card.querySelectorAll(".chip[aria-pressed=true]")].map((x) => x.textContent); const extra = card.querySelector("textarea").value.trim();
        const from = sel && card.querySelector("[data-g=from]") && card.querySelector("[data-g=from]").checked ? sel : null;
        const shown = `Guided diagnosis: ${sym.join(", ") || "help me find the fault"}${extra ? " — " + extra : ""}${from ? ` (start at ${from})` : ""}`;
        const prompt = `Start a guided diagnosis.\nSymptom: ${sym.join(", ") || "not given, ask me if you need it"}.${extra ? "\nDetails: " + extra : ""}${from ? "\nStart from net " + from + "." : ""}\nLead me step by step: check the board files first, then ask me to probe one point at a time with request_probe, use each reading before choosing the next point, watch the bench supply's current draw if one is connected, and finish with the most likely faulty part(s) and how to confirm.`;
        card.remove(); send(prompt, { display: shown, guided: true });
      }
    });
  }

  function addUser(text) { const d = document.createElement("div"); d.className = "msg user"; d.textContent = text; log.appendChild(d); scroll(); }
  function addBot() { const d = document.createElement("div"); d.className = "msg bot"; log.appendChild(d); return d; }
  function scroll() { log.scrollTop = log.scrollHeight; }
  function setBusy(v) { busy = v; sendBtn.textContent = v ? "Stop" : "Send"; $("#aiModelSel").disabled = v; renderCtx(); }

  /* ---------------- API loop (provider-agnostic) ----------------
     History is kept in a neutral form and converted to each service's wire format at send time:
       { role:"user", text }
       { role:"assistant", text, calls:[{id,name,input}] }
       { role:"tool", results:[{id,name,text,images:[b64…]}] }                                   */
  function providerLabel() { const p = app.config.provider || "anthropic"; return (app.PROVIDERS[p] && app.PROVIDERS[p].label) || p; }
  function toolToNeutral(out) {
    if (typeof out === "string") return { text: out, images: [] };
    let text = "", images = [];
    for (const part of out) { if (part.type === "text") text += (text ? "\n" : "") + part.text; else if (part.type === "image") images.push(part.source.data); }
    return { text: text || "(image attached)", images };
  }
  function prepared() {
    // Keep requests small: every tool step resends the history, and low-tier API plans have tight
    // per-minute token limits. Images survive only in the latest tool turn; older tool text is shortened.
    const out = JSON.parse(JSON.stringify(messages)); let seen = 0;
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]; if (m.role !== "tool") continue; seen++;
      m.results.forEach((r) => {
        if (seen > 1 && r.images && r.images.length) { r.text = (r.text ? r.text + " " : "") + "[earlier image removed to save context; call the view tool again if needed]"; r.images = []; }
        if (seen > 2 && r.text && r.text.length > 1500) r.text = r.text.slice(0, 1500) + "\n…[earlier tool output shortened; call the tool again for full detail]";
      });
    }
    return out;
  }
  function makeSink(bubble) {
    let textEl = null, acc = "", raf = 0;
    const paint = () => { raf = 0; if (textEl) { textEl.innerHTML = md(acc); linkify(textEl); scroll(); } };
    return {
      onText(d) { if (!textEl) { textEl = document.createElement("div"); bubble.appendChild(textEl); acc = ""; } acc += d; if (!raf) raf = requestAnimationFrame(paint); },
      toolStart(id, name) { const chip = document.createElement("span"); chip.className = "tool run"; chip.dataset.tool = id; chip.textContent = (TOOL_LABEL[name] || (() => name))({}); bubble.appendChild(chip); scroll(); },
      toolLabel(id, name, input) { const chip = bubble.querySelector(`[data-tool="${id}"]`); if (chip) chip.textContent = (TOOL_LABEL[name] || (() => name))(input); },
      end() { if (raf) cancelAnimationFrame(raf); paint(); textEl = null; },
    };
  }
  async function readSSE(r, onEvent) {
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx; while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const dl = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""); if (!dl) continue;
        if (dl === "[DONE]") return;
        let ev; try { ev = JSON.parse(dl); } catch (e) { continue; } onEvent(ev);
      }
    }
  }
  async function postStream(provider, body, signal) {
    const r = await app.api("/api/messages", { method: "POST", headers: { "Content-Type": "application/json", "X-TL-Provider": provider }, body: JSON.stringify(body), signal });
    if (!r.ok) {
      let j = null; try { j = JSON.parse(await r.text()); } catch (e) {}
      if (Array.isArray(j)) j = j[0]; // Gemini wraps errors in an array
      const eo = (j && (j.error || j)) || {};
      const em = typeof eo.message === "string" ? eo.message : "";
      const code = String(eo.code || eo.status || eo.type || "");
      const who = providerLabel(); let msg = `The assistant request failed (HTTP ${r.status}).`; let settings = false, retry = false;
      if (provider === "local") { const e = new Error(r.status === 428 ? em : "The offline AI couldn't answer: " + (em || "HTTP " + r.status)); e.local = true; throw e; }
      const quota = /insufficient_quota|billing|credit|exceeded your current quota|quota exceeded|RESOURCE_EXHAUSTED.*(day|daily)|per day/i.test(code + " " + em);
      if (r.status === 401 || r.status === 403) { msg = `${who} rejected the API key. Check it in Settings.`; settings = true; }
      else if (r.status === 428) { msg = em || `Set up the ${who} connection in Settings first.`; settings = true; }
      else if (r.status === 404) { msg = `${who} doesn't offer the model "${body.model}" to your key. Open Settings and pick one from the list (use "Load models").`; settings = true; }
      else if (r.status === 400 && /image|vision|multimodal/i.test(em)) { msg = `The model "${body.model}" can't read images, which the assistant sends. Pick a vision model in Settings.`; settings = true; }
      else if (r.status === 429 && quota) { msg = `${who} says your account is out of credit or quota, so it refused the request. ` + (app.config.provider === "openai" ? "Add prepaid credit at platform.openai.com → Settings → Billing, then try again." : "Check your plan or billing with the provider, or switch service in Settings."); settings = true; }
      else if (r.status === 429) { msg = `${who} rate-limited the request.`; retry = true; }
      else if (r.status === 502) msg = `Trace Lab couldn't reach ${who}.` + (em ? "" : " Check your connection.");
      else if (r.status === 500 || r.status === 503 || r.status === 529) { msg = `${who} is overloaded or had an error.`; retry = true; }
      if (em && !msg.includes(em)) msg += ` (${who}: ${em.slice(0, 300)})`;
      const e = new Error(msg); e.settings = settings; e.retry = retry; e.status = r.status;
      e.retryAfter = parseFloat(r.headers.get("retry-after")) || 0; throw e;
    }
    return r;
  }
  // Retry rate limits and transient overloads with the server's Retry-After, else exponential backoff.
  async function withRetry(fn, bubble, signal) {
    for (let attempt = 0; ; attempt++) {
      try { return await fn(); }
      catch (err) {
        if (!err.retry || attempt >= 3 || signal.aborted) throw err;
        const wait = Math.min(60, err.retryAfter || 5 * 2 ** attempt);
        const note = document.createElement("p"); note.className = "foot";
        note.textContent = `${err.message} Retrying in ${Math.round(wait)} s (attempt ${attempt + 2} of 4)…`; bubble.appendChild(note); scroll();
        await new Promise((res, rej) => { const t = setTimeout(res, wait * 1000); signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("Stopped"), { name: "AbortError" })); }, { once: true }); });
        note.remove();
      }
    }
  }
  // ---- Anthropic Messages API ----
  function toAnthropic(neu) {
    return neu.map((m) => {
      if (m.role === "user") return { role: "user", content: [{ type: "text", text: m.text }] };
      if (m.role === "assistant") { const content = []; if (m.text) content.push({ type: "text", text: m.text }); for (const c of m.calls || []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input || {} }); return { role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] }; }
      return { role: "user", content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.images && r.images.length ? [{ type: "text", text: r.text }, ...r.images.map((d) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: d } }))] : r.text })) };
    });
  }
  async function streamAnthropic(sink, signal) {
    const tools = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? Object.assign({ cache_control: { type: "ephemeral" } }, t) : t));
    const body = { model: app.config.model || "claude-sonnet-5-5", max_tokens: 4096, stream: true, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], tools, messages: toAnthropic(prepared()) };
    const r = await postStream("anthropic", body, signal);
    const blocks = []; const partial = new Map(); let text = "", stop = null;
    await readSSE(r, (ev) => {
      if (ev.type === "content_block_start") {
        const cb = ev.content_block; blocks[ev.index] = cb.type === "tool_use" ? { type: "tool_use", id: cb.id, name: cb.name } : { type: "text" };
        if (cb.type === "tool_use") { partial.set(ev.index, ""); sink.toolStart(cb.id, cb.name); }
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d.type === "text_delta") { text += d.text; sink.onText(d.text); }
        else if (d.type === "input_json_delta") partial.set(ev.index, (partial.get(ev.index) || "") + d.partial_json);
      } else if (ev.type === "content_block_stop") {
        const b = blocks[ev.index];
        if (b && b.type === "tool_use") { try { b.input = JSON.parse(partial.get(ev.index) || "{}"); } catch (e) { b.input = {}; } sink.toolLabel(b.id, b.name, b.input); }
      } else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason; }
      else if (ev.type === "error") throw new Error("API error: " + ((ev.error && ev.error.message) || "unknown"));
    });
    const calls = blocks.filter((b) => b && b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
    return { text, calls, stop: stop === "tool_use" ? "tool" : stop === "max_tokens" ? "length" : "end" };
  }
  // ---- OpenAI-compatible Chat Completions (OpenAI, Gemini, OpenRouter, local/custom) ----
  const openaiTools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  function toOpenAI(neu, provider) {
    const out = [{ role: "system", content: SYSTEM }];
    for (const m of neu) {
      if (m.role === "user") out.push({ role: "user", content: m.text });
      else if (m.role === "assistant") { const msg = { role: "assistant", content: m.text || null }; if (m.calls && m.calls.length) msg.tool_calls = m.calls.map((c, i) => {
          const tc = { id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input || {}) } };
          // Gemini 3 needs its thought signature echoed back on each function call. Calls made by another provider
          // earlier in the chat have none, so the first call of the turn gets Google's documented bypass value.
          if (c.extra) tc.extra_content = c.extra;
          else if (provider === "gemini" && i === 0) tc.extra_content = { google: { thought_signature: "skip_thought_signature_validator" } };
          return tc;
        });
        if (m.reasoning && m.reasoning.length) msg.reasoning_details = m.reasoning; // OpenRouter: keeps Gemini/other reasoning state across tool calls
        out.push(msg); }
      else { const imgs = []; for (const r of m.results) { out.push({ role: "tool", tool_call_id: r.id, content: r.text || "(no text)" }); for (const d of r.images || []) imgs.push(d); } if (imgs.length) out.push({ role: "user", content: [{ type: "text", text: "Images returned by the tools above:" }, ...imgs.map((d) => ({ type: "image_url", image_url: { url: "data:image/png;base64," + d } }))] }); }
    }
    return out;
  }
  async function streamOpenAI(sink, signal, provider) {
    const body = { model: app.config.model, stream: true, messages: toOpenAI(prepared(), provider), tools: openaiTools, tool_choice: "auto" };
    const r = await postStream(provider, body, signal);
    let text = "", stop = null; const calls = []; const reasoning = []; // calls: index -> {id,name,args,extra}
    await readSSE(r, (ev) => {
      const ch = ev.choices && ev.choices[0]; if (!ch) return;
      const d = ch.delta || {};
      if (d.content) { text += d.content; sink.onText(d.content); }
      if (Array.isArray(d.reasoning_details)) reasoning.push(...d.reasoning_details);
      for (const tc of d.tool_calls || []) {
        const i = tc.index || 0; if (!calls[i]) { calls[i] = { id: tc.id || "call_" + i, name: "", args: "" }; }
        if (tc.id) calls[i].id = tc.id;
        if (tc.function && tc.function.name) { calls[i].name = tc.function.name; sink.toolStart(calls[i].id, calls[i].name); }
        if (tc.function && tc.function.arguments) calls[i].args += tc.function.arguments;
        if (tc.extra_content) calls[i].extra = Object.assign(calls[i].extra || {}, tc.extra_content);
      }
      if (ch.finish_reason) stop = ch.finish_reason;
    });
    const outCalls = calls.filter(Boolean).map((c) => { let input = {}; try { input = JSON.parse(c.args || "{}"); } catch (e) {} sink.toolLabel(c.id, c.name, input); const o = { id: c.id, name: c.name, input }; if (c.extra) o.extra = c.extra; return o; });
    return { text, calls: outCalls, reasoning, stop: stop === "tool_calls" || outCalls.length ? "tool" : stop === "length" ? "length" : "end" };
  }
  async function send(text, opts = {}) {
    if (busy) return;
    open(true);
    if (!app.hasBackend) { const d = addBot(); d.innerHTML = `<p class="err-msg">The assistant runs through the Trace Lab desktop app, which keeps your API key off the page. Open this page from TraceLab.exe.</p>`; return; }
    const prov = app.config.provider || "anthropic";
    if (!app.config.hasKey && prov !== "custom" && prov !== "local") { const d = addBot(); d.innerHTML = `<p>Add your ${app.esc(providerLabel())} API key in <button class="btn" data-act="settings">Settings</button> first.</p>`; scroll(); return; }
    if (!app.config.model) { const d = addBot(); d.innerHTML = `<p>Choose a model for ${app.esc(providerLabel())} in <button class="btn" data-act="settings">Settings</button> first.</p>`; scroll(); return; }
    if (!messages.length) log.innerHTML = "";
    if (!opts.keepInput) { input.value = ""; input.style.height = "auto"; } addUser(opts.display || text);
    const base = messages.length;
    messages.push({ role: "user", text: contextBlock() + "\n\n" + text });
    setBusy(true); ctrl = new AbortController(); curSignal = ctrl.signal;
    let bubble = addBot(); curBubble = bubble;
    const maxTurns = opts.guided || /guided|probe|measure/i.test(text) ? 60 : 24;
    try {
      if (prov === "local") await warmLocal(bubble, ctrl.signal);
      for (let turn = 0; turn < maxTurns; turn++) {
        const sink = makeSink(bubble); const sig = ctrl.signal;
        const res = await withRetry(() => (prov === "anthropic" ? streamAnthropic(sink, sig) : streamOpenAI(sink, sig, prov)), bubble, sig);
        sink.end();
        messages.push({ role: "assistant", text: res.text, calls: res.calls, reasoning: res.reasoning });
        if (res.stop !== "tool") { if (res.stop === "length") appendNote(bubble, "Reply was cut off at the length limit. Ask it to continue."); break; }
        const results = [];
        for (const c of res.calls) {
          const chip = bubble.querySelector(`[data-tool="${c.id}"]`);
          let out; try { const fn = T[c.name]; out = fn ? await fn(c.input || {}) : `Unknown tool ${c.name}`; } catch (err) { out = "Tool error: " + (err.message || err); }
          if (chip) chip.classList.remove("run");
          const n = toolToNeutral(out); results.push({ id: c.id, name: c.name, text: n.text, images: n.images });
        }
        messages.push({ role: "tool", results });
        bubble = addBot(); curBubble = bubble;
      }
    } catch (err) {
      if (err.name === "AbortError") appendNote(bubble, "Stopped.");
      else { const p = document.createElement("p"); p.className = "err-msg"; p.innerHTML = app.esc(err.message || String(err)) + (err.local ? ` <button class="btn" data-act="offline">Offline AI settings</button>` : err.settings ? ` <button class="btn" data-act="settings">Open Settings</button>` : ""); bubble.appendChild(p); }
      messages.length = base; // roll back so the next request is well-formed
    } finally {
      bubble.querySelectorAll(".tool.run").forEach((c) => c.classList.remove("run"));
      if (!bubble.textContent.trim()) bubble.remove();
      setBusy(false); ctrl = null; curBubble = null; curSignal = null; scroll();
      if (panel.hidden) { const dot = $("#aiDot"); if (dot) dot.hidden = false; }
    }
  }
  // The offline model takes a while to load into memory the first time; say so instead of looking stuck.
  async function warmLocal(bubble, signal) {
    let st = await (await app.api("/api/localai/start", { method: "POST" })).json().catch(() => ({}));
    if (st.error && st.error.message) throw Object.assign(new Error(st.error.message), { local: true });
    if (st.state === "running") return;
    const note = document.createElement("p"); note.className = "foot"; bubble.appendChild(note); scroll();
    const t0 = Date.now();
    while (!signal.aborted) {
      const d = await (await app.api("/api/localai")).json().catch(() => ({})); const sv = d.server || {};
      if (sv.state === "running") { note.remove(); return; }
      if (sv.state === "error" || sv.state === "stopped" && Date.now() - t0 > 4000) throw Object.assign(new Error("The offline AI couldn't start: " + (sv.error || "it stopped") + (sv.log_tail ? " — " + sv.log_tail.split("\n").pop() : "")), { local: true });
      const name = ((d.advice && d.advice.models.find((m) => m.id === sv.model)) || {}).name || "the offline model";
      note.textContent = `Loading ${name} on this PC${sv.cpu ? " (on the processor, because the graphics engine didn't start)" : ""}… ${Math.round((Date.now() - t0) / 1000)} s. The first answer after starting Trace Lab takes a little longer.`;
      await new Promise((r) => setTimeout(r, 700));
    }
    throw Object.assign(new Error("Stopped"), { name: "AbortError" });
  }
  function appendNote(bubble, t) { const p = document.createElement("p"); p.className = "foot"; p.textContent = t; bubble.appendChild(p); }

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
    open, guideCard,
    addContext(text) { open(true); input.value = (input.value ? input.value.trimEnd() + "\n" : "") + text + "\n"; input.dispatchEvent(new Event("input")); input.focus(); input.setSelectionRange(input.value.length, input.value.length); },
    askAboutSelection() {
      const sel = S.sel; if (!sel) { open(true); return; }
      send(sel.type === "net" ? `Diagnose ${sel.name}: what creates it, what it feeds, and how to check it.` : sel.type === "part" ? `What does ${sel.name} do, and how do I test it?` : `Where is ${sel.name} used?`);
    },
    tools: T, md,
  };
}
