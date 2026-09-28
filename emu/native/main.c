/* Native harness: renders a module through the emulated ProTracker routine into a WAV. */
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>

uint8_t *ust_scratch(void);
void ust_init(double);
int ust_load_program(const uint8_t *, uint32_t);
int ust_load_module(const uint8_t *, uint32_t);
int ust_play(void);
int ust_render(int);
float *ust_out_l(void);
float *ust_out_r(void);
int ust_song_pos(void);
int ust_row(void);
int ust_pattern(void);
int ust_song_len(void);
int ust_tempo(void);
int ust_speed(void);
double ust_tick_hz(void);
int ust_title(void);
void ust_set_filter(int);
void ust_set_led(int);
void ust_set_declick(int);
int ust_chan_period(int);
int ust_chan_volume(int);
int ust_chan_dma(int);

static uint8_t *slurp(const char *path, uint32_t *len) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc(n); fread(b, 1, n, f); fclose(f);
    *len = (uint32_t)n; return b;
}

static void wr32le(FILE *f, uint32_t v) { fputc(v, f); fputc(v >> 8, f); fputc(v >> 16, f); fputc(v >> 24, f); }
static void wr16le(FILE *f, uint32_t v) { fputc(v, f); fputc(v >> 8, f); }

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: %s ptplay module.mod out.wav [seconds] [filter 0/1] [led 0/1] [declick 0/1]\n", argv[0]); return 2; }
    double seconds = argc > 4 ? atof(argv[4]) : 30;
    const int rate = 48000;
    uint32_t plen, mlen;
    uint8_t *p = slurp(argv[1], &plen), *m = slurp(argv[2], &mlen);

    ust_init(rate);
    int r = ust_load_program(p, plen);
    if (r) { fprintf(stderr, "load_program failed: %d\n", r); return 1; }
    r = ust_load_module(m, mlen);
    if (r) { fprintf(stderr, "load_module failed: %d\n", r); return 1; }
    ust_title();
    printf("title: \"%s\"  positions: %d  tempo: %d  speed: %d  tick rate: %.3f Hz\n",
           (char *)ust_scratch(), ust_song_len(), ust_tempo(), ust_speed(), ust_tick_hz());
    ust_set_filter(argc > 5 ? atoi(argv[5]) : 1);
    ust_set_led(argc > 6 ? atoi(argv[6]) : 0);
    ust_set_declick(argc > 7 ? atoi(argv[7]) : 0);
    ust_play();

    FILE *w = fopen(argv[3], "wb");
    uint32_t total = (uint32_t)(seconds * rate);
    fwrite("RIFF", 1, 4, w); wr32le(w, 36 + total * 4); fwrite("WAVEfmt ", 1, 8, w);
    wr32le(w, 16); wr16le(w, 1); wr16le(w, 2); wr32le(w, rate); wr32le(w, rate * 4); wr16le(w, 4); wr16le(w, 16);
    fwrite("data", 1, 4, w); wr32le(w, total * 4);

    int lastpos = -1;
    double peak = 0, sumsq = 0;
    for (uint32_t done = 0; done < total;) {
        int n = total - done < 1024 ? (int)(total - done) : 1024;
        ust_render(n);
        float *l = ust_out_l(), *rr = ust_out_r();
        for (int i = 0; i < n; i++) {
            float a = l[i], b = rr[i];
            if (a > peak) peak = a; if (-a > peak) peak = -a;
            sumsq += a * a + b * b;
            wr16le(w, (uint16_t)(int16_t)(a * 32767.f)); wr16le(w, (uint16_t)(int16_t)(b * 32767.f));
        }
        done += n;
        int pos = ust_song_pos();
        if (pos != lastpos) {
            printf("t=%6.2fs pos %2d pat %2d row %2d |", done / (double)rate, pos, ust_pattern(), ust_row());
            for (int c = 0; c < 4; c++) printf(" ch%d per %3d vol %2d dma %d", c, ust_chan_period(c), ust_chan_volume(c), ust_chan_dma(c));
            printf("\n");
            lastpos = pos;
        }
    }
    fclose(w);
    printf("peak %.3f  rms %.3f\n", peak, sqrt(sumsq / (2.0 * total)));
    return 0;
}
