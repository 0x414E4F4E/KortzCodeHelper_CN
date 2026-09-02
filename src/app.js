/* Kortz Code Helper — app.
   ---------------------------------------------------------------------------
   Event wiring and boot. Loads last: everything it wires up (state, the
   table/detail panel, the ticker, calibration) is defined in state.js,
   table.js, ticker.js and calibration.js, which must already be loaded. This
   file, and everything it depends on, is UI-only — kortz.js stays pure and
   testable (test.mjs runs it with no DOM).
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   Wiring.
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
/* data-theme is already set (or not) by the inline script in index.html's
   <head>, before first paint — this just makes the toggle button reflect it
   and lets clicking it override whatever localStorage/prefers-color-scheme
   picked. */
function paintThemeToggle(){
  const light = document.documentElement.getAttribute("data-theme") === "light";
  $("theme-toggle").textContent = light ? "☀" : "☾";
}
$("theme-toggle").addEventListener("click", () => {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  if (light) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", "light");
  try{ localStorage.setItem("kortz-theme", light ? "dark" : "light"); }catch(_){}
  paintThemeToggle();
});
$("window").addEventListener("change", e => { state.window = Number(e.target.value); build(); render(); });
$("sort").addEventListener("change", e => { state.sort = e.target.value; render(); });
$("maxpress").addEventListener("input", e => {
  const v = Number(e.target.value);
  if (v >= 3 && v <= 150){ state.max = v; render(); }
});
$("hlmax").addEventListener("input", e => {
  const v = Number(e.target.value);
  if (v >= 1 && v <= 150){ state.hl = v; render(); }
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
   Boot.
   =========================================================================== */
mainT.box = $("tminus"); mainT.main = $("t-main"); mainT.cs = $("t-cs");
armT.box  = $("arm-t");  armT.main  = $("arm-main"); armT.cs = $("arm-cs");

clock.onchange = paintSync;
syncClock(8);
setInterval(() => syncClock(2), 120000);

paintThemeToggle();
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
