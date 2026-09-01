#!/usr/bin/env python3
"""Scan a window of heist seeds (unix seconds) for hack boards whose columns
sit closest to the top/bottom edges, since the hack cursor starts at the top
row. Port of the RNG and hackBoards() derivation in src/kortz.js.

    python ideal_boards.py                      # next hour, normal, top 10
    python ideal_boards.py --start 1788134664 --duration 86400 --hard --top 5
"""
import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone

MUL = 1557985959
MASK32 = 0xFFFFFFFF


def seed_state(seed):
    u = seed & MASK32
    v = u if u != 0 else 1
    rot16 = ((u << 16) & MASK32) | (u >> 16)
    c = (rot16 ^ u) & MASK32
    return [v, c]


def step(s):
    v, c = s
    lo, hi = v % 65536, v // 65536
    p = MUL * lo + c
    q = MUL * hi
    r = (q % 65536) * 65536 + p
    s[0] = r % 4294967296
    s[1] = (q // 65536) + (r // 4294967296)
    return s[0] & 0x7FFFFFFF


def script_range(s, mn, mx):
    return int(step(s) * (mx - mn) / 2147483648) + mn


def hack_boards(seed, hard):
    pages = 4 if hard else 3
    cols = 6 if hard else 5
    rows = 5 if hard else 4
    boards = []
    for p in range(pages):
        s = seed_state(seed + p)
        pick = [script_range(s, 0, rows) for _ in range(cols)]
        for i in range(1, cols - 1):
            if pick[i] == pick[i - 1] or pick[i] == pick[i + 1]:
                pick[i] = script_range(s, 0, rows)
        boards.append(pick)
    return pages, cols, rows, boards


# Rank rows by distance from the cursor's path: top first, then bottom, then
# back in toward the middle from each side in turn.
def edge_cost_table(rows):
    order, lo, hi, top = [], 0, rows - 1, True
    while lo <= hi:
        order.append(lo if top else hi)
        if top:
            lo += 1
        else:
            hi -= 1
        top = not top
    return {r: i for i, r in enumerate(order)}


def score_board(pick, cost_table):
    return sum(cost_table[r] for r in pick)


def render_board(pick, rows):
    cols = len(pick)
    lines = [f"      {' '.join(f'{c:2d}' for c in range(cols))}"]
    for r in range(rows):
        tag = "top" if r == 0 else "bot" if r == rows - 1 else f" {r} "
        cells = " ".join(" X" if pick[c] == r else " ." for c in range(cols))
        lines.append(f"{tag:>5} {cells}")
    return "\n".join(lines)


def scan(start, duration, hard, top_n):
    rows = 5 if hard else 4
    cost_table = edge_cost_table(rows)
    results = []
    for t in range(start, start + duration):
        pages, cols, rows, boards = hack_boards(t, hard)
        page_scores = [score_board(b, cost_table) for b in boards]
        results.append((sum(page_scores), max(page_scores), t, boards, rows))
    results.sort(key=lambda x: (x[0], x[1]))
    return results[:top_n]


def _scan_chunk(args):
    start, duration, hard, top_n = args
    return scan(start, duration, hard, top_n)


def scan_parallel(start, duration, hard, top_n, workers, progress=True, interval=2.0):
    if workers <= 1 or duration <= workers:
        return scan(start, duration, hard, top_n)
    # many small chunks (not just one per worker) so progress reports land smoothly
    n_chunks = max(workers, min(500, max(1, duration // 5000)))
    chunk = -(-duration // n_chunks)  # ceil div
    tasks, t, remaining = [], start, duration
    while remaining > 0:
        c = min(chunk, remaining)
        tasks.append((t, c, hard, top_n))
        t += c
        remaining -= c

    merged, done, scanned = [], 0, 0
    t0 = last_print = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(_scan_chunk, task): task for task in tasks}
        for fut in as_completed(futures):
            merged.extend(fut.result())
            done += 1
            scanned += futures[fut][1]
            now = time.time()
            if progress and (now - last_print >= interval or done == len(tasks)):
                elapsed = now - t0
                rate = scanned / elapsed if elapsed > 0 else 0
                pct = 100 * scanned / duration
                eta = (duration - scanned) / rate if rate > 0 else 0
                print(f"  ... {pct:5.1f}%  {scanned}/{duration}s  "
                      f"{done}/{len(tasks)} chunks  {rate:,.0f} seeds/s  eta {eta:.0f}s",
                      file=sys.stderr)
                last_print = now
    merged.sort(key=lambda x: (x[0], x[1]))
    return merged[:top_n]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", type=int, default=int(time.time()), help="unix seconds, default now")
    ap.add_argument("--duration", type=int, default=3600, help="seconds to scan, default 3600")
    ap.add_argument("--hard", action="store_true", help="hard difficulty (6 cols x 5 rows x 4 pages)")
    ap.add_argument("--top", type=int, default=10, help="how many best seeds to print")
    ap.add_argument("--workers", type=int, default=os.cpu_count(), help="parallel processes, default all cores")
    ap.add_argument("--quiet", action="store_true", help="suppress progress reports")
    args = ap.parse_args()

    t0 = time.time()
    best = scan_parallel(args.start, args.duration, args.hard, args.top, args.workers,
                          progress=not args.quiet)
    elapsed = time.time() - t0
    diff = "hard" if args.hard else "normal"
    print(f"Scanned {args.duration}s from {args.start} ({diff}) with {args.workers} workers "
          f"in {elapsed:.1f}s, best {len(best)}:\n")

    for total, worst, seed, boards, rows in best:
        when = datetime.fromtimestamp(seed, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        print(f"seed {seed}  ({when})  total_cost={total}  worst_page_cost={worst}")
        for i, b in enumerate(boards):
            print(f"  page {i}: {b}")
            for line in render_board(b, rows).splitlines():
                print(f"    {line}")
        print()


if __name__ == "__main__":
    main()
