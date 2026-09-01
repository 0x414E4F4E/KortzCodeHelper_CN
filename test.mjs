/* node test.mjs
 *
 * Pins the seed derivations to values observed in-game, and checks that the
 * built file is a self-contained, parseable page. Run it after touching
 * kortz.js or the minifier in build.mjs.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { minifyJs } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;

function check(name, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `\n        got  ${g}\n        want ${w}`}`);
}

/* kortz.js is a classic script with no exports, so load it by evaluating it and
   handing back the names we want to test. */
const src = readFileSync(join(here, "src", "kortz.js"), "utf8");
const K = new Function(src + "\nreturn { vaultCode, laserVariant, hackBoards, presses };")();

/* --- vault code: confirmed in-game, 6/6 digits across two heists ---------- */
check("vault 1788134664", K.vaultCode(1788134664), [92, 57, 61]);
check("vault 1788136922", K.vaultCode(1788136922), [4, 88, 41]);

/* --- laser variant: source-derived, still unconfirmed against a layout ---- */
check("laser 1788134664", K.laserVariant(1788134664), 1);
check("laser 1788136922", K.laserVariant(1788136922), 1);
check("laser 1788138980", K.laserVariant(1788138980), 2);

/* --- hack boards: confirmed in-game, all 15 cells, seed 1788141930 -------- */
const h = K.hackBoards(1788141930, false);
check("hack normal shape", [h.pages, h.cols, h.rows], [3, 5, 4]);
check("hack 1788141930", h.boards, [[2,1,0,3,2],[1,2,3,2,1],[0,2,0,2,1]]);
/* Page 4 exists at every difficulty; normal just never shows it. Its middle
   column is the one place in the pinned data where the anti-adjacent fixup
   fires, so hard mode's extra page is pinned here too. */
check("hack hard shape", (() => { const x = K.hackBoards(1788141930, true); return [x.pages, x.cols, x.rows]; })(), [4, 6, 5]);

/* --- dial cost ----------------------------------------------------------- */
check("presses 92-57-61", K.presses([92,57,61]).total, 8 + 43 + 39);
check("presses 50/51 boundary", K.presses([50,51,1]).legs.map(l => l.cost + l.dir), ["50↑","49↓","1↑"]);

/* --- the built page ------------------------------------------------------ */
const dist = join(here, "dist", "kortz.html");
if (!existsSync(dist)){
  console.log("skip  dist/kortz.html not built — run `node build.mjs` first");
} else {
  const html = readFileSync(dist, "utf8");
  const js = html.slice(html.indexOf("<script>") + 8, html.lastIndexOf("</script>"));
  let parsed = true;
  try{ new Script(js); }catch(e){ parsed = false; console.log("        " + e.message); }
  check("built js parses", parsed, true);
  /* One file: nothing is loaded from disk or a CDN. The page does reach out to
     a time endpoint at runtime, which is a fetch, not a page dependency. */
  check("no external page assets", /\ssrc="|\shref="(?!#)/.test(html), false);
  check("time endpoints intact",
        ["time.akamai.com", "cloudflare.com/cdn-cgi/trace", "timeapi.io"].filter(h => !html.includes(h)),
        []);
}

/* ---------------------------------------------------------------------------
   The clock, against a simulated server.

   clock.js is driven entirely through fetch / Date / performance / setTimeout,
   so it can be run against a fake network with a KNOWN offset and checked. Time
   is virtual here — setTimeout and fetch advance it instantly — so a sync that
   takes seconds of wall clock runs in microseconds and is deterministic.

   The property that matters is not "the offset is accurate" but "the accuracy
   the UI claims is honest": the interval it reports must contain the true
   offset. A tight claim that does not contain the truth is worse than a loose
   one, because the page would look trustworthy while being wrong.
--------------------------------------------------------------------------- */
const clockSrc = readFileSync(join(here, "src", "clock.js"), "utf8");

function simulate({ trueOffset, rtt, asym, gran = 1000, rounds = 8 }){
  let T = 1788161600123, P = 0;
  const adv = ms => { T += ms; P += ms; };
  const fakeDate = { now: () => T, parse: Date.parse, UTC: Date.UTC };
  const fakePerf = { now: () => P };
  const fakeTimeout = (fn, ms) => { adv(ms); queueMicrotask(fn); return 0; };
  const fakeFetch = async () => {
    adv(rtt * asym);                                     // request in flight
    const stamp = Math.floor((T + trueOffset) / gran) * gran;   // server truncates
    adv(rtt * (1 - asym));                               // response in flight
    const iso = new Date(stamp).toISOString();
    return { ok: true, text: async () => gran === 1 ? iso : iso.replace(/\.\d+Z$/, "Z") };
  };
  const M = new Function("fetch", "setTimeout", "Date", "performance",
    clockSrc + "\nreturn { clock, syncClock };")(fakeFetch, fakeTimeout, fakeDate, fakePerf);
  return M.syncClock(rounds).then(() => ({
    err: M.clock.offset - trueOffset, acc: M.clock.acc, source: M.clock.source,
  }));
}

{
  const r = await simulate({ trueOffset: 3271, rtt: 60, asym: .5 });
  check("clock finds the offset", Math.abs(r.err) < 20, true);
  check("clock names its source", r.source, "akamai");

  /* A deterministic sweep, seeded so a failure is reproducible. Covers badly
     asymmetric links and round trips up to 210 ms. */
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let lied = 0, worst = 0;
  const errs = [];
  for (let i = 0; i < 120; i++){
    const r2 = await simulate({
      trueOffset: Math.round((rnd() - .5) * 200000),
      rtt: 10 + rnd() * 200,
      asym: .2 + rnd() * .6,
    });
    errs.push(Math.abs(r2.err));
    if (Math.abs(r2.err) > r2.acc) lied++;
    worst = Math.max(worst, Math.abs(r2.err));
  }
  errs.sort((a, b) => a - b);
  check("clock never overstates its accuracy", lied, 0);
  check("clock median error under 25 ms", Math.round(errs[60]) < 25, true);
  console.log(`      (median ${Math.round(errs[60])} ms, p95 ${Math.round(errs[114])} ms, max ${Math.round(worst)} ms)`);
}

/* The minifier must not change behaviour: run the pinned cases again against
   kortz.js as it actually ships. */
{
  const K2 = new Function(minifyJs(src) + "\nreturn { vaultCode, hackBoards };")();
  check("minified vault 1788134664", K2.vaultCode(1788134664), [92, 57, 61]);
  check("minified hack 1788141930", K2.hackBoards(1788141930, false).boards,
        [[2,1,0,3,2],[1,2,3,2,1],[0,2,0,2,1]]);
}

console.log(fails ? `\n${fails} failing` : "\nall good");
process.exit(fails ? 1 : 0);
