// Bench instruments: the bar along the bottom, the live cards, and the setup dialog.
// Also the API the repair assistant uses to read meters, supplies and scopes.
const $ = (s) => document.querySelector(s);

const KIND = { dmm: "Multimeter", psu: "Power supply", scope: "Oscilloscope" };
const CONN = { serial: "USB serial (COM port)", visa: "USB (VISA / USBTMC)", lan: "Network (LAN)", demo: "Demo (simulated)" };
const MODE_SHORT = { dcv: "V⎓", acv: "V~", res: "Ω", diode: "Diode", cont: "Cont" };
const ICON = {
  dmm: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="1.5" width="10" height="13" rx="1.6"/><rect x="5" y="3.5" width="6" height="3" rx=".6"/><circle cx="8" cy="10.5" r="2"/></svg>`,
  psu: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3" width="13" height="10" rx="1.6"/><path d="M4 6.5h4M4 9h3"/><circle cx="11" cy="9.5" r="1.1"/><circle cx="11" cy="6" r="1.1"/></svg>`,
  scope: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.6"/><path d="M3.5 9.5h2l1-4 2 6 1.2-3H12.5" stroke-linejoin="round"/></svg>`,
};
const X_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const GEAR_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" stroke-linecap="round"/></svg>`;

export function initBench(app) {
  const { api, esc } = app;
  let items = [], profiles = {}, modeLabels = {}, visa = false, timer = 0, editing = null, ports = { serial: [], visa: [] };
  const spark = new Map(); // id -> [{t,v}] client-side current history for the supply sparkline
  const listeners = new Set();
  let barOn = true; try { barOn = localStorage.getItem("tl.benchbar") !== "0"; } catch (e) {}
  const post = (u, body) => api(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  async function j(r) { const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error((x.error && x.error.message) || "HTTP " + r.status); return x; }

  /* ---------------- polling ---------------- */
  let fast = false;
  async function refresh() {
    if (!app.hasBackend) return;
    try {
      const x = await j(await api("/api/instruments"));
      items = x.items || []; profiles = x.profiles || {}; modeLabels = x.mode_labels || {}; visa = !!x.visa;
      for (const it of items) {
        const p = it.state && it.state.psu; if (!p) continue;
        const a = spark.get(it.id) || []; a.push({ t: Date.now(), v: p.amps }); while (a.length && a[0].t < Date.now() - 60000) a.shift(); spark.set(it.id, a);
      }
      render(); listeners.forEach((f) => { try { f(items); } catch (e) {} });
    } catch (e) { /* backend busy */ }
  }
  function schedule() {
    clearTimeout(timer);
    const live = items.some((i) => i.state.status === "connected" || i.state.status === "connecting");
    timer = setTimeout(async () => { await refresh(); schedule(); }, fast || live ? 350 : 4000);
  }

  /* ---------------- bench bar ---------------- */
  const bar = $("#benchBar"), cards = $("#benchCards");
  function chipLive(it) {
    const s = it.state; if (s.status !== "connected") return s.status === "error" ? "error" : s.status === "connecting" ? "connecting…" : "off";
    if (s.meter) return s.meter.text; if (s.psu) return `${s.psu.volts.toFixed(2)} V · ${s.psu.amps.toFixed(3)} A`; if (s.scope) return "live"; return "";
  }
  function renderBar() {
    bar.hidden = !barOn;
    const chips = items.map((it) => `<button class="bchip" data-chip="${esc(it.id)}" aria-pressed="${!!it.show}" title="${it.show ? "Hide" : "Show"} ${esc(it.name)} on screen">${ICON[it.kind] || ""}<i class="sdot ${esc(it.state.status)}"></i>${esc(it.name)}<span class="live">${esc(chipLive(it))}</span></button>`).join("");
    bar.innerHTML = `<span class="pt">Bench</span>${chips}<button class="bchip add" data-act="setup">+ ${items.length ? "Add instrument" : "Connect a multimeter, power supply or scope"}</button>`;
  }
  bar.addEventListener("click", async (e) => {
    const c = e.target.closest("[data-chip]");
    if (c) { const it = items.find((x) => x.id === c.dataset.chip); if (it) await setShow(it, !it.show); return; }
    if (e.target.closest("[data-act=setup]")) openSetup();
  });
  async function setShow(it, on) {
    it.show = on; render();
    try { await j(await api(`/api/instruments/show?id=${encodeURIComponent(it.id)}&show=${on ? 1 : 0}`, { method: "POST" })); } catch (e) {}
  }

  /* ---------------- live cards ---------------- */
  const pos = (() => { try { return JSON.parse(localStorage.getItem("tl.cardpos") || "{}"); } catch (e) { return {}; } })();
  const savePos = () => { try { localStorage.setItem("tl.cardpos", JSON.stringify(pos)); } catch (e) {} };
  function cardHTML(it) {
    const s = it.state, on = s.status === "connected";
    let body = "";
    if (!on) {
      body = `<div class="icb" style="padding-top:10px">${s.status === "connecting" ? "Connecting…" : s.status === "error" ? `<span class="err">${esc(s.error || "Error")}</span>` : "Not connected."}
        <div class="btns"><button class="btn primary" data-act="connect">${s.status === "error" ? "Try again" : "Connect"}</button><button class="btn" data-act="edit">Settings</button></div></div>`;
    } else if (it.kind === "dmm") {
      const m = s.meter || {}; const txt = m.text || "—"; const [num, unit] = splitUnit(txt);
      body = `<div class="lcd ${m.ol ? "ol" : ""}" data-live="lcd">${esc(num)}<small>${esc(unit)}</small></div>
        <div class="icb"><div class="sub"><span>${esc(modeLabels[m.mode] || "Reading")}</span><span>${esc((s.idn || "").split(",").slice(0, 2).join(" "))}</span></div>
        ${it.modes && it.modes.length ? `<div class="imodes">${it.modes.map((md) => `<button data-mode="${md}" aria-pressed="${m.mode === md}" title="${esc(modeLabels[md] || md)}">${MODE_SHORT[md] || md}</button>`).join("")}</div>` : it.note ? `<span>${esc(it.note)}</span>` : ""}
        <div class="btns"><button class="btn" data-act="tell">Send to Flux</button></div></div>`;
    } else if (it.kind === "psu") {
      const p = s.psu || {}; const on2 = p.output === undefined ? null : p.output, cc = p.cc && on2 !== false;
      body = `<div class="psu2"><div><div class="lbl">Volts</div><div class="lcd">${(p.volts ?? 0).toFixed(3)}</div></div><div><div class="lbl">Amps</div><div class="lcd">${(p.amps ?? 0).toFixed(3)}</div></div></div>
        <div class="icb"><div class="sub"><span>${p.vset != null ? `Set ${p.vset.toFixed(2)} V / ${p.iset != null ? p.iset.toFixed(3) + " A" : "—"}` : ""}</span><span>${on2 === null ? "" : `<span class="tagx ${on2 ? "on" : ""}">${on2 ? "Output on" : "Output off"}</span>`} ${cc ? `<span class="tagx cc">CC limit</span>` : p.cc === false ? `<span class="tagx">CV</span>` : ""}</span></div>
        <canvas class="spark" data-spark="${esc(it.id)}" width="476" height="84" aria-label="Current draw, last 60 seconds"></canvas>
        <div class="sub"><span>Current, last 60 s</span><span>${(p.watts ?? 0).toFixed(2)} W</span></div>
        <div class="btns"><button class="btn" data-act="tell">Send to Flux</button></div></div>`;
    } else if (it.kind === "scope") {
      const sc = (s.scope && s.scope.channels) || {}; const chs = Object.keys(sc).sort();
      body = `<div class="icb" style="padding-top:10px"><table class="smeas"><tr><th>Ch</th><th>Vpp</th><th>Avg</th><th>Freq</th></tr>${chs.map((c) => { const v = sc[c] || {}; return `<tr><td>CH${esc(c)}</td><td>${v.vpp != null ? eng(v.vpp, "V") : "—"}</td><td>${v.vavg != null ? eng(v.vavg, "V") : "—"}</td><td>${v.freq ? eng(v.freq, "Hz") : "—"}</td></tr>`; }).join("")}</table>
        ${it.has_shot ? `<img class="sshot" data-shot="${esc(it.id)}" alt="Last scope screen" src="">` : ""}
        <div class="btns"><button class="btn" data-act="shot">Grab screen</button><button class="btn" data-act="tell">Send to Flux</button></div></div>`;
    }
    return `<div class="ich" data-drag="${esc(it.id)}">${ICON[it.kind] || ""}<span class="nm" title="${esc(it.label)}">${esc(it.name)}</span><i class="sdot ${esc(s.status)}" title="${esc(s.status)}"></i>
      <button class="iconbtn" data-act="edit" title="Settings" aria-label="Instrument settings">${GEAR_SVG}</button><button class="iconbtn" data-act="hide" title="Hide from screen" aria-label="Hide ${esc(it.name)}">${X_SVG}</button></div>${body}`;
  }
  function splitUnit(t) { const m = String(t).match(/^(.*?)\s*([a-zA-Zµ°Ω~⎓ ]+)$/); return m && /\d/.test(m[1]) ? [m[1], m[2].trim()] : [t, ""]; }
  function eng(v, u) { const a = Math.abs(v); const P = [[1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"]]; let p = P[2]; if (a) for (const x of P) { p = x; if (a >= x[0] * 0.9995) break; } const f = v / p[0]; return f.toFixed(Math.abs(f) >= 100 ? 1 : Math.abs(f) >= 10 ? 2 : 3) + " " + p[1] + u; }
  function defaultPos(i, el) {
    const ins = $("#insp").getBoundingClientRect(); const x = Math.round(ins.right + 14 + i * 282);
    return { left: Math.min(x, window.innerWidth - el.offsetWidth - 20), top: window.innerHeight - 60 - el.offsetHeight };
  }
  function renderCards() {
    const vis = items.filter((it) => it.show);
    [...cards.children].forEach((c) => { if (!vis.some((it) => it.id === c.dataset.id)) c.remove(); });
    vis.forEach((it, i) => {
      let el = cards.querySelector(`[data-id="${CSS.escape(it.id)}"]`);
      const html = cardHTML(it);
      if (!el) { el = document.createElement("div"); el.className = "icard " + it.kind; el.dataset.id = it.id; cards.appendChild(el); el.innerHTML = html; place(el, it, i); }
      else if (el.dataset.h !== html && !(drag && drag.el === el)) el.innerHTML = html; // don't rebuild a card mid-drag
      el.dataset.h = html;
      const cv = el.querySelector("canvas[data-spark]"); if (cv) drawSpark(cv, spark.get(it.id) || []);
      const img = el.querySelector("img[data-shot]"); if (img && !img.src.startsWith("data:")) loadShot(it.id, img);
    });
  }
  function place(el, it, i) {
    const p = pos[it.id]; let { left, top } = p || defaultPos(i, el);
    left = Math.max(4, Math.min(window.innerWidth - el.offsetWidth - 4, left)); top = Math.max(60, Math.min(window.innerHeight - el.offsetHeight - 50, top));
    el.style.left = left + "px"; el.style.top = top + "px";
  }
  window.addEventListener("resize", () => [...cards.children].forEach((el, i) => { const it = items.find((x) => x.id === el.dataset.id); if (it) place(el, it, i); }));
  const shots = new Map();
  async function loadShot(id, img) {
    if (shots.has(id)) { img.src = shots.get(id); return; }
    try { const x = await j(await api("/api/instruments/screenshot?id=" + encodeURIComponent(id))); const u = "data:image/png;base64," + x.png; shots.set(id, u); img.src = u; } catch (e) {}
  }
  function drawSpark(cv, pts) {
    const g = cv.getContext("2d"), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
    if (pts.length < 2) return;
    const cs = getComputedStyle(document.documentElement); const col = cs.getPropertyValue("--copper").trim() || "#e39250";
    const t1 = Date.now(), t0 = t1 - 60000; let mx = Math.max(0.01, ...pts.map((p) => p.v)) * 1.15;
    g.lineWidth = 2.5; g.strokeStyle = col; g.beginPath();
    pts.forEach((p, i) => { const x = ((p.t - t0) / 60000) * W, y = H - 4 - (p.v / mx) * (H - 10); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    g.fillStyle = cs.getPropertyValue("--muted").trim(); g.font = "18px " + cs.getPropertyValue("--f-mono"); g.fillText(mx.toFixed(mx < 0.1 ? 3 : 2) + " A", 6, 20);
  }
  // drag cards by their header
  let drag = null;
  cards.addEventListener("pointerdown", (e) => {
    const h = e.target.closest("[data-drag]"); if (!h || e.target.closest("button")) return;
    const el = h.parentElement; const r = el.getBoundingClientRect(); drag = { el, id: h.dataset.drag, dx: e.clientX - r.left, dy: e.clientY - r.top }; h.setPointerCapture(e.pointerId);
  });
  cards.addEventListener("pointermove", (e) => { if (!drag) return; drag.el.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + "px"; drag.el.style.top = Math.max(40, Math.min(window.innerHeight - 40, e.clientY - drag.dy)) + "px"; });
  cards.addEventListener("pointerup", () => { if (!drag) return; pos[drag.id] = { left: parseInt(drag.el.style.left), top: parseInt(drag.el.style.top) }; savePos(); drag = null; });
  cards.addEventListener("click", async (e) => {
    const card = e.target.closest(".icard"); if (!card) return; const it = items.find((x) => x.id === card.dataset.id); if (!it) return;
    const mb = e.target.closest("[data-mode]"); if (mb) { try { await j(await api(`/api/instruments/mode?id=${encodeURIComponent(it.id)}&mode=${mb.dataset.mode}`, { method: "POST" })); await refresh(); } catch (err) { app.toast(err.message); } return; }
    if (e.target.closest("img[data-shot]")) { $("#shotImg").src = e.target.src; $("#shotDlg").showModal(); return; }
    const act = e.target.closest("[data-act]"); if (!act) return;
    const a = act.dataset.act;
    if (a === "hide") setShow(it, false);
    else if (a === "edit") openSetup(it.id);
    else if (a === "connect") connect(it.id);
    else if (a === "shot") { act.disabled = true; act.textContent = "Grabbing…"; try { const x = await j(await post("/api/instruments/screenshot?id=" + encodeURIComponent(it.id))); shots.set(it.id, "data:image/png;base64," + x.png); await refresh(); const img = card.querySelector("img[data-shot]"); if (img) img.src = shots.get(it.id); } catch (err) { app.toast(err.message); } finally { act.disabled = false; act.textContent = "Grab screen"; } }
    else if (a === "tell") app.assistant && app.assistant.addContext(describe(it), shots.get(it.id) && it.kind === "scope" ? shots.get(it.id) : null);
  });
  $("#shotClose").addEventListener("click", () => $("#shotDlg").close());

  function describe(it) {
    const s = it.state;
    if (s.status !== "connected") return `${it.name} (${KIND[it.kind]}) is not connected.`;
    if (s.meter) return `${it.name} (multimeter, ${modeLabels[s.meter.mode] || s.meter.mode}): ${s.meter.text}`;
    if (s.psu) return `${it.name} (bench supply): ${s.psu.text}${s.psu.vset != null ? `, set to ${s.psu.vset} V / ${s.psu.iset} A limit` : ""}`;
    if (s.scope) return `${it.name} (oscilloscope): ${s.scope.text}`;
    return it.name;
  }
  function render() { renderBar(); renderCards(); }

  /* ---------------- setup dialog ---------------- */
  const dlg = $("#instDlg");
  async function loadPorts() {
    try { ports = await j(await api("/api/instruments/ports")); } catch (e) { ports = { serial: [], visa: [] }; }
    fillPorts();
  }
  function fillProfiles(keep) {
    const k = $("#iKind").value; const ps = Object.entries(profiles).filter(([, p]) => p.kind === k).sort((a, b) => (a[1].conns[0] === "demo") - (b[1].conns[0] === "demo") || a[1].label.localeCompare(b[1].label));
    $("#iProfile").innerHTML = ps.map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)}</option>`).join("");
    if (keep && profiles[keep] && profiles[keep].kind === k) $("#iProfile").value = keep;
    fillConns();
  }
  function fillConns(keep) {
    const p = profiles[$("#iProfile").value]; if (!p) return;
    $("#iConn").innerHTML = p.conns.map((c) => `<option value="${c}">${CONN[c]}${c === "visa" && !visa ? " (needs NI-VISA)" : ""}</option>`).join("");
    if (keep && p.conns.includes(keep)) $("#iConn").value = keep;
    $("#iBaud").value = String(p.baud || 9600);
    $("#iNote").textContent = p.note || "";
    syncConn();
  }
  function syncConn() {
    const c = $("#iConn").value, k = $("#iKind").value;
    $("#iPortWrap").hidden = !(c === "serial" || c === "visa"); $("#iAddrWrap").hidden = c !== "lan"; $("#iBaudWrap").hidden = c !== "serial";
    $("#iChWrap").hidden = k !== "psu" || c === "demo"; $("#iChsWrap").hidden = k !== "scope";
    $("#iPortWrap > span").textContent = c === "visa" ? "USB instrument" : "COM port";
    const p = profiles[$("#iProfile").value];
    let note = (p && p.note) || "";
    if (c === "visa") note = (visa ? "Instruments on a plain USB cable (USBTMC) are reached through VISA. " : "VISA isn't installed on this PC. Install NI-VISA (free from ni.com) or Keysight IO Libraries, then click Refresh. Or use the network connection instead. ") + note;
    if (c === "serial") note = "Pick the COM port your meter or supply shows up as in Device Manager → Ports. " + note;
    if (c === "lan") note = "Find the IP address on the instrument's Utility → IO / LAN page. Trace Lab talks raw SCPI on port 5025. " + note;
    if (c === "demo") note = "Simulated readings, so you can try the bench and the guided workflow without hardware.";
    $("#iNote").textContent = note.trim();
    fillPorts();
  }
  function fillPorts(keep) {
    const c = $("#iConn").value; const list = c === "visa" ? ports.visa || [] : ports.serial || [];
    const cur = keep || $("#iPort").value;
    $("#iPort").innerHTML = list.length ? list.map((p) => `<option value="${esc(p.port)}">${esc(p.desc && p.desc !== p.port ? p.desc : p.port)}</option>`).join("") : `<option value="">${c === "visa" ? (ports.visa_error ? "VISA not available" : "No USB instruments found") : "No COM ports found"}</option>`;
    if (cur && list.some((p) => p.port === cur)) $("#iPort").value = cur;
    else if (cur && keep) { $("#iPort").insertAdjacentHTML("afterbegin", `<option value="${esc(cur)}">${esc(cur)} (not plugged in?)</option>`); $("#iPort").value = cur; }
  }
  $("#iKind").addEventListener("change", () => fillProfiles()); $("#iProfile").addEventListener("change", () => fillConns()); $("#iConn").addEventListener("change", syncConn);
  $("#iRefresh").addEventListener("click", async () => { $("#iRefresh").textContent = "…"; await loadPorts(); $("#iRefresh").textContent = "Refresh"; });
  function renderList() {
    $("#instList").innerHTML = items.length ? items.map((it) => `<div class="irow" data-id="${esc(it.id)}"><i class="sdot ${esc(it.state.status)}"></i>${ICON[it.kind]}
      <div class="t"><b>${esc(it.name)}</b><span>${esc(it.label)} · ${esc(CONN[it.conn] || it.conn)}${it.addr ? " · " + esc(it.addr) : ""}${it.state.status === "error" ? " · " + esc(it.state.error || "") : it.state.idn ? " · " + esc(it.state.idn) : ""}</span></div>
      ${it.state.status === "connected" ? `<button class="btn" data-a="off">Disconnect</button>` : `<button class="btn" data-a="on">Connect</button>`}<button class="btn" data-a="edit">Edit</button><button class="btn" data-a="del">Remove</button></div>`).join("")
      : `<p class="foot" style="margin:0">No instruments yet. Add one below, or click “Add demo instruments” to try it without hardware.</p>`;
    $("#cTarget").innerHTML = items.filter((i) => i.conn !== "demo").map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`).join("") || `<option value="">(none)</option>`;
  }
  $("#instList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-a]"); if (!b) return; const id = b.closest(".irow").dataset.id; const a = b.dataset.a;
    if (a === "on") { b.textContent = "Connecting…"; await connect(id); }
    else if (a === "off") { await api(`/api/instruments/connect?id=${encodeURIComponent(id)}&off=1`, { method: "POST" }); await refresh(); }
    else if (a === "edit") startEdit(id);
    else if (a === "del") { if (b.dataset.sure) { await api("/api/instruments/delete?id=" + encodeURIComponent(id), { method: "POST" }); delete pos[id]; savePos(); await refresh(); } else { b.dataset.sure = "1"; b.textContent = "Remove?"; b.classList.add("primary"); return; } }
    renderList();
  });
  function startEdit(id) {
    const it = items.find((x) => x.id === id); editing = it ? id : null;
    $("#instFormTitle").textContent = it ? `Edit ${it.name}` : "Add an instrument"; $("#iCancelEdit").hidden = !it; $("#iSave").textContent = it ? "Save" : "Save and connect"; $("#iSt").textContent = "";
    if (!it) { $("#iName").value = ""; $("#iAddr").value = ""; return; }
    $("#iKind").value = it.kind; fillProfiles(it.profile); fillConns(it.conn);
    if (it.conn === "lan") $("#iAddr").value = it.addr; else fillPorts(it.addr);
    if (it.baud) $("#iBaud").value = String(it.baud); $("#iCh").value = String(it.channel || 1); $("#iChs").value = it.channels || "1"; $("#iName").value = it.name;
  }
  $("#iCancelEdit").addEventListener("click", () => startEdit(null));
  $("#iSave").addEventListener("click", async () => {
    const c = $("#iConn").value; const st = $("#iSt");
    const body = { id: editing || "", profile: $("#iProfile").value, conn: c, addr: c === "lan" ? $("#iAddr").value.trim() : c === "demo" ? "" : $("#iPort").value, baud: +$("#iBaud").value || 0, channel: +$("#iCh").value || 1, channels: $("#iChs").value.trim(), name: $("#iName").value.trim() };
    if (editing) { const it = items.find((x) => x.id === editing); if (it) body.show = it.show; }
    if ((c === "serial" || c === "visa") && !body.addr) { st.className = "st bad"; st.textContent = c === "visa" ? "No USB instrument selected." : "Choose a COM port."; return; }
    st.className = "st"; st.textContent = "Connecting…"; $("#iSave").disabled = true;
    try {
      const x = await j(await post("/api/instruments/save", body)); await refresh();
      if (x.state.status === "error") { st.className = "st bad"; st.textContent = "Saved, but it didn't connect: " + x.state.error; }
      else { st.className = "st ok"; st.textContent = x.state.status === "connected" ? `✓ Connected${x.state.idn ? " to " + x.state.idn.split(",").slice(0, 2).join(" ") : ""}` : "✓ Saved"; app.toast(`${x.name} ${x.state.status === "connected" ? "connected" : "saved"}.`); startEdit(null); st.className = "st ok"; st.textContent = `✓ ${x.name} ${x.state.status === "connected" ? "connected" : "saved"}`; }
    } catch (e) { st.className = "st bad"; st.textContent = e.message; }
    finally { $("#iSave").disabled = false; renderList(); }
  });
  $("#cSend").addEventListener("click", async () => {
    const out = $("#cOut"); out.hidden = false; const cmd = $("#cCmd").value.trim(); if (!cmd) return;
    try { const x = await j(await post("/api/instruments/command", { id: $("#cTarget").value, cmd })); out.textContent += `> ${cmd}\n${x.reply}\n`; }
    catch (e) { out.textContent += `> ${cmd}\n! ${e.message}\n`; }
    out.scrollTop = out.scrollHeight;
  });
  $("#cCmd").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#cSend").click(); } });
  async function addDemo() {
    const have = new Set(items.filter((i) => i.conn === "demo").map((i) => i.kind));
    for (const [kind, profile, name] of [["dmm", "dmm-demo", "Demo meter"], ["psu", "psu-demo", "Demo supply"], ["scope", "scope-demo", "Demo scope"]]) if (!have.has(kind)) { try { await j(await post("/api/instruments/save", { profile, conn: "demo", name })); } catch (e) {} }
    await refresh(); renderList(); app.toast("Demo meter, supply and scope added. Click them on the bench bar to show or hide them.");
  }
  $("#instDemo").addEventListener("click", addDemo);
  $("#instClose").addEventListener("click", () => dlg.close());
  async function openSetup(id) {
    if (!app.hasBackend) { app.toast("Instruments need the Trace Lab desktop app."); return; }
    await refresh(); renderList(); fillProfiles(); if (!dlg.open) dlg.showModal(); startEdit(id || null); loadPorts();
  }
  async function connect(id) {
    const it = items.find((x) => x.id === id); if (it) { it.state.status = "connecting"; render(); }
    try { await j(await api("/api/instruments/connect?id=" + encodeURIComponent(id), { method: "POST" })); } catch (e) { app.toast(e.message); }
    await refresh(); if (dlg.open) renderList(); schedule();
  }

  /* ---------------- API for Flux ---------------- */
  const connected = (kind) => items.find((i) => i.kind === kind && i.state.status === "connected");
  const bench = {
    get items() { return items; }, modeLabels: () => modeLabels, connected, describe, openSetup, addDemo, refresh,
    hasAny: () => items.some((i) => i.state.status === "connected"),
    summary() {
      if (!items.length) return "No bench instruments are set up.";
      return items.map((it) => `- ${describe(it)}${it.state.status === "connected" && it.state.idn ? ` [${it.state.idn.split(",").slice(0, 2).join(" ")}]` : ""}`).join("\n");
    },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setFast(v) { fast = v; schedule(); },
    async setMode(mode) { const m = connected("dmm"); if (!m) return false; const r = await api(`/api/instruments/mode?id=${encodeURIComponent(m.id)}&mode=${mode}`, { method: "POST" }); await refresh(); return r.ok; },
    async measure(q) { const x = await j(await post("/api/instruments/measure", q)); await refresh(); return x; },
    async history(kind, seconds) { return j(await api(`/api/instruments/history?kind=${kind}&seconds=${seconds || 60}`)); },
    async screenshot() { const s = connected("scope"); if (!s) throw new Error("No oscilloscope is connected."); const x = await j(await post("/api/instruments/screenshot?id=" + encodeURIComponent(s.id))); shots.set(s.id, "data:image/png;base64," + x.png); refresh(); return x.png; },
    hint(net) { api("/api/instruments/hint?net=" + encodeURIComponent(net || ""), { method: "POST" }).catch(() => {}); },
    toggleBar(v) { barOn = v === undefined ? !barOn : v; try { localStorage.setItem("tl.benchbar", barOn ? "1" : "0"); } catch (e) {} render(); },
    get barOn() { return barOn; },
    menuItems() { return items.map((it) => ({ id: it.id, name: it.name, show: it.show, status: it.state.status })); },
    toggleShow(id) { const it = items.find((x) => x.id === id); if (it) setShow(it, !it.show); },
  };
  render(); refresh().then(schedule);
  return bench;
}
