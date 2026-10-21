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
    $("cal-text").textContent = "未校准时间，通行密码可能因游戏会话计时延迟而错误";
    return;
  }
  const stale = calStale();
  bar.className = "cal " + (stale ? "stale" : "on");
  $("cal-text").textContent = signed(state.cal) + " 秒延迟已应用 · 于 " + ago(Date.now() - state.calAt) + " 已校准"
    + (stale ? " — 只有在 GTA V 游戏未重启时才能保持有效" : "");
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
  el.innerHTML = `由你目前设置的延迟为准：<b>早按了 1 秒时</b> ${codeAt(-1)}`
    + ` &middot; <b>准确时</b> ${codeAt(0)} &middot; <b>晚按了 1 秒时</b> ${codeAt(1)}`;
}

const armT = { box: null, main: null, cs: null };
function paintArmClock(ms){
  const phase = countdown(state.armed, ms, armT);
  $("arm-sub").textContent = phase > 0 ? "当此处显示“请立即开始抢劫”时，立刻支付抢劫准备费用"
                           : phase === 0 ? "立刻支付抢劫准备费用"
                           : "已结束，现在请你输入当前游戏提供给你的通行密码";
  if (phase < 0 && !paintArmClock.jumped){ paintArmClock.jumped = true; try{ $("c1").focus(); }catch(_){} }
}

function showResult(html, kind){
  const el = $("cal-result");
  el.className = "result " + kind;
  el.innerHTML = html;
}

function findOffset(){
  if (state.armed === null) return showResult("先在步骤 1 中准备在某一秒支付抢劫准备费用，稍后偏移将会由其进行测量", "miss");
  const vals = ["c1","c2","c3"].map(id => $(id).value.trim());
  if (!vals.every(v => /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 99))
    return showResult("请输入通行密码的三个数字，每个数字需在 1 - 99 之间", "miss");
  const obs = vals.map(Number);

  const R = Number($("cal-radius").value);
  const hits = [];
  for (let d = -R; d <= R; d++){
    const c = vaultCode(state.armed + d);
    if (c[0] === obs[0] && c[1] === obs[1] && c[2] === obs[2]) hits.push(d);
  }
  hits.sort((a, b) => Math.abs(a) - Math.abs(b));

  if (!hits.length)
    return showResult(`在 ±${Math.round(R / 60)} 分钟内没有可生成 <b>${fmtCode(obs)}</b> 的秒`
      + "需要提高搜索范围，或者检查数字及其顺序是否正确", "miss");

  /* How close a candidate offset is to the one already in effect — small and
     the likelier story is a mistimed press, not the offset actually moving. */
  const timing = d => {
    if (state.calAt === null || d === state.cal) return "";
    const k = d - state.cal;
    return Math.abs(k) <= TIMING_SLOP
      ? ` — 看起来你 ~${Math.abs(k)}s ${k > 0 ? "慢了" : "快了"}, same offset` : "";
  };

  if (hits.length > 1)
    return showResult(`有 ${hits.length} 秒会生成 ${fmtCode(obs)} 的通行密码。请选择你想要的一秒：`
      + hits.slice(0, 8).map(d => `<button class="cand" type="button" data-d="${d}">${signed(d)}秒 `
        + `→ 种子 ${state.armed + d} (${localTime(state.armed + d)} 本地时间)${timing(d)}</button>`).join(""), "hit");

  const d = hits[0];
  if (state.calAt !== null && d !== state.cal && Math.abs(d - state.cal) <= TIMING_SLOP){
    const k = d - state.cal;
    return showResult(
      `That matches pressing about <b>${Math.abs(k)}s ${k > 0 ? "late" : "early"}</b>, not a changed offset — `
      + `你目前的校准 (<b>${signed(state.cal)}s</b>) 应该是对的。`
      + `<button class="cand" type="button" data-keep="1">保留 - 我将在 ${k > 0 ? "提前" : "延后"} 进行校准</button>`
      + `<button class="cand" type="button" data-d="${d}">坚持应用 ${signed(d)} 秒偏移</button>`,
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
