/* Kortz Code Helper — ticker.
   ---------------------------------------------------------------------------
   The per-frame display loop: the header clock, the live "if you started this
   second" strip, the selected-row countdown, and the time-sync readout. The
   rAF loop here also drives the calibration arm-clock (paintArmClock, in
   calibration.js) once that dialog is open — it is called by name, not
   declaration order, so calibration.js loading after this file is fine.
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   Clocks. One rAF loop drives the header clock and both countdowns.
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
