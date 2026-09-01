/* Kortz Code Helper — clock.
   ---------------------------------------------------------------------------
   Everything on the page hangs off knowing what second it is, so the page does
   not trust the PC clock. It measures the offset between this machine and a
   public time endpoint and adds it to every reading.

   Offline, or if every endpoint is unreachable, it falls back to the device
   clock and says so in red. Nothing breaks; the predictions are just only as
   good as Windows' own clock.

   Why this matters even though calibration absorbs a constant clock error: it
   catches a badly-wrong clock BEFORE you burn a heist setup measuring against
   it, and it survives a Windows NTP re-sync mid-session, which would otherwise
   silently invalidate a measured offset with no visible symptom.
   --------------------------------------------------------------------------- */
"use strict";

const clock = {
  offset: 0,        // ms to add to Date.now() to get true UTC
  acc: null,        // half-width of the surviving interval, ms
  source: null,     // name of the endpoint answering, null = device clock
  lo: -Infinity,    // the offset is somewhere in [lo, hi]
  hi: Infinity,
  onchange: null,   // set by the UI; called after every probe
};

/* The single clock the rest of the app reads. */
const nowMs = () => Date.now() + clock.offset;

/* ---------------------------------------------------------------------------
   Endpoints.

   A page opened from disk has the origin `null`, so an endpoint is only usable
   if it sends `Access-Control-Allow-Origin: *` or echoes the request origin
   back. That rules out almost everything: most servers send a `Date` header but
   do not list it in `Access-Control-Expose-Headers`, which makes it invisible
   to script. The three below were checked from a real file:// page in Edge on
   2026-08-31.

   Before adding one, check BOTH of these:
     1. it answers a file:// page (Origin: null) with a usable ACAO header;
     2. whether its timestamp is truncated to the whole second — that decides
        `gran` below, and getting it wrong biases every reading by half a
        second in the late direction.

   Order is preference. The first endpoint that answers wins for the session;
   the others are only tried if it fails. Readings from different servers are
   never mixed — they can legitimately disagree by tens of ms, and intersecting
   them would thrash.

   `worldtimeapi.org` is the obvious candidate and is deliberately absent: as of
   2026-08-31 it does not respond at all.
--------------------------------------------------------------------------- */
const CLOCK_SOURCES = [
  {
    /* Akamai's public time service. 20-byte response, NTP-fed, echoes Origin. */
    name: "akamai",
    url: "https://time.akamai.com/?iso",
    parse(body){
      const t = Date.parse(body.trim());
      return isFinite(t) ? { t, gran: /\.\d/.test(body) ? 1 : 1000 } : null;
    },
  },
  {
    /* Cloudflare's trace endpoint. ACAO *, but `ts` is truncated to the second. */
    name: "cloudflare",
    url: "https://www.cloudflare.com/cdn-cgi/trace",
    parse(body){
      const m = /(?:^|\n)ts=([\d.]+)/.exec(body);
      if (!m) return null;
      const secs = parseFloat(m[1]);
      if (!isFinite(secs)) return null;
      // A whole-second value means truncation; if it ever starts sending a real
      // fraction, believe it.
      return { t: Math.round(secs * 1000), gran: secs % 1 === 0 ? 1000 : 1 };
    },
  },
  {
    /* Millisecond precision, but a small service — last, not first. */
    name: "timeapi",
    url: "https://timeapi.io/api/time/current/zone?timeZone=UTC",
    parse(body){
      const j = JSON.parse(body);
      // Built from the fields rather than Date.parse(j.dateTime): that string
      // carries no zone marker, so parsing it would read as LOCAL time, and it
      // has 7 fractional digits, which is more than the spec allows.
      const t = Date.UTC(j.year, j.month - 1, j.day, j.hour, j.minute, j.seconds, j.milliSeconds);
      return isFinite(t) ? { t, gran: 1 } : null;
    },
  },
];

/* ---------------------------------------------------------------------------
   One probe.

   The response tells us the server's clock read `t` (or, for a whole-second
   source, something in [t, t + 1000)) at a moment we only know to within the
   round trip. So a probe does not give an offset — it gives an interval the
   offset must lie in. Intersecting the intervals from several probes taken at
   different sub-second phases is what actually narrows it.

   The round trip is measured across reading the body too, which overestimates
   it slightly. That only ever widens the interval, so it errs safe.
--------------------------------------------------------------------------- */
async function probeOnce(src){
  const url = src.url + (src.url.includes("?") ? "&" : "?") + "_=" + Date.now();
  const t0 = performance.now(), wall0 = Date.now();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = await res.text();
  const rtt = performance.now() - t0;
  const p = src.parse(body);
  if (!p) throw new Error("unparseable response");
  return { t: p.t, gran: p.gran, rtt, mid: wall0 + rtt / 2, half: rtt / 2 + 2 };
}

let lastProbeAt = null;
let lastRtt = 300;      // seeds the first aimed probe; replaced by real numbers
let lastGran = 1000;

function narrow(o){
  /* Intersection assumes the offset is constant, which it is not quite: a PC
     crystal drifts by some parts per million. Widen the running interval by an
     allowance for the time since the last probe, so a long-lived page narrows
     to something honest rather than to a false certainty. */
  if (lastProbeAt !== null && isFinite(clock.lo)){
    const slop = (performance.now() - lastProbeAt) * 20e-6;   // 20 ppm
    clock.lo -= slop;
    clock.hi += slop;
  }
  lastProbeAt = performance.now();
  lastRtt = o.rtt;
  lastGran = o.gran;

  const lo = o.t - o.mid - o.half;
  const hi = o.t + o.gran - o.mid + o.half;

  // Disjoint from what we had means the clock jumped (an NTP re-sync, a
  // suspend/resume). Believe the new reading and start over.
  if (lo > clock.hi || hi < clock.lo){ clock.lo = lo; clock.hi = hi; }
  else { clock.lo = Math.max(clock.lo, lo); clock.hi = Math.min(clock.hi, hi); }

  clock.offset = (clock.lo + clock.hi) / 2;
  clock.acc = (clock.hi - clock.lo) / 2;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const emit = () => { if (clock.onchange) clock.onchange(); };

/* The floor. The request and response legs of an HTTPS round trip are not
   equally fast, and `mid = wall0 + rtt/2` assumes they are, so roughly half a
   round trip of asymmetry bias survives no matter how many probes are taken.
   Probing past this point reports a precision that is not there, so stop. */
const floorMs = () => lastRtt / 2 + 8;

/* ---------------------------------------------------------------------------
   Sync, in two phases.

   Phase 1, scatter: a few probes whenever they land, to get a rough offset.

   Phase 2, bracket: this is where the precision actually comes from. A
   whole-second endpoint only ever says "my clock had reached t by the time this
   was served", so a probe is informative in proportion to how close it landed to
   a second boundary — and probes fired at arbitrary moments land at arbitrary
   phases, which converges only as ~1000/N. Once the rough offset is known,
   though, we know when the server's clock is about to tick, so the probes can be
   aimed: one landing just after a tick pins the low end of the interval tight,
   one just before pins the high end. That converges to about one round trip
   instead, which is 5-10x better for the same number of requests.

   Only whole-second sources need this. A millisecond source is already tight
   from a single probe, so phase 2 is skipped for it.
--------------------------------------------------------------------------- */
async function syncClock(rounds){
  for (const src of CLOCK_SOURCES){
    let got = 0;
    for (let i = 0; i < Math.min(rounds, 3); i++){
      try{
        narrow(await probeOnce(src));
        got++;
        clock.source = src.name;
      }catch(_){
        if (!got) break;                     // this endpoint is not answering
      }
      emit();
      if (clock.acc !== null && clock.acc <= floorMs()) return true;
      await sleep(150);
    }
    if (!got) continue;
    if (lastGran > 1) await bracket(src, rounds);
    return true;
  }
  emit();                                    // nothing answered — device clock
  return false;
}

/* Aim at the server's next second boundary.

   Probes alternate either side of the predicted tick so that both ends of the
   interval get pinned — landing repeatedly on one side would tighten one bound
   and leave the midpoint biased by the other. The offset from the tick halves
   every pair, which is a binary search on the boundary: the first pair brackets
   it coarsely, each later pair tightens by half.

   Nothing here can produce a WRONG interval even if the aim is badly off, since
   narrow() only ever intersects. A bad aim costs convergence speed, not
   correctness. Each probe waits for a tick, so this spends about a second per
   round — the page is fully usable throughout, and the readout says "narrowing"
   until it lands. */
async function bracket(src, tries){
  for (let i = 0; i < tries; i++){
    if (clock.acc !== null && clock.acc <= floorMs()) return;

    const aim = Math.max(6, 40 / (1 << (i >> 1))) * (i % 2 ? 1 : -1);
    const serverNow = Date.now() + clock.offset;
    const toTick = 1000 - ((serverNow % 1000) + 1000) % 1000;
    // Send half a round trip early so the request ARRIVES at the tick.
    let wait = toTick - lastRtt / 2 + aim;
    while (wait < 40) wait += 1000;          // never sprint at a boundary already gone

    await sleep(wait);
    try{ narrow(await probeOnce(src)); }
    catch(_){ return; }                      // it answered a moment ago; not worth retrying
    emit();
  }
}
