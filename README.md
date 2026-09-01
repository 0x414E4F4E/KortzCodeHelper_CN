# Kortz Code Helper

This site is built by Claude Code, however the research that informed it was a team effort between
me (Lucas7yoshi), Floorball, and Logan. I just suck ass at making web sites, so I just babysitted
Claude on making this. I have opinions on vibecoding that you can read more about
[here](https://git.l7y.media/slop/.profile).

A single self-contained HTML page that predicts, for any second you have not played yet, what the
Kortz Center heist will roll: the vault code, the laser variant, and the hacking-minigame boards.

```
node build.mjs        -> dist/kortz.html   (minified, ~33 kB, open it from disk)
node build.mjs --raw  -> readable output, for debugging
node test.mjs         -> pins the derivations to values observed in-game
```

No dependencies, no npm install. `dist/kortz.html` is the deliverable — one file, opens from `file://`,
works offline (see *Time sync* below for what it loses).

## How it works

The heist seed is `GET_CLOUD_TIME_AS_INT()` — a Unix timestamp in whole seconds — captured in the
frame you confirm the setup cost and stored in `MP_STAT_K26_HEIST_SEED`. So the second you trigger
setup decides everything the page shows. Pick a second, wait for the countdown, confirm on START.

**Calibrate once per GTA launch.** The game's clock is not read live: it is anchored from the sign-in
response and then runs a fixed number of seconds *behind* real time for the life of the process
(45–70 s observed). That lag is what the calibration dialog measures — arm a second, trigger setup on
it, type in the code the game gave you, and the page solves for the gap. Until then every code shown
is confidently wrong by that amount.

Recalibrating doesn't require the full arm-and-wait every time. If the offset has gone stale (the bar
turns amber) or you already have a code for a second you can pin down — one you just played, or one
found via the seed lookup — open that second's detail panel and use **Recalibrate from this code**. It
arms that exact second and drops straight into the code-entry step, skipping the countdown.

Recalibrating from a code you just played has a failure mode of its own: the game samples the seed on
the confirm press, not on the armed second, so if you're a beat early or late the code you get is for a
*different* second than the one you aimed at. Naively solving for a new offset from that code chases
timing noise — a 1s-late press looks identical to a 1s offset drift, so the next recalibration, aimed
using the now-shifted (wrong) offset, is more likely to be mistimed the same way, and the offset walks
back and forth. Two guards against that: step 2 shows a reference line with what the code would be at
±1s under your *current* offset, so you can eyeball a mismatch before submitting; and if the offset that
would result is within 2s of the current one, the page treats that as probably-mistimed-press rather
than drift and asks whether to keep the current offset (aiming to press earlier/later next time) or
apply the small change anyway, instead of silently overwriting it.

## Time sync

The page does not trust the PC clock. At load it measures the offset against a public time endpoint and
adds it to every reading; offline it falls back to the device clock and says so in red, and nothing else
changes.

A page opened from disk has the origin `null`, so an endpoint is only usable if it sends
`Access-Control-Allow-Origin: *` or echoes the request origin back. That rules out nearly everything:
most servers send a `Date` header but do not list it in `Access-Control-Expose-Headers`, which makes it
invisible to script. These three were verified from a real `file://` page in Edge on 2026-08-31:

| | ACAO | precision | note |
|---|---|---|---|
| `time.akamai.com/?iso` | echoes origin | whole second | 20-byte response, NTP-fed. Default. |
| `cloudflare.com/cdn-cgi/trace` | `*` | whole second | `ts=` is truncated |
| `timeapi.io` | `*` | millisecond | best precision, smallest operator — last on purpose |

`worldtimeapi.org` is the obvious candidate and is deliberately absent: it does not respond at all.

**Before adding an endpoint, check two things:** that it answers a `file://` page with a usable ACAO
header, and whether its timestamp is truncated to the whole second. The second one sets `gran` in
`clock.js`, and getting it wrong biases every reading half a second late.

A whole-second source does not give an offset, it gives an *interval* the offset must lie in: "the
server's clock had reached `t` by the time this was served." So a probe is informative in proportion to
how close it landed to a second boundary, and probes fired at arbitrary moments land at arbitrary phases
— which converges only as ~1000/N, about ±125 ms for eight probes.

So the sync runs in two phases. **Scatter:** three probes whenever they land, for a rough offset.
**Bracket:** now that we know roughly when the server's clock will tick, probes are *aimed* at the
boundary, alternating either side of it, with the aim halving each pair — a binary search on the tick.
One landing just after a tick pins the low end of the interval, one just before pins the high end.

Measured against a simulated server (`test.mjs` runs this on every test, with virtual time so it is
instant and deterministic): **median error 12 ms, p95 38 ms, worst 51 ms** across 120 random link
conditions including badly asymmetric routes and round trips up to 210 ms. Aimed probing is worth about
10x over scattered probing for the same request count.

The floor is half a round trip. `mid = wall0 + rtt/2` assumes the request and response legs are equally
fast, and they are not, so that much asymmetry bias survives however many probes are taken; the sync
stops there rather than reporting a precision it does not have.

The test pins one property above all: **the claimed accuracy must never overstate itself** — the ± the
header shows has to contain the true offset. A tight claim that does not contain the truth is worse than
a loose one, because the page looks trustworthy while being wrong.

Readings from different servers are never mixed. The running interval is widened by a 20 ppm allowance
for crystal drift between probes, and a reading disjoint from the accumulated one is treated as the clock
having jumped (an NTP re-sync, a suspend/resume) and starts over.

Each aimed probe waits for a tick, so a full sync takes a few seconds. The page is usable throughout and
the readout says `narrowing` until it settles.

Calibration would absorb a *constant* PC-clock error on its own, because both halves of it read the same
clock. What the sync adds is catching a badly-wrong clock **before** you burn a heist setup measuring
against it, and surviving a mid-session Windows NTP re-sync, which would otherwise silently invalidate a
measured offset with no visible symptom.

Not predictable, and deliberately absent from the UI: **which terminal holds the code**. That comes
from a value the session host rolls once at script start and broadcasts; it is never seeded and never
stored.

## Confidence

| | status |
|---|---|
| Vault code | confirmed in-game, 6/6 digits across two heists |
| Hack boards | confirmed in-game, all 15 cells, seed 1788141930 normal |
| Laser variant | derived from the script, **never checked against an observed layout** |

Both confirmed cases are pinned in `test.mjs`. If a derivation ever needs touching, that file is the
thing that tells you whether you broke it.

## Layout

```
src/index.html   markup
src/app.css      styles — every colour is a token at the top, dark and light palettes
                 both live under :root; the toggle just flips the html element's
                 data-theme attribute (☾/☀ button, top right — follows the OS
                 preference until you click it, then remembers your choice)
src/kortz.js     the RNG and the derivations. Pure, no DOM, tested directly.
src/clock.js     time sync: the endpoint list and the interval narrowing.
src/app.js       the UI. Assumes the other two are already loaded.
build.mjs        inlines all four into dist/kortz.html; also exports its minifiers.
                 SCRIPTS at the top is the load order — add new script files there.
test.mjs         the pins
```

Open `src/index.html` directly in a browser to work on it — the sources load from beside it, so there
is no dev server and no watch step. Build when you want the single file.

The build finds the stylesheet link and the three script tags **by their exact text** and swaps them for
inline blocks. Keep those four lines written as they are (one line each, double quotes, no extra
attributes) or the build throws.

## Notes on the minifiers

Hand-rolled, in `build.mjs`, and conservative on purpose: they strip comments and layout whitespace
and nothing else. Nothing is renamed, reordered or rewritten, and JavaScript line breaks are kept, so
automatic semicolon insertion behaves exactly as it does in the source. The scanner tracks strings,
template literals and regex literals so a `//` inside one survives.

`test.mjs` re-runs the pinned cases against the minified code, so a minifier bug fails the test rather
than shipping.
