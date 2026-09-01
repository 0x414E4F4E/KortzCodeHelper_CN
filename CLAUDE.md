# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Kortz Code Helper predicts, for a given second, what a GTA Online "Kortz Center" heist will roll:
the vault code, laser variant, and hacking-minigame boards. The deliverable is `dist/kortz.html` —
a single self-contained file, no dependencies, opens from `file://`, works offline. Everything else
in the repo (`ideal_boards.py`, `.c`, and `dotnet/`) is an offline search tool that scans many seeds
to find good hack-board layouts; they are three independent ports of the same RNG, not part of the
shipped page.

## Commands

### JS app (the actual product) — zero dependencies, no npm install
```
node build.mjs            # -> dist/kortz.html, minified (the deliverable)
node build.mjs --raw      # readable/unminified, for debugging
node build.mjs --out X    # write elsewhere
node test.mjs             # pins derivations to values observed in-game; run after touching
                           # src/kortz.js or the minifiers in build.mjs
```
There is no dev server and no watch step: open `src/index.html` directly in a browser to work on it
(sources load from beside it). Build only when you want the single-file output. `test.mjs` also
re-checks `dist/kortz.html` if it exists, so build before testing to get full coverage — a missing
`dist/kortz.html` just skips that section rather than failing.

### ideal_boards search tools (three ports of the same algorithm, pick one)
```
python ideal_boards.py --start <unix> --duration <secs> [--hard] [--top N]   # reference impl, multiprocessing

gcc -O3 -pthread -lm -o ideal_boards_c ideal_boards.c                        # build (WSL / any gcc)
./ideal_boards_c --start <unix> --duration <secs> --top 15                   # run, pthreads

dotnet build -c Release                                                       # in dotnet/IdealBoards/
dotnet bin/Release/net10.0/IdealBoards.dll --start <unix> --duration <secs> --top 15
```

## Architecture

### src/ — the page, four scripts loaded in a fixed order
```
src/index.html   markup
src/app.css      styles — every colour is a token at the top
src/kortz.js     the RNG and derivations. Pure, no DOM — this is what test.mjs exercises directly.
src/clock.js     time sync: endpoint list + interval-narrowing sync algorithm
src/app.js       UI glue. Assumes kortz.js and clock.js are already loaded; owns all DOM/localStorage access.
```
`app.js` calls into both of the others at load time, so load order matters: `kortz.js`, `clock.js`,
`app.js` last. That order is the `SCRIPTS` array at the top of `build.mjs` — add new script files
there, not just in `index.html`.

**build.mjs** concatenates and inlines all four files into `dist/kortz.html`. It finds the stylesheet
`<link>` and the three `<script src=...>` tags **by exact text match** and swaps them for inline
blocks — those four lines in `index.html` must stay one line each, double-quoted, no extra attributes,
or the build throws. The hand-rolled minifiers (JS/CSS/HTML) are deliberately conservative: they strip
comments and layout whitespace only, never rename/reorder/rewrite anything, and JS line breaks are
preserved so automatic semicolon insertion behaves identically to the unminified source. `test.mjs`
re-runs the pinned cases through `minifyJs` to catch minifier regressions directly.

### Core derivation model
The heist seed is `GET_CLOUD_TIME_AS_INT()`, a Unix timestamp in whole seconds, captured the moment
setup is confirmed. `kortz.js` implements `mthRandom`, RAGE script's Marsaglia multiply-with-carry
PRNG (32-bit value + 32-bit carry, seeded from the timestamp), and derives the vault code, laser
variant, and hack boards from it. The 64-bit step is done via 16-bit splits so intermediates stay
under 2^53 and are exact without BigInt — this same RNG is reimplemented (not shared code) in
`ideal_boards.py`, `.c`, and the C# port, so a change to the RNG or `hackBoards()` in `kortz.js` needs
mirroring in all three if they matter to keep in sync.

Two independent correction layers sit on top of the raw seed, both UI-side state in `app.js`:
- **Calibration (`state.cal`)**: the game's in-process clock runs a fixed but unknown number of
  seconds behind real time; measured once per GTA launch by arming a second, triggering setup, and
  comparing the code the game gave against what was predicted.
- **Time sync (`clock.js`)**: the page doesn't trust the PC clock — it measures an offset against a
  public time endpoint in two phases (scatter: rough probes; bracket: probes aimed at the next second
  boundary, halving the search each pair) and reports an honest accuracy interval rather than a
  falsely-tight one. `clock.js` is driven entirely through `fetch`/`Date`/`performance`/`setTimeout`,
  which is what lets `test.mjs` replace all four with virtual-time fakes and run the whole sync
  algorithm deterministically and instantly against a simulated server with a known offset, across
  120 randomized link conditions.

These two corrections are orthogonal: calibration absorbs a *constant* clock error (both halves of it
read the same clock), while time sync exists to catch a badly-wrong clock before it burns a heist
setup, and to survive a mid-session clock re-sync that calibration can't detect.

See README.md for the full design rationale (time endpoint selection/CORS constraints, the
scatter/bracket sync algorithm, and confidence status of each derivation).
