/* Kortz Code Helper — UI layer.
   The seed derivations live in kortz.js and the time sync in clock.js; this
   file assumes both are already loaded. Keep them separate: kortz.js is pure
   and testable (test.mjs runs it with no DOM), and everything here touches the
   document.
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   4. State. `cal` is (what the game recorded) - (the second we aimed at), so
   acting on wall second w lands on seed w + cal.
   =========================================================================== */
const STALE_MS = 2 * 3600 * 1000;   // an offset dies with the GTA process
/* A delta this small from the *current* calibration reads as mistimed press
   (early/late by a beat), not a genuinely changed offset — see the nudge in
   findOffset(). Chasing every 1s jitter as if it were drift is what put users
   in a too-early/too-late loop. */
const TIMING_SLOP = 2;

const state = {
  window: 900, max: 35, sort: "time",
  selected: null, rows: [],
  cal: 0, calAt: null,     // measured offset, and when
  armed: null,             // the wall second armed in calibration step 1
};
let recalShortcut = false;   // true when the dialog was opened via "Recalibrate from this code"

const store = {
  get(k, max){
    try{
      const v = Number(localStorage.getItem("kortz-" + k));
      return isFinite(v) && v !== 0 && (max === undefined || Math.abs(v) <= max) ? v : null;
    }catch(_){ return null; }
  },
  set(k, v){ try{ localStorage.setItem("kortz-" + k, String(v)); }catch(_){} },
  del(k){ try{ localStorage.removeItem("kortz-" + k); }catch(_){} },
};

state.cal   = store.get("cal", 86400) || 0;
state.calAt = store.get("cal-at");
/* An armed second older than a few hours belongs to a dead run. */
const arm = store.get("armed");
if (arm !== null && Date.now() / 1000 - arm < 6 * 3600) state.armed = arm;

/* ===========================================================================
   5. Formatting helpers.
   =========================================================================== */
const $ = id => document.getElementById(id);
const pad2 = n => String(n).padStart(2, "0");
const fmtCode = c => c.map(pad2).join("-");

function utcTime(sec){
  const d = new Date(sec * 1000);
  return pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
}
function rel(sec){
  if (sec <= 0) return "now";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m >= 60) return Math.floor(m / 60) + "h" + pad2(m % 60);
  return m ? m + "m" + pad2(s) : s + "s";
}
function ago(ms){
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  return Math.floor(m / 60) + "h " + (m % 60) + "m ago";
}
const signed = n => (n > 0 ? "+" : "−") + Math.abs(n);

/* ===========================================================================
   6. The table.
   =========================================================================== */
function makeRow(w){
  const seed = w + state.cal;         // the seed the game will record
  const code = vaultCode(seed);
  return { w, seed, code, press: presses(code).total, laser: laserVariant(seed) };
}

/* Recomputes every row from scratch. Needed when the window size or the
   calibration offset changes, since every seed shifts. */
function build(){
  const start = Math.floor(nowMs() / 1000) + 1;
  state.rows = [];
  for (let i = 0; i < state.window; i++) state.rows.push(makeRow(start + i));
}

/* Slides the window forward instead of rebuilding it: drops the seconds that
   passed off the front and appends the same number fresh at the back. Cheap
   per tick, unlike build(), which recomputes the whole (up to 1800-row) table. */
function advance(){
  const start = Math.floor(nowMs() / 1000) + 1;
  const first = state.rows.length ? state.rows[0].w : start;
  const delta = start - first;
  if (delta <= 0) return;
  if (delta >= state.window) return build();
  state.rows.splice(0, delta);
  let w = state.rows[state.rows.length - 1].w;
  while (state.rows.length < state.window) state.rows.push(makeRow(++w));
}

function render(){
  const now = Math.floor(nowMs() / 1000);
  let list = state.rows.filter(r => r.w >= now && r.press <= state.max);
  list.sort(state.sort === "press" ? (a, b) => a.press - b.press || a.w - b.w
                                   : (a, b) => a.w - b.w);
  const cap = 120;                    // the whole table is rebuilt every second
  const shown = list.slice(0, cap);

  $("count-note").textContent = list.length
    ? `${list.length} of ${state.rows.length} seconds at ${state.max} presses or fewer`
      + (list.length > cap ? ` · showing ${cap}` : "")
    : `No second under ${state.max} presses in this window — raise the limit or search further ahead.`;

  $("rows").innerHTML = shown.map(r => `<tr tabindex="0" data-w="${r.w}"${
      state.selected === r.w ? ' aria-selected="true"' : ""}>
      <td class="dim">${rel(r.w - now)}</td>
      <td>${utcTime(r.w)}</td>
      <td class="dim">${r.seed}</td>
      <td class="code">${fmtCode(r.code)}</td>
      <td class="r${r.press <= 15 ? " cheap" : ""}">${r.press}</td>
      <td class="r dim">${r.laser}</td>
    </tr>`).join("");

  if (state.selected === null && shown.length) select(shown[0].w);
}

function select(w){
  state.selected = w;
  document.querySelectorAll("#rows tr[data-w]").forEach(tr => {
    if (Number(tr.dataset.w) === w) tr.setAttribute("aria-selected", "true");
    else tr.removeAttribute("aria-selected");
  });
  paintDetail();
}

/* ===========================================================================
   7. The detail panel.
   =========================================================================== */
function paintDetail(){
  const w = state.selected;
  $("detail").hidden = w === null;
  if (w === null) return;

  const seed = w + state.cal;
  const code = vaultCode(seed);
  const p = presses(code);

  $("d-code").textContent = fmtCode(code);
  /* The game samples the seed on the confirm press, not the second you aimed
     at — a beat early or late lands on a different code entirely. Surfacing
     the neighbours right next to the main one lets you recognise "that's
     actually the early/late code" on sight, instead of only finding out via
     a mismatched recalibration search. */
  $("d-near").innerHTML = `if you're early <b>${fmtCode(vaultCode(seed - 1))}</b>`
    + ` &middot; if you're late <b>${fmtCode(vaultCode(seed + 1))}</b>`;
  $("d-legs").innerHTML = p.legs.map(l =>
    `<span><b>${pad2(l.to)}</b> ${l.cost}${l.dir}</span>`).join("")
    + `<span class="spacer"></span><span><b>${p.total}</b> total</span>`;
  $("d-seed").textContent = seed;
  $("d-utc").textContent = utcTime(w) + " UTC";
  $("d-laser").textContent = "variant " + laserVariant(seed);

  /* Both difficulties, because which one you are on is a lobby setting rather
     than anything the seed knows. The boards differ in size, not just content. */
  $("d-boards").innerHTML = [["normal", false], ["hard", true]].map(([name, hard]) => {
    const h = hackBoards(seed, hard);
    const boards = h.boards.map((pick, i) => {
      let cells = "";
      for (let c = 0; c < h.cols; c++)
        for (let r = 0; r < h.rows; r++)
          cells += `<span class="cell${pick[c] === r ? " on" : ""}"></span>`;
      return `<div class="board"><span class="lbl">P${i + 1}</span>`
        + `<div class="cells" style="grid-template-rows:repeat(${h.rows},auto)">${cells}</div></div>`;
    }).join("");
    return `<div class="bgroup"><span class="lbl">${name} · ${h.cols}×${h.rows}</span>`
      + `<div class="boards">${boards}</div></div>`;
  }).join("");
}

/* ===========================================================================
   8. Clocks. One rAF loop drives the header clock and both countdowns.
   =========================================================================== */
function countdown(target, ms, els){
  const left = target - ms / 1000;
  if (left < -1){ els.box.className = "tminus gone"; els.main.textContent = "elapsed"; els.cs.textContent = ""; return -1; }
  if (left <= 0){ els.box.className = "tminus live"; els.main.textContent = "START";  els.cs.textContent = ""; return 0; }
  els.box.className = "tminus";
  const s = Math.floor(left), m = Math.floor(s / 60);
  els.main.textContent = m >= 60
    ? Math.floor(m / 60) + ":" + pad2(m % 60) + ":" + pad2(s % 60)
    : pad2(m) + ":" + pad2(s % 60);
  els.cs.textContent = m >= 60 ? "" : "." + pad2(Math.floor(left * 100) % 100);
  return 1;
}

const mainT = { box: null, main: null, cs: null };   // filled on first frame

/* The live-second strip: what confirming setup RIGHT NOW would record. The
   code/laser/seed only change on a tick, so they are only recomputed then;
   the fill bar is what actually needs every frame. */
let nowSec = null;
function paintNow(ms){
  const sec = Math.floor(ms / 1000);
  if (sec !== nowSec){
    nowSec = sec;
    const seed = sec + state.cal;
    $("now-code").textContent = fmtCode(vaultCode(seed));
    $("now-laser").textContent = laserVariant(seed);
    $("now-seed").textContent = "seed " + seed;
  }
  $("now-fill").style.width = ((ms % 1000) / 1000 * 100) + "%";
}

function frame(){
  const ms = nowMs(), d = new Date(ms);
  $("clock-utc").textContent = pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + ":" + pad2(d.getUTCSeconds());
  $("clock-frac").textContent = "." + pad2(Math.floor((ms % 1000) / 10));
  paintNow(ms);

  if (state.selected !== null){
    const phase = countdown(state.selected, ms, mainT);
    $("t-sub").textContent = phase > 0 ? "confirm the setup prompt as this hits START"
                           : phase === 0 ? "confirm now"
                           : "that second has passed";
  }
  if (calDlg.open && state.armed !== null) paintArmClock(ms);
  requestAnimationFrame(frame);
}

/* Time-sync readout. `clock` and nowMs() come from clock.js. */
function paintSync(){
  const el = $("sync");
  if (clock.source === null){
    el.className = "sync bad";
    el.textContent = "device clock — unverified";
    el.title = "No time endpoint answered. Predictions are only as good as this PC's clock.";
    return;
  }
  const a = Math.round(clock.acc);
  el.className = "sync";
  el.textContent = (a <= 250 ? "synced" : "narrowing") + " ±" + a + " ms · " + clock.source;
  el.title = "This PC's clock reads " + signed(Math.round(clock.offset)) + " ms against " + clock.source + ".";
}

/* ===========================================================================
   9. Calibration.

   Step 1 arms a wall second and counts down to it; you confirm the setup cost
   on START. Step 2 takes the code the game actually produced and searches the
   seconds around the armed one for the seed that yields it. Three numbers over
   1-99 is ~970k combinations, so a hit inside a few minutes is effectively
   unique.
   =========================================================================== */
const calDlg = $("cal-dialog");

const calStale = () => Boolean(state.cal) && Boolean(state.calAt) && Date.now() - state.calAt > STALE_MS;

function paintCal(){
  const bar = $("cal-bar");
  $("cal-clear").hidden = !state.cal;
  if (!state.cal){
    bar.className = "cal";
    $("cal-text").textContent = "not calibrated — codes below are off by the session lag";
    return;
  }
  const stale = calStale();
  bar.className = "cal " + (stale ? "stale" : "on");
  $("cal-text").textContent = signed(state.cal) + "s applied · measured " + ago(Date.now() - state.calAt)
    + (stale ? " — only valid if GTA has not restarted since" : "");
}

function setCal(delta){
  state.cal = delta;
  state.calAt = Date.now();
  store.set("cal", delta);
  store.set("cal-at", state.calAt);
  state.selected = null;
  nowSec = null;          // force the live strip to recompute under the new offset
  paintCal(); paintNbr(); build(); render();
}

function clearCal(){
  state.cal = 0; state.calAt = null; state.armed = null; state.selected = null;
  nowSec = null; recalShortcut = false;
  store.del("cal"); store.del("cal-at"); store.del("armed");
  ["c1","c2","c3"].forEach(id => $(id).value = "");
  $("step2").classList.remove("done");
  showResult("", "");
  paintArm(); paintCal(); build(); render();
}

function paintArm(){
  $("arm-idle").hidden = state.armed !== null;
  $("arm-live").hidden = state.armed === null;
  $("step1").classList.toggle("done", state.armed !== null);
  paintNbr();
}

/* Reference codes for the seconds either side of the armed one, under the
   *current* offset — lets you eyeball, before even submitting, whether what
   you got matches "on time" or one of its neighbours. Only meaningful once
   there is an existing offset to reference; on a first-ever calibration
   there's nothing to compare against, so it stays hidden. */
function paintNbr(){
  const el = $("nbr-hint");
  if (state.armed === null || state.calAt === null){ el.hidden = true; return; }
  el.hidden = false;
  const codeAt = k => fmtCode(vaultCode(state.armed + k + state.cal));
  el.innerHTML = `reference at your current offset — <b>1s early</b> ${codeAt(-1)}`
    + ` &middot; <b>on time</b> ${codeAt(0)} &middot; <b>1s late</b> ${codeAt(1)}`;
}

const armT = { box: null, main: null, cs: null };
function paintArmClock(ms){
  const phase = countdown(state.armed, ms, armT);
  $("arm-sub").textContent = phase > 0 ? "confirm the setup prompt as this hits START"
                           : phase === 0 ? "confirm now"
                           : "logged — now enter the code the game gave you";
  if (phase < 0 && !paintArmClock.jumped){ paintArmClock.jumped = true; try{ $("c1").focus(); }catch(_){} }
}

function showResult(html, kind){
  const el = $("cal-result");
  el.className = "result " + kind;
  el.innerHTML = html;
}

function findOffset(){
  if (state.armed === null) return showResult("Arm a second in step 1 first — the offset is measured against it.", "miss");
  const vals = ["c1","c2","c3"].map(id => $(id).value.trim());
  if (!vals.every(v => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 99))
    return showResult("Enter all three numbers. Each is between 1 and 99.", "miss");
  const obs = vals.map(Number);

  const R = Number($("cal-radius").value);
  const hits = [];
  for (let d = -R; d <= R; d++){
    const c = vaultCode(state.armed + d);
    if (c[0] === obs[0] && c[1] === obs[1] && c[2] === obs[2]) hits.push(d);
  }
  hits.sort((a, b) => Math.abs(a) - Math.abs(b));

  if (!hits.length)
    return showResult(`No second within ±${Math.round(R / 60)} min produces <b>${fmtCode(obs)}</b>. `
      + "Widen the search, or check the numbers and their order.", "miss");

  /* How close a candidate offset is to the one already in effect — small and
     the likelier story is a mistimed press, not the offset actually moving. */
  const timing = d => {
    if (state.calAt === null || d === state.cal) return "";
    const k = d - state.cal;
    return Math.abs(k) <= TIMING_SLOP
      ? ` — looks like ~${Math.abs(k)}s ${k > 0 ? "late" : "early"}, same offset` : "";
  };

  if (hits.length > 1)
    return showResult(`${hits.length} seconds produce ${fmtCode(obs)}. Pick the one you believe:`
      + hits.slice(0, 8).map(d => `<button class="cand" type="button" data-d="${d}">${signed(d)}s `
        + `→ seed ${state.armed + d} (${utcTime(state.armed + d)} UTC)${timing(d)}</button>`).join(""), "hit");

  const d = hits[0];
  if (state.calAt !== null && d !== state.cal && Math.abs(d - state.cal) <= TIMING_SLOP){
    const k = d - state.cal;
    return showResult(
      `That matches pressing about <b>${Math.abs(k)}s ${k > 0 ? "late" : "early"}</b>, not a changed offset — `
      + `your current calibration (<b>${signed(state.cal)}s</b>) is probably still fine.`
      + `<button class="cand" type="button" data-keep="1">Keep it — I'll aim ${k > 0 ? "earlier" : "later"} next time</button>`
      + `<button class="cand" type="button" data-d="${d}">Apply ${signed(d)}s anyway</button>`,
      "hit");
  }
  commit(d);
}

function commit(d){
  const seed = state.armed + d;
  setCal(d);
  $("step2").classList.add("done");
  showResult(`Offset <b>${signed(d)}s</b> — the game recorded seed ${seed}. Applied to every prediction.`
    + (recalShortcut ? "" : " Now cancel this heist and start the real one."), "hit");
}

/* ===========================================================================
   10. Wiring.
   =========================================================================== */
$("rows").addEventListener("click", e => {
  const tr = e.target.closest("tr[data-w]");
  if (tr) select(Number(tr.dataset.w));
});
$("rows").addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tr = e.target.closest("tr[data-w]");
  if (tr){ e.preventDefault(); select(Number(tr.dataset.w)); }
});
/* The sticky header hides that the table has scrolled at all — a shadow
   under it, plus a floating back-to-top button, are the only cues, so add
   both. The shadow alone reads as too subtle against the dark theme. */
$("list").addEventListener("scroll", () => {
  const scrolled = $("list").scrollTop > 0;
  $("list").classList.toggle("scrolled", scrolled);
  $("to-top").hidden = !scrolled;
}, { passive: true });
$("to-top").addEventListener("click", () => $("list").scrollTo({ top: 0, behavior: "smooth" }));
$("window").addEventListener("change", e => { state.window = Number(e.target.value); build(); render(); });
$("sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
$("maxpress").addEventListener("input", e => {
  const v = Number(e.target.value);
  if (v >= 3 && v <= 150){ state.max = v; render(); }
});
/* The box takes a seed, so convert back to the second you would act on. */
$("lookup").addEventListener("input", e => {
  const raw = e.target.value.trim();
  if (/^\d{6,10}$/.test(raw)){ state.selected = Number(raw) - state.cal; paintDetail(); }
});

$("cal-open").addEventListener("click", () => { recalShortcut = false; paintArm(); calDlg.showModal(); });
$("cal-clear").addEventListener("click", clearCal);
calDlg.addEventListener("click", e => { if (e.target === calDlg) calDlg.close(); });
$("cal-arm").addEventListener("click", () => {
  recalShortcut = false;
  state.armed = Math.floor(nowMs() / 1000) + Number($("cal-lead").value);
  paintArmClock.jumped = false;
  store.set("armed", state.armed);
  paintArm(); showResult("", "");
});
$("cal-rearm").addEventListener("click", () => { state.armed = null; store.del("armed"); paintArm(); });
/* Shortcut into calibration step 2: treat the currently selected second as
   armed, so a code you already have skips straight to the search. */
$("d-recal").addEventListener("click", () => {
  state.armed = state.selected;
  recalShortcut = true;
  paintArmClock.jumped = false;
  store.set("armed", state.armed);
  paintArm();
  showResult("", "");
  calDlg.showModal();
});
$("cal-find").addEventListener("click", findOffset);
$("cal-result").addEventListener("click", e => {
  const b = e.target.closest("button.cand");
  if (!b) return;
  if (b.dataset.keep) return showResult("Keeping the current offset — nothing changed.", "hit");
  commit(Number(b.dataset.d));
});
["c1","c2","c3"].forEach((id, i, all) => {
  const el = $(id);
  el.addEventListener("keydown", e => { if (e.key === "Enter") findOffset(); });
  el.addEventListener("input", () => { if (el.value.length === 2 && i < 2) $(all[i + 1]).focus(); });
});

$("cal-manual-apply").addEventListener("click", () => {
  const raw = $("cal-manual").value.trim();
  if (!/^-?\d+$/.test(raw)) return showResult("Enter a whole number of seconds.", "miss");
  setCal(Number(raw));
  showResult(`Offset <b>${signed(Number(raw))}s</b> applied manually.`, "hit");
});
$("cal-manual").addEventListener("keydown", e => { if (e.key === "Enter") $("cal-manual-apply").click(); });

/* ===========================================================================
   11. Boot.
   =========================================================================== */
mainT.box = $("tminus"); mainT.main = $("t-main"); mainT.cs = $("t-cs");
armT.box  = $("arm-t");  armT.main  = $("arm-main"); armT.cs = $("arm-cs");

clock.onchange = paintSync;
syncClock(8);
setInterval(() => syncClock(2), 120000);

paintCal();
paintArm();
build();
render();
requestAnimationFrame(frame);

/* Rebuild every second so passed rows drop off, preserving scroll position. */
setInterval(() => {
  const box = document.querySelector(".list");
  const top = box ? box.scrollTop : 0;
  advance(); render();
  if (box) box.scrollTop = top;
}, 1000);

/* Keep the "measured N ago" reading, and the stale flag, honest without a reload. */
setInterval(paintCal, 60000);
