// Same search as ideal_boards.py / ideal_boards.c, for .NET 10 — RNG + hackBoards()
// ported from src/kortz.js, edge-cost ranking ported from ideal_boards.py.
// Multithreaded with raw Thread objects (not Parallel.For) so the chunking
// matches the C version exactly: one contiguous range per worker, each
// keeping its own top-N, merged at the end.
//
// Build:  dotnet build -c Release
// Run:    dotnet bin/Release/net10.0/IdealBoards.dll --start 1788141930 --duration 157680000 --top 15

using System.Globalization;

const uint Mul = 1557985959u;
const int MaxPages = 4;
const int MaxCols = 6;

long start = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
long duration = 3600;
bool hard = false, quiet = false;
int topN = 10, workers = Environment.ProcessorCount;

for (int i = 0; i < args.Length; i++)
{
    switch (args[i])
    {
        case "--start": start = long.Parse(args[++i], CultureInfo.InvariantCulture); break;
        case "--duration": duration = long.Parse(args[++i], CultureInfo.InvariantCulture); break;
        case "--hard": hard = true; break;
        case "--top": topN = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
        case "--workers": workers = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
        case "--quiet": quiet = true; break;
        default: Console.Error.WriteLine($"unknown arg: {args[i]}"); return 1;
    }
}
if (workers < 1) workers = 1;
if (duration < workers) workers = (int)Math.Max(1, duration);

int[] edgeCost = BuildEdgeCost(hard ? 5 : 4);

var threadStates = new ThreadState[workers];
var threads = new Thread[workers];
long chunk = (duration + workers - 1) / workers;
for (int i = 0; i < workers; i++)
{
    long s = start + i * chunk;
    long e = Math.Min(s + chunk, start + duration);
    threadStates[i] = new ThreadState(s, e, hard, topN, edgeCost);
}

long scanned = 0;
var sw = System.Diagnostics.Stopwatch.StartNew();
for (int i = 0; i < workers; i++)
{
    var st = threadStates[i];
    threads[i] = new Thread(() => Worker(st, ref scanned)) { IsBackground = true };
    threads[i].Start();
}

double lastPrint = 0;
while (true)
{
    long s = Interlocked.Read(ref scanned);
    double now = sw.Elapsed.TotalSeconds;
    bool done = s >= duration;
    if (!quiet && (now - lastPrint >= 2.0 || done))
    {
        double rate = now > 0 ? s / now : 0;
        double pct = 100.0 * s / duration;
        double eta = rate > 0 ? (duration - s) / rate : 0;
        Console.Error.WriteLine($"  ... {pct,5:F1}%  {s}/{duration} s  {workers} workers  {rate:F0} seeds/s  eta {eta:F0}s");
        lastPrint = now;
    }
    if (done) break;
    Thread.Sleep(50);
}
foreach (var t in threads) t.Join();
double elapsed = sw.Elapsed.TotalSeconds;

var all = new List<Candidate>();
foreach (var st in threadStates) all.AddRange(st.Local.Take(st.LocalCount));
all.Sort(CompareCandidate);
if (all.Count > topN) all.RemoveRange(topN, all.Count - topN);

Console.WriteLine($"Scanned {duration} s from {start} ({(hard ? "hard" : "normal")}) with {workers} workers in {elapsed:F1}s, best {all.Count}:\n");
foreach (var c in all)
{
    var when = DateTimeOffset.FromUnixTimeSeconds(c.Seed).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture);
    Console.WriteLine($"seed {c.Seed}  ({when})  total_cost={c.TotalCost}  worst_page_cost={c.WorstCost}");
    for (int p = 0; p < c.Pages; p++)
    {
        Console.WriteLine("  page " + p + ": " + string.Join(' ', c.Board.AsSpan(p * MaxCols, c.Cols).ToArray()));
        RenderBoard(c.Board.AsSpan(p * MaxCols, c.Cols), c.Rows);
    }
    Console.WriteLine();
}
return 0;

static RngState SeedState(long seed)
{
    uint u = unchecked((uint)seed);
    uint v = u != 0 ? u : 1u;
    uint rot16 = (u << 16) | (u >> 16);
    return new RngState { V = v, C = rot16 ^ u };
}

static uint Step(ref RngState s)
{
    uint lo = s.V % 65536u, hi = s.V / 65536u;
    ulong p = (ulong)Mul * lo + s.C;
    ulong q = (ulong)Mul * hi;
    ulong r = (q % 65536u) * 65536u + p;
    s.V = (uint)(r % 4294967296UL);
    s.C = (uint)((q / 65536u) + (r / 4294967296UL));
    return s.V & 0x7FFFFFFFu;
}

static int ScriptRange(ref RngState s, int mn, int mx)
    => (int)Math.Floor((double)Step(ref s) * (mx - mn) / 2147483648.0) + mn;

static int[] BuildEdgeCost(int rows)
{
    var order = new int[rows];
    int lo = 0, hi = rows - 1, idx = 0; bool top = true;
    while (lo <= hi)
    {
        int r = top ? lo : hi;
        order[r] = idx++;
        if (top) lo++; else hi--;
        top = !top;
    }
    return order;
}

// Writes Pages*MaxCols row picks into board (only the first Cols of each Pages*MaxCols slice are valid).
static void ComputeBoard(long seed, bool hard, Span<sbyte> board, int[] edgeCost,
    out int pages, out int cols, out int rows, out int totalCost, out int worstCost)
{
    pages = hard ? 4 : 3;
    cols = hard ? 6 : 5;
    rows = hard ? 5 : 4;
    totalCost = 0; worstCost = 0;
    Span<sbyte> pick = stackalloc sbyte[MaxCols];
    for (int p = 0; p < pages; p++)
    {
        RngState s = SeedState(seed + p);
        for (int i = 0; i < cols; i++) pick[i] = (sbyte)ScriptRange(ref s, 0, rows);
        for (int i = 1; i < cols - 1; i++)
            if (pick[i] == pick[i - 1] || pick[i] == pick[i + 1])
                pick[i] = (sbyte)ScriptRange(ref s, 0, rows);
        int sc = 0;
        for (int i = 0; i < cols; i++) sc += edgeCost[pick[i]];
        totalCost += sc;
        if (sc > worstCost) worstCost = sc;
        pick.Slice(0, cols).CopyTo(board.Slice(p * MaxCols, cols));
    }
}

static void RenderBoard(ReadOnlySpan<sbyte> pick, int rows)
{
    Console.Write("      ");
    for (int c = 0; c < pick.Length; c++) Console.Write($"{c,2} ");
    Console.WriteLine();
    for (int r = 0; r < rows; r++)
    {
        Console.Write(r == 0 ? "  top " : r == rows - 1 ? "  bot " : $"   {r}  ");
        for (int c = 0; c < pick.Length; c++) Console.Write(pick[c] == r ? " X " : " . ");
        Console.WriteLine();
    }
}

static int CompareCandidate(Candidate a, Candidate b)
{
    int d = a.TotalCost - b.TotalCost;
    return d != 0 ? d : a.WorstCost - b.WorstCost;
}

static void Worker(ThreadState st, ref long scanned)
{
    Span<sbyte> board = stackalloc sbyte[MaxPages * MaxCols];
    long sinceFlush = 0;
    for (long t = st.Start; t < st.End; t++)
    {
        ComputeBoard(t, st.Hard, board, st.EdgeCost, out int pages, out int cols, out int rows, out int total, out int worst);
        bool full = st.LocalCount == st.TopN;
        if (!full || total < st.Local[st.TopN - 1].TotalCost ||
            (total == st.Local[st.TopN - 1].TotalCost && worst < st.Local[st.TopN - 1].WorstCost))
        {
            var c = new Candidate
            {
                Seed = t, TotalCost = total, WorstCost = worst,
                Pages = pages, Cols = cols, Rows = rows,
                Board = board.ToArray()
            };
            int pos = full ? st.TopN - 1 : st.LocalCount++;
            while (pos > 0 && CompareCandidate(c, st.Local[pos - 1]) < 0)
            {
                st.Local[pos] = st.Local[pos - 1];
                pos--;
            }
            st.Local[pos] = c;
        }
        if (++sinceFlush >= 65536)
        {
            Interlocked.Add(ref scanned, sinceFlush);
            sinceFlush = 0;
        }
    }
    if (sinceFlush > 0) Interlocked.Add(ref scanned, sinceFlush);
}

struct RngState { public uint V, C; }

struct Candidate
{
    public long Seed;
    public int TotalCost, WorstCost, Pages, Cols, Rows;
    public sbyte[] Board;
}

sealed class ThreadState
{
    public readonly long Start, End;
    public readonly bool Hard;
    public readonly int TopN;
    public readonly int[] EdgeCost;
    public readonly Candidate[] Local;
    public int LocalCount;

    public ThreadState(long start, long end, bool hard, int topN, int[] edgeCost)
    {
        Start = start; End = end; Hard = hard; TopN = topN; EdgeCost = edgeCost;
        Local = new Candidate[topN];
        LocalCount = 0;
    }
}
