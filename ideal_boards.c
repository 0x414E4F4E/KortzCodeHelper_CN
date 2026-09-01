/* Same search as ideal_boards.py, in C for raw scan throughput.
 * RNG + hackBoards() ported from src/kortz.js; edge-cost ranking ported from
 * ideal_boards.py. Multithreaded with pthreads, contiguous chunk per thread,
 * each thread keeps its own top-N, merged at the end.
 *
 * Build (WSL / any gcc):
 *   gcc -O3 -pthread -lm -o ideal_boards_c ideal_boards.c
 *
 * Run:
 *   ./ideal_boards_c --start 1788141930 --duration 157680000 --top 15
 */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
#include <stdatomic.h>

#define MAX_PAGES 4
#define MAX_COLS  6

static const uint32_t MUL = 1557985959u;

typedef struct { uint32_t v, c; } RngState;

static RngState seed_state(int64_t seed){
    uint32_t u = (uint32_t)seed;
    RngState s;
    s.v = u ? u : 1u;
    uint32_t rot16 = (uint32_t)((u << 16) | (u >> 16));
    s.c = rot16 ^ u;
    return s;
}

static uint32_t rng_step(RngState *s){
    uint32_t lo = s->v % 65536u, hi = s->v / 65536u;
    uint64_t p = (uint64_t)MUL * lo + s->c;
    uint64_t q = (uint64_t)MUL * hi;
    uint64_t r = (q % 65536u) * 65536u + p;
    s->v = (uint32_t)(r % 4294967296ULL);
    s->c = (uint32_t)((q / 65536u) + (r / 4294967296ULL));
    return s->v & 0x7FFFFFFFu;
}

static int script_range(RngState *s, int mn, int mx){
    return (int)floor((double)rng_step(s) * (mx - mn) / 2147483648.0) + mn;
}

typedef struct {
    int pages, cols, rows;
    int8_t boards[MAX_PAGES][MAX_COLS];
} HackResult;

static void hack_boards(int64_t seed, int hard, HackResult *out){
    out->pages = hard ? 4 : 3;
    out->cols  = hard ? 6 : 5;
    out->rows  = hard ? 5 : 4;
    for (int p = 0; p < out->pages; p++){
        RngState s = seed_state(seed + p);
        int8_t pick[MAX_COLS];
        for (int i = 0; i < out->cols; i++) pick[i] = (int8_t)script_range(&s, 0, out->rows);
        for (int i = 1; i < out->cols - 1; i++)
            if (pick[i] == pick[i - 1] || pick[i] == pick[i + 1])
                pick[i] = (int8_t)script_range(&s, 0, out->rows);
        memcpy(out->boards[p], pick, sizeof(pick));
    }
}

/* Top first, then bottom, then folding inward from each side in turn. */
static int edge_cost[MAX_COLS + 1];

static void build_edge_cost(int rows){
    int lo = 0, hi = rows - 1, idx = 0, top = 1;
    while (lo <= hi){
        int r = top ? lo : hi;
        edge_cost[r] = idx++;
        if (top) lo++; else hi--;
        top = !top;
    }
}

static int score_board(const int8_t *pick, int cols){
    int total = 0;
    for (int i = 0; i < cols; i++) total += edge_cost[pick[i]];
    return total;
}

typedef struct {
    int64_t seed;
    int total_cost, worst_page_cost;
    HackResult hb;
} Candidate;

static int cmp_candidate(const void *a, const void *b){
    const Candidate *x = a, *y = b;
    if (x->total_cost != y->total_cost) return x->total_cost - y->total_cost;
    return x->worst_page_cost - y->worst_page_cost;
}

_Atomic uint64_t g_scanned = 0;

typedef struct {
    int64_t start, end;
    int hard, top_n;
    Candidate *local;
    int local_count;
} ThreadArgs;

static void* worker(void *arg){
    ThreadArgs *a = arg;
    uint64_t since_flush = 0;
    for (int64_t t = a->start; t < a->end; t++){
        HackResult hb;
        hack_boards(t, a->hard, &hb);
        int total = 0, worst = 0;
        for (int p = 0; p < hb.pages; p++){
            int sc = score_board(hb.boards[p], hb.cols);
            total += sc;
            if (sc > worst) worst = sc;
        }
        int full = a->local_count == a->top_n;
        if (!full || total < a->local[a->top_n - 1].total_cost ||
            (total == a->local[a->top_n - 1].total_cost && worst < a->local[a->top_n - 1].worst_page_cost)){
            Candidate c = { t, total, worst, hb };
            int pos = full ? a->top_n - 1 : a->local_count++;
            while (pos > 0 && cmp_candidate(&c, &a->local[pos - 1]) < 0){
                a->local[pos] = a->local[pos - 1];
                pos--;
            }
            a->local[pos] = c;
        }
        if (++since_flush >= 65536){
            atomic_fetch_add(&g_scanned, since_flush);
            since_flush = 0;
        }
    }
    if (since_flush) atomic_fetch_add(&g_scanned, since_flush);
    return NULL;
}

static void render_board(const int8_t *pick, int cols, int rows){
    printf("      ");
    for (int c = 0; c < cols; c++) printf("%2d ", c);
    printf("\n");
    for (int r = 0; r < rows; r++){
        if (r == 0) printf("  top ");
        else if (r == rows - 1) printf("  bot ");
        else printf("   %d  ", r);
        for (int c = 0; c < cols; c++) printf(" %c ", pick[c] == r ? 'X' : '.');
        printf("\n");
    }
}

static double now_sec(void){
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

int main(int argc, char **argv){
    int64_t start = time(NULL);
    int64_t duration = 3600;
    int hard = 0, top_n = 10, workers = (int)sysconf(_SC_NPROCESSORS_ONLN);
    int quiet = 0;

    for (int i = 1; i < argc; i++){
        if (!strcmp(argv[i], "--start") && i + 1 < argc) start = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--duration") && i + 1 < argc) duration = atoll(argv[++i]);
        else if (!strcmp(argv[i], "--hard")) hard = 1;
        else if (!strcmp(argv[i], "--top") && i + 1 < argc) top_n = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--workers") && i + 1 < argc) workers = atoi(argv[++i]);
        else if (!strcmp(argv[i], "--quiet")) quiet = 1;
        else { fprintf(stderr, "unknown arg: %s\n", argv[i]); return 1; }
    }
    if (workers < 1) workers = 1;
    if (duration < workers) workers = (int)duration > 0 ? (int)duration : 1;

    build_edge_cost(hard ? 5 : 4);

    pthread_t *threads = malloc(sizeof(pthread_t) * workers);
    ThreadArgs *args = malloc(sizeof(ThreadArgs) * workers);
    int64_t chunk = (duration + workers - 1) / workers;
    for (int i = 0; i < workers; i++){
        args[i].start = start + i * chunk;
        args[i].end = args[i].start + chunk;
        if (args[i].end > start + duration) args[i].end = start + duration;
        args[i].hard = hard;
        args[i].top_n = top_n;
        args[i].local = malloc(sizeof(Candidate) * top_n);
        args[i].local_count = 0;
    }

    double t0 = now_sec();
    for (int i = 0; i < workers; i++) pthread_create(&threads[i], NULL, worker, &args[i]);

    double last_print = t0;
    while (1){
        uint64_t scanned = atomic_load(&g_scanned);
        double now = now_sec();
        int done = scanned >= (uint64_t)duration;
        if (!quiet && (now - last_print >= 2.0 || done)){
            double elapsed = now - t0;
            double rate = elapsed > 0 ? scanned / elapsed : 0;
            double pct = 100.0 * scanned / duration;
            double eta = rate > 0 ? (duration - (double)scanned) / rate : 0;
            fprintf(stderr, "  ... %5.1f%%  %llu/%lld s  %d workers  %.0f seeds/s  eta %.0fs\n",
                    pct, (unsigned long long)scanned, (long long)duration, workers, rate, eta);
            last_print = now;
        }
        if (done) break;
        usleep(50000);
    }
    for (int i = 0; i < workers; i++) pthread_join(threads[i], NULL);
    double elapsed = now_sec() - t0;

    int total_cands = 0;
    for (int i = 0; i < workers; i++) total_cands += args[i].local_count;
    Candidate *all = malloc(sizeof(Candidate) * total_cands);
    int k = 0;
    for (int i = 0; i < workers; i++)
        for (int j = 0; j < args[i].local_count; j++) all[k++] = args[i].local[j];
    qsort(all, total_cands, sizeof(Candidate), cmp_candidate);
    if (top_n < total_cands) total_cands = top_n;

    printf("Scanned %lld s from %lld (%s) with %d workers in %.1fs, best %d:\n\n",
           (long long)duration, (long long)start, hard ? "hard" : "normal", workers, elapsed, total_cands);

    for (int i = 0; i < total_cands; i++){
        Candidate *c = &all[i];
        time_t tt = (time_t)c->seed;
        struct tm tmv;
        gmtime_r(&tt, &tmv);
        char buf[32];
        strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S UTC", &tmv);
        printf("seed %lld  (%s)  total_cost=%d  worst_page_cost=%d\n",
               (long long)c->seed, buf, c->total_cost, c->worst_page_cost);
        for (int p = 0; p < c->hb.pages; p++){
            printf("  page %d:", p);
            for (int col = 0; col < c->hb.cols; col++) printf(" %d", c->hb.boards[p][col]);
            printf("\n");
            render_board(c->hb.boards[p], c->hb.cols, c->hb.rows);
        }
        printf("\n");
    }

    for (int i = 0; i < workers; i++) free(args[i].local);
    free(all); free(args); free(threads);
    return 0;
}
