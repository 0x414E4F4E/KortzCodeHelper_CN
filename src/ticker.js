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
  if (left < -1){ els.box.className = "tminus gone"; els.main.textContent = "已超时"; els.cs.textContent = ""; return -1; }
  if (left <= 0){ els.box.className = "tminus live"; els.main.textContent = "请立即开始抢劫";  els.cs.textContent = ""; return 0; }
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
    $("now-seed").textContent = "种子 " + seed;
  }
  $("now-fill").style.width = ((ms % 1000) / 1000 * 100) + "%";
}

function frame(){
  const ms = nowMs(), d = new Date(ms);
  $("clock-local").textContent = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  $("clock-frac").textContent = "." + pad2(Math.floor((ms % 1000) / 10));
  paintNow(ms);

  if (state.selected !== null){
    const phase = countdown(state.selected, ms, mainT);
    $("t-sub").textContent = phase > 0 ? "当倒计时出现“请立即开始抢劫”，立即确认支付。"
                           : phase === 0 ? "请立即开始抢劫"
                           : "选择的那一秒已超时";
  }
  if (calDlg.open && state.armed !== null) paintArmClock(ms);
  requestAnimationFrame(frame);
}

/* Time-sync readout. `clock` and nowMs() come from clock.js. */
function paintSync(){
  const el = $("sync");
  if (clock.source === null){
    el.className = "sync bad";
    el.textContent = "正在使用设备时间 - 无法确认时间";
    el.title = "未收到同步的时间，本次预测仅在本计算机时间完全精确的情况下才准确";
    return;
  }
  const a = Math.round(clock.acc);
  el.className = "sync";
  el.textContent = (a <= 250 ? "已同步" : "校准时间中") + " ±" + a + " ms · " + clock.source;
  el.title = "本计算机的时间与 "+ clock.source +" 服务器约有 " + signed(Math.round(clock.offset)) + " ms 的偏差";
}
