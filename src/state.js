/* Kortz Code Helper — state.
   ---------------------------------------------------------------------------
   Shared state, localStorage persistence, and formatting helpers. Everything
   else under src/ (table.js, ticker.js, calibration.js, app.js) reads from
   `state` and uses these helpers — this file has no dependencies of its own
   beyond kortz.js/clock.js already being loaded, and must load before them.
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   State. `cal` is (what the game recorded) - (the second we aimed at), so
   acting on wall second w lands on seed w + cal.
   =========================================================================== */
const STALE_MS = 2 * 3600 * 1000;   // an offset dies with the GTA process
/* A delta this small from the *current* calibration reads as mistimed press
   (early/late by a beat), not a genuinely changed offset — see the nudge in
   findOffset(). Chasing every 1s jitter as if it were drift is what put users
   in a too-early/too-late loop. */
const TIMING_SLOP = 2;

const state = {
  window: 900, max: 35, sort: "time", hl: 15,
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
   Formatting helpers.
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
