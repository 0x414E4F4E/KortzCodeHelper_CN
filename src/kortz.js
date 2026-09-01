/* Kortz Code Helper
   ---------------------------------------------------------------------------
   Everything the Kortz Center heist derives from its seed, for a second you
   have not played yet.

   The seed is GET_CLOUD_TIME_AS_INT() — a Unix timestamp in whole seconds —
   captured in the frame you confirm the setup cost, and stored in the stat
   MP_STAT_K26_HEIST_SEED. So the second you trigger setup decides the vault
   code, the laser variant and the hacking-minigame boards.

   Two caveats built into the UI:

   1. The game's clock is not live. It is anchored once from the sign-in
      response and runs a fixed number of seconds BEHIND real time for the life
      of the process. That lag is the `cal` offset; measure it once per launch.
   2. This page uses your PC clock. Any constant error in it is folded into the
      measured offset (both halves of the calibration read the same clock), so
      it cancels out — as long as the clock does not re-sync afterwards.

   Not predictable, and deliberately absent: which terminal holds the code. It
   comes from a host-rolled value that is broadcast, never seeded, never stored.
   --------------------------------------------------------------------------- */
"use strict";

/* ===========================================================================
   1. RAGE script RNG — mthRandom, a Marsaglia multiply-with-carry generator.

   State is a 32-bit value + 32-bit carry. Step: form MUL*value + carry in 64
   bits, low half becomes the value, high half the carry, return the value with
   its top bit cleared.

   The 64-bit product is done with a 16-bit split so every intermediate stays
   inside 2^53 and stays exact without BigInt. Verified against exact 64-bit
   arithmetic over 200k random states.
   =========================================================================== */
const MUL = 1557985959;

function seedState(seed){
  const u = seed >>> 0;
  // A zero seed is bumped to 1; the carry is rot16(seed) XOR seed.
  return { v: (u === 0 ? 1 : u) >>> 0, c: ((((u << 16) | (u >>> 16)) >>> 0) ^ u) >>> 0 };
}

function step(s){
  const lo = s.v % 65536, hi = Math.floor(s.v / 65536);
  const p = MUL * lo + s.c;
  const q = MUL * hi;
  const r = (q % 65536) * 65536 + p;
  s.v = r % 4294967296;
  s.c = Math.floor(q / 65536) + Math.floor(r / 4294967296);
  return s.v & 0x7FFFFFFF;
}

/* The two range natives map the same draw differently. Using the wrong one
   silently produces plausible, wrong numbers. */

/* NETWORK_GET_RANDOM_INT_RANGED — modulo, INCLUSIVE of max. */
const netRanged = (s, min, max) => min === max ? min : (step(s) % (max - min + 1)) + min;

/* GET_RANDOM_INT_IN_RANGE — multiply-shift, EXCLUSIVE of max.
   Written as a float divide rather than `(draw * span) >>> 31` because the
   product exceeds 2^32 and would wrap. */
const scriptRange = (s, min, max) => Math.floor(step(s) * (max - min) / 2147483648) + min;

/* ===========================================================================
   2. What the seed produces.
   =========================================================================== */

/* Vault code: three draws over 1-99 off one seeding of the NETWORK rng.
   Confirmed in-game against seeds 1788134664 and 1788136922 (6/6 digits). */
function vaultCode(seed){
  const s = seedState(seed);
  return [netRanged(s, 1, 99), netRanged(s, 1, 99), netRanged(s, 1, 99)];
}

/* Laser variant 0-2, one draw off the SCRIPT rng. Source-derived; never
   confirmed against an observed layout. */
const laserVariant = seed => scriptRange(seedState(seed), 0, 3);

/* Hacking minigame ("SIGNAL REPEATER").

   Each page is generated from SET_RANDOM_SEED(seed + page). Pages 0-3 are
   always generated; difficulty only decides how many the player must clear.

   Axes are TRANSPOSED from what the board draws: the script's loop runs once
   per SCREEN COLUMN, and each drawn value is the SCREEN ROW to light in that
   column, 0-based from the top.

              normal      hard
     pages       3          4
     columns     5          6
     rows        4          5

   After the draws, one fixup pass walks columns 1..n-2 and re-rolls any column
   matching either neighbour. It never touches the first or last column and
   never re-checks, so it can leave a clash behind — that is the game's
   behaviour, not a bug here.

   Confirmed in-game 2026-08-31: seed 1788141930, normal, all 15 cells exact. */
function hackBoards(seed, hard){
  const pages = hard ? 4 : 3;
  const cols  = hard ? 6 : 5;   // screen columns = one draw each
  const rows  = hard ? 5 : 4;   // screen rows    = the value range
  const out = [];
  for (let p = 0; p < pages; p++){
    const s = seedState(seed + p);
    const pick = [];
    for (let i = 0; i < cols; i++) pick.push(scriptRange(s, 0, rows));
    for (let i = 1; i < cols - 1; i++)
      if (pick[i] === pick[i - 1] || pick[i] === pick[i + 1]) pick[i] = scriptRange(s, 0, rows);
    out.push(pick);
  }
  return { pages, cols, rows, boards: out };
}

/* ===========================================================================
   3. Dial cost. 100 positions, wraps both ways, and each number is dialled
   from 00 — so the cost of a number is the shorter of the two directions.
   The three confirm presses are constant and left out.
   =========================================================================== */
function presses(code){
  const legs = code.map(n => {
    const d = n % 100;
    return { to: n, cost: Math.min(d, 100 - d), dir: d <= 50 ? "↑" : "↓" };
  });
  return { total: legs.reduce((a, l) => a + l.cost, 0), legs };
}
