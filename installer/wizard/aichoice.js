// Offline AI model picker, shared by the setup wizard and Trace Lab's Settings.
// Renders one card per model with how well it runs on this PC, its download size and plain-language
// trade-offs, plus the engine choice. Data comes from /api/localai (app) or the wizard's backend.

const STYLE = `
.aic{display:flex;flex-direction:column;gap:10px}
.aic-hw{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:var(--bg);font-size:13px}
.aic-hw b{display:block;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin-bottom:2px}
.aic-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:10px}
.aic-card{position:relative;display:flex;flex-direction:column;gap:7px;border:1.5px solid var(--line2);border-radius:11px;padding:12px 13px 12px 40px;cursor:pointer;background:var(--rail);text-align:left;font:inherit;color:inherit}
.aic-card:hover{border-color:var(--copper)}
.aic-card[aria-checked="true"]{border-color:var(--copper);box-shadow:0 0 0 2px var(--copper-soft);background:color-mix(in srgb,var(--copper) 6%,var(--rail))}
.aic-card .rad{position:absolute;left:13px;top:14px;width:17px;height:17px;border-radius:50%;border:2px solid var(--line2)}
.aic-card[aria-checked="true"] .rad{border-color:var(--copper);background:radial-gradient(var(--copper) 0 45%,transparent 50%)}
.aic-card h4{margin:0;font:600 14.5px/1.3 var(--f-head,inherit)}
.aic-card .meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:12px;color:var(--muted)}
.aic-b{font:600 10px/1.5 var(--f-ui,inherit);letter-spacing:.07em;text-transform:uppercase;border-radius:4px;padding:1px 6px;white-space:nowrap}
.aic-b.great{background:color-mix(in srgb,var(--ok) 22%,transparent);color:var(--ok)}
.aic-b.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.aic-b.slow{background:color-mix(in srgb,var(--warn) 20%,transparent);color:var(--warn)}
.aic-b.too_big{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.aic-b.rec{background:var(--copper);color:var(--copper-ink)}
.aic-b.have{background:var(--line);color:var(--fg)}
.aic-card p{margin:0;font-size:12.5px;line-height:1.45}
.aic-card .best{color:var(--muted)}
.aic-card ul{margin:0;padding:0;list-style:none;display:grid;gap:2px;font-size:12px}
.aic-card li::before{content:"✓ ";color:var(--ok);font-weight:700}
.aic-card li.con::before{content:"– ";color:var(--warn)}
.aic-card .fitd{font-size:11.5px;color:var(--muted);font-style:italic}
.aic-none{padding-left:40px}
.aic-eng{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
.aic-eng select{border:1px solid var(--line2);border-radius:6px;background:var(--bg);color:var(--fg);padding:6px 8px;font:inherit}
.aic-eng small{color:var(--muted);flex-basis:100%}
.aic-why{font-size:12.5px;color:var(--muted);margin:0}
`;

let styled = false;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtGB = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round(b / 1048576)) + " MB");

/**
 * data: { advice:{hardware,summary,fits,recommended,engine,engines,models}, sizes:{id:bytes}, installed:[{id}], free }
 * state: { model:"" | id | "none", engine }
 * opts: { allowNone, noneText, onChange(state) }
 */
export function renderAIChoice(el, data, state, opts = {}) {
  if (!styled) { const st = document.createElement("style"); st.textContent = STYLE; document.head.appendChild(st); styled = true; }
  const a = data.advice || {}; const fits = new Map((a.fits || []).map((f) => [f.id, f])); const have = new Set((data.installed || []).map((x) => x.id));
  const gpu = (a.hardware && a.hardware.gpus) || []; const nvidia = gpu.some((g) => g.vendor === "nvidia" && !g.integrated);
  if (!state.engine) state.engine = a.engine || "vulkan";
  if (state.model === undefined) state.model = a.recommended;
  const size = (m) => (data.sizes && data.sizes[m.id] ? fmtGB(data.sizes[m.id]) : "about " + m.approx_gb + " GB");
  const card = (m) => {
    const f = fits.get(m.id) || {}; const on = state.model === m.id;
    return `<button type="button" class="aic-card" role="radio" aria-checked="${on}" data-m="${esc(m.id)}"><span class="rad"></span>
      <h4>${esc(m.name)}</h4>
      <div class="meta">${m.id === a.recommended ? `<span class="aic-b rec">Recommended for this PC</span>` : ""}<span class="aic-b ${esc(f.level)}">${esc(f.label || "")}</span>${have.has(m.id) ? `<span class="aic-b have">Downloaded</span>` : ""}<span>${esc(size(m))} download</span><span>· ${esc(m.params)}</span></div>
      <p>${esc(m.summary)}</p><p class="best"><b>Best for:</b> ${esc(m.best)}</p>
      <ul>${(m.pros || []).map((p) => `<li>${esc(p)}</li>`).join("")}${(m.cons || []).map((p) => `<li class="con">${esc(p)}</li>`).join("")}</ul>
      ${f.detail ? `<div class="fitd">On this PC: ${esc(f.detail)}</div>` : ""}</button>`;
  };
  const none = opts.allowNone ? `<button type="button" class="aic-card aic-none" role="radio" aria-checked="${state.model === "none"}" data-m="none"><span class="rad"></span><h4>No offline AI for now</h4>
      <p>${esc(opts.noneText || "Use a cloud AI service with your own API key instead (some have free tiers), or download a model later from Settings → Offline AI. Trace Lab works fully without an assistant.")}</p></button>` : "";
  el.innerHTML = `<div class="aic">
    <div class="aic-hw"><div><b>This PC</b>${esc(a.summary || "")}</div></div>
    <p class="aic-why">Every option is Google's Gemma 4, free to download and use. They read schematic pages and scope screens and can use all of Flux's tools. Everything runs on this PC: no account, no cost, and your boards never leave it. Bigger models give better diagnoses but need more memory.</p>
    <div class="aic-list" role="radiogroup" aria-label="Offline AI model">${(a.models || []).map(card).join("")}${none}</div>
    <div class="aic-eng" ${state.model === "none" ? "hidden" : ""}><label for="aicEng"><b>Run it on</b></label><select id="aicEng">${(a.engines || []).map((e) => `<option value="${esc(e.id)}" ${e.id === state.engine ? "selected" : ""} ${e.id === "cuda" && !nvidia ? "disabled" : ""}>${esc(e.name)}${e.id === a.engine ? " (recommended)" : ""}${e.id === "cuda" && !nvidia ? " (needs an NVIDIA card)" : ""}</option>`).join("")}</select>
      <small id="aicEngAbout">${esc(((a.engines || []).find((e) => e.id === state.engine) || {}).about || "")}</small></div>
  </div>`;
  el.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => {
    state.model = b.dataset.m; el.querySelectorAll("[data-m]").forEach((x) => x.setAttribute("aria-checked", x.dataset.m === state.model));
    el.querySelector(".aic-eng").hidden = state.model === "none"; opts.onChange && opts.onChange(state);
  }));
  const sel = el.querySelector("#aicEng");
  sel.addEventListener("change", () => { state.engine = sel.value; el.querySelector("#aicEngAbout").textContent = ((a.engines || []).find((e) => e.id === state.engine) || {}).about || ""; opts.onChange && opts.onChange(state); });
  return state;
}

export function progressText(p) {
  if (!p) return "";
  const pct = p.total ? Math.floor((p.done / p.total) * 100) + "%" : "";
  const rate = p.rate ? " · " + fmtGB(p.rate) + "/s" : "";
  const eta = p.rate && p.total ? " · about " + Math.max(1, Math.round((p.total - p.done) / p.rate / 60)) + " min left" : "";
  return `${p.label || ""}${p.total ? ` — ${fmtGB(p.done)} of ${fmtGB(p.total)} (${pct})${rate}${eta}` : ""}`;
}
