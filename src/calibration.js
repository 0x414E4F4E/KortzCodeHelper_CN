/* Kortz Code Helper — calibration.
   ---------------------------------------------------------------------------
   Step 1 arms a wall second and counts down to it; you confirm the setup cost
   on START. Step 2 takes the code the game actually produced and searches the
   seconds around the armed one for the seed that yields it. Three numbers over
   1-99 is ~970k combinations, so a hit inside a few minutes is effectively
   unique.

   Depends on state.js and table.js (setCal/clearCal rebuild the table).
   --------------------------------------------------------------------------- */
"use strict";

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
