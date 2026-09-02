/* Kortz Code Helper — table.
   ---------------------------------------------------------------------------
   The upcoming-seconds table and the detail panel for whichever row is
   selected. Depends on state.js (state, $, fmtCode, ...) and kortz.js (the
   derivations); must load after both.
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   The table.
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
      <td class="r${r.press <= state.hl ? " cheap" : ""}">${r.press}</td>
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
   The detail panel.
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
  $("d-near").innerHTML = `<span>if you're early</span><b>${fmtCode(vaultCode(seed - 1))}</b>`
    + `<span>if you're late</span><b>${fmtCode(vaultCode(seed + 1))}</b>`;
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
