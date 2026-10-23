/*
 * ust.c — a minimal Amiga environment that runs the original ProTracker 2.3A
 * CIA playroutine (68000 machine code) to play modules.
 *
 * Emulated, because the routine uses it:
 *   - 2 MB of flat chip RAM at address 0
 *   - a 68000 (Musashi) at 7.09379 MHz (PAL)
 *   - Paula audio: 4 DMA channels (AUDxLC/LEN/PER/VOL) and DMACON
 *   - CIA-B timer A raising a level 6 interrupt, acknowledged via INTREQ
 *   - CIA-A port A bit 1 (the audio "LED" filter)
 *   - OpenResource("ciab.resource"), OpenLibrary("graphics.library") and
 *     AddICRVector, the three OS calls the routine makes
 *
 * The routine is loaded as an AmigaDOS hunk executable (assets/ptplay) that
 * starts with a small entry table, see emu/pt/ptglue.s.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "m68k.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

/* memory map */
#define RAM_SIZE      0x200000u
#define ALLOC_BASE    0x001000u          /* hunks are loaded from here        */
#define PT_MODULE     0x080000u          /* the glue's mt_data points here    */
#define MODULE_LIMIT  0x1F0000u
#define STACK_TOP     0x1FE000u
#define GFX_BASE      0x1FE400u          /* fake GfxBase, DisplayFlags at +206 */
#define CIAB_RES      0x1FE900u          /* fake ciab.resource, jump table below */
#define EXEC_BASE     0x1FF000u          /* fake ExecBase, jump table below   */
#define EXEC_LVO_SPAN 0x000400u
#define IDLE_ADDR     0x1FF800u          /* bra.s *                           */
#define HALT_ADDR     0x1FF804u          /* return address for called subs    */

#define CPU_HZ   7093790.0               /* PAL 68000 clock                   */
#define CIA_HZ   (CPU_HZ / 10.0)         /* E clock, 709379 Hz                */
#define PAULA_HZ 3546895.0               /* PAL colour clock                  */

/* entry table of the glue (emu/pt/ptglue.s) */
enum {
    G_SETCIAINT = 0, G_INIT = 4, G_END = 8, G_LEV6 = 12,
    G_ENABLE = 16, G_SPEED = 20, G_SONGPOS = 24, G_PATTPOS = 28, G_TEMPO = 32, G_VEC = 36, G_MAGIC = 40
};

/* ------------------------------------------------------------------------ */
/* RAM                                                                      */
/* ------------------------------------------------------------------------ */
static uint8_t ram[RAM_SIZE];

static inline uint32_t rd8(uint32_t a)  { return a < RAM_SIZE ? ram[a] : 0; }
static inline uint32_t rd16(uint32_t a) { return (rd8(a) << 8) | rd8(a + 1); }
static inline uint32_t rd32(uint32_t a) { return (rd16(a) << 16) | rd16(a + 2); }
static inline void wr8(uint32_t a, uint32_t v)  { if (a < RAM_SIZE) ram[a] = (uint8_t)v; }
static inline void wr16(uint32_t a, uint32_t v) { wr8(a, v >> 8); wr8(a + 1, v); }
static inline void wr32(uint32_t a, uint32_t v) { wr16(a, v >> 16); wr16(a + 2, v); }

/* ------------------------------------------------------------------------ */
/* Paula audio                                                              */
/* ------------------------------------------------------------------------ */
typedef struct {
    uint32_t lc;        /* AUDxLC  */
    uint16_t len;       /* AUDxLEN */
    uint16_t per;       /* AUDxPER */
    uint16_t vol;       /* AUDxVOL */
    uint32_t ptr;       /* current DMA pointer */
    uint32_t lencnt;    /* words left */
    int32_t  percnt;    /* period counter */
    uint16_t data;      /* current word */
    int8_t   out;       /* current sample byte */
    uint8_t  phase;     /* 0: fetch a new word next, 1: low byte next */
    uint8_t  on;        /* DMA running */
    float    gain;      /* declick: ramped volume actually applied */
    float    fade_val;  /* declick: last output before a DMA restart, faded out */
    float    fade_gain;
} Chan;

static Chan ch[4];

/* tick log: every tick's channel registers and every DMA restart, so a seek can rebuild Paula at any tempo */
typedef struct { uint32_t lc[4]; uint16_t len[4]; uint16_t per[4]; } TickRegs;
typedef struct { uint32_t tick; uint32_t ptr; uint16_t len; uint8_t chan; } Restart;
static int       log_on = 0;
static TickRegs *log_ticks = NULL;
static uint32_t  log_len = 0, log_cap = 0;
static Restart  *log_restarts = NULL;
static uint32_t  log_restart_len = 0, log_restart_cap = 0;

static void log_restart(int chan, uint32_t ptr, uint16_t len) {
    if (log_restart_len == log_restart_cap) {
        uint32_t cap = log_restart_cap ? log_restart_cap * 2 : 1024;
        Restart *grown = (Restart *)realloc(log_restarts, cap * sizeof(Restart));
        if (!grown) { log_on = 0; return; }
        log_restarts = grown;
        log_restart_cap = cap;
    }
    log_restarts[log_restart_len++] = (Restart){log_len, ptr, len, (uint8_t)chan};
}
static uint16_t dmacon = 0x0200;   /* DMAEN set, like after boot */
static uint16_t intreq = 0;

/* declick: what modern players do and Paula does not. Volume changes are
 * ramped over DECLICK_MS and a DMA restart crossfades from the old output to
 * the new sample instead of jumping. Off by default, the hardware clicks. */
static int declick = 0;
#define DECLICK_MS 1.0

static inline int chan_volume(const Chan *c) { return (c->vol & 0x40) ? 64 : (c->vol & 0x3f); }

static void update_dma(void) {
    for (int i = 0; i < 4; i++) {
        Chan *c = &ch[i];
        int on = (dmacon & 0x200) && (dmacon & (1u << i));
        if (on && !c->on) {           /* DMA switched on: restart from LC/LEN */
            if (log_on) log_restart(i, c->lc, c->len);
            if (declick) {
                c->fade_val = c->out * c->gain;
                c->fade_gain = 1.f;
                c->gain = 0.f;
            }
            c->ptr = c->lc;
            c->lencnt = c->len ? c->len : 65536;
            c->phase = 0;
            c->percnt = 1;
        }
        c->on = (uint8_t)on;
    }
}

static inline void chan_tick(Chan *c) {
    if (!c->on) return;
    if (--c->percnt > 0) return;
    c->percnt += c->per ? c->per : 65536;
    if (c->phase == 0) {
        if (c->lencnt == 0) {         /* end of sample: reload from the registers */
            c->ptr = c->lc;
            c->lencnt = c->len ? c->len : 65536;
        }
        c->data = (uint16_t)rd16(c->ptr & 0x1FFFFE);
        c->ptr += 2;
        c->lencnt--;
        c->out = (int8_t)(c->data >> 8);
        c->phase = 1;
    } else {
        c->out = (int8_t)(c->data & 0xff);
        c->phase = 0;
    }
}

/* ------------------------------------------------------------------------ */
/* CIA-B timer A, CIA-A port A                                              */
/* ------------------------------------------------------------------------ */
static struct { uint16_t latch, cnt; uint8_t cr, icr_mask, icr_flags, irq; } ciab;
static uint8_t ciaa_pra = 0x00;    /* bit 1 = 0: LED on, filter on; the routine turns it off */

static inline void ciab_tick(void) {
    if (!(ciab.cr & 1)) return;
    if (ciab.cnt == 0) {
        ciab.cnt = ciab.latch;
        ciab.icr_flags |= 1;
        if (ciab.cr & 8) ciab.cr &= (uint8_t)~1;       /* one-shot */
        if ((ciab.icr_mask & 1) && !ciab.irq) {
            ciab.irq = 1;
            intreq |= 0x2000;
            m68k_set_irq(6);
        }
    } else {
        ciab.cnt--;
    }
}

static uint32_t ciab_read(int reg) {
    switch (reg) {
        case 4:  return ciab.cnt & 0xff;
        case 5:  return ciab.cnt >> 8;
        case 13: {
            uint32_t r = ciab.icr_flags | (ciab.irq ? 0x80 : 0);
            ciab.icr_flags = 0;
            ciab.irq = 0;
            return r;
        }
        case 14: return ciab.cr;
        default: return 0;
    }
}

static void ciab_write(int reg, uint32_t v) {
    switch (reg) {
        case 4:  ciab.latch = (uint16_t)((ciab.latch & 0xff00) | (v & 0xff)); break;
        case 5:  ciab.latch = (uint16_t)((ciab.latch & 0x00ff) | ((v & 0xff) << 8));
                 if (!(ciab.cr & 1)) ciab.cnt = ciab.latch;
                 break;
        case 13: if (v & 0x80) ciab.icr_mask |= (uint8_t)(v & 0x7f);
                 else          ciab.icr_mask &= (uint8_t)~(v & 0x7f);
                 break;
        case 14: if (v & 0x10) ciab.cnt = ciab.latch;
                 ciab.cr = (uint8_t)(v & ~0x10);
                 break;
        default: break;
    }
}

/* ------------------------------------------------------------------------ */
/* custom chip registers                                                    */
/* ------------------------------------------------------------------------ */
static void custom_write(uint32_t reg, uint32_t v) {
    v &= 0xffff;
    if (reg >= 0x0a0 && reg < 0x0e0) {
        Chan *c = &ch[(reg - 0x0a0) >> 4];
        switch (reg & 0xf) {
            case 0x0: c->lc = (c->lc & 0x0000ffff) | ((v & 0x1f) << 16); break;
            case 0x2: c->lc = (c->lc & 0xffff0000) | (v & 0xfffe); break;
            case 0x4: c->len = (uint16_t)v; break;
            case 0x6: c->per = (uint16_t)v; break;
            case 0x8: c->vol = (uint16_t)v; break;
            default: break;
        }
        return;
    }
    switch (reg) {
        case 0x096:                            /* DMACON */
            if (v & 0x8000) dmacon |= (uint16_t)(v & 0x7fff); else dmacon &= (uint16_t)~v;
            update_dma();
            break;
        case 0x09c:                            /* INTREQ */
            if (v & 0x8000) intreq |= (uint16_t)(v & 0x7fff); else intreq &= (uint16_t)~v;
            if (ciab.irq) intreq |= 0x2000;    /* CIA line still active */
            m68k_set_irq((intreq & 0x2000) ? 6 : 0);
            break;
        default: break;
    }
}

/* ------------------------------------------------------------------------ */
/* journal of CPU writes into the module (Invert Loop rewrites sample data)  */
/* ------------------------------------------------------------------------ */
typedef struct { uint32_t addr; uint8_t old, now; } Write;
static Write   *journal = NULL;
static uint32_t journal_len = 0, journal_cap = 0, journal_cur = 0;
static uint32_t journal_from = 0, journal_to = 0;     /* the module's address range, empty: no journal */
static int      journal_on = 0;                       /* only the host-clocked plugin seeks, the web player never */

/* Replaying the same timeline walks over the recorded writes, a different one truncates and records anew. */
static void journal_write(uint32_t a, uint8_t v) {
    if (journal_cur < journal_len && journal[journal_cur].addr == a && journal[journal_cur].now == v) {
        journal_cur++;
    } else {
        journal_len = journal_cur;
        if (journal_len == journal_cap) {
            uint32_t cap = journal_cap ? journal_cap * 2 : 1024;
            Write *grown = (Write *)realloc(journal, cap * sizeof(Write));
            if (!grown) { ram[a] = v; return; }
            journal = grown;
            journal_cap = cap;
        }
        journal[journal_len++] = (Write){a, ram[a], v};
        journal_cur = journal_len;
    }
    ram[a] = v;
}

static void journal_seek(uint32_t target) {
    while (journal_cur > target) { journal_cur--; ram[journal[journal_cur].addr] = journal[journal_cur].old; }
    while (journal_cur < target && journal_cur < journal_len) { ram[journal[journal_cur].addr] = journal[journal_cur].now; journal_cur++; }
}

static void journal_reset(uint32_t from, uint32_t to) {
    journal_len = journal_cur = 0;
    journal_from = from;
    journal_to = to;
}

static inline void ram_write8(uint32_t a, uint8_t v) {
    if (journal_on && a >= journal_from && a < journal_to) journal_write(a, v); else ram[a] = v;
}

/* ------------------------------------------------------------------------ */
/* 68000 bus                                                                */
/* ------------------------------------------------------------------------ */
static inline int is_ciab(uint32_t a) { return (a & 0xFFF000) == 0xBFD000 && !(a & 1); }
static inline int is_ciaa_pra(uint32_t a) { return a == 0xBFE001; }
static inline int is_custom(uint32_t a) { return (a & 0xFFF000) == 0xDFF000; }

unsigned int m68k_read_memory_8(unsigned int a) {
    a &= 0xFFFFFF;
    if (a < RAM_SIZE) return ram[a];
    if (is_ciab(a)) return ciab_read((a >> 8) & 15);
    if (is_ciaa_pra(a)) return 0xFC | (ciaa_pra & 3);    /* no mouse buttons */
    return 0;
}
unsigned int m68k_read_memory_16(unsigned int a) {
    a &= 0xFFFFFF;
    if (a + 1 < RAM_SIZE) return ((uint32_t)ram[a] << 8) | ram[a + 1];
    return (m68k_read_memory_8(a) << 8) | m68k_read_memory_8(a + 1);
}
unsigned int m68k_read_memory_32(unsigned int a) {
    return (m68k_read_memory_16(a) << 16) | m68k_read_memory_16(a + 2);
}

void m68k_write_memory_8(unsigned int a, unsigned int v) {
    a &= 0xFFFFFF;
    if (a < RAM_SIZE) { ram_write8(a, (uint8_t)v); return; }
    if (is_ciab(a)) { ciab_write((a >> 8) & 15, v); return; }
    if (is_ciaa_pra(a)) ciaa_pra = (uint8_t)v;
}
void m68k_write_memory_16(unsigned int a, unsigned int v) {
    a &= 0xFFFFFF;
    if (a + 1 < RAM_SIZE) { ram_write8(a, (uint8_t)(v >> 8)); ram_write8(a + 1, (uint8_t)v); return; }
    if (is_custom(a)) { custom_write(a & 0x1FE, v); return; }
    m68k_write_memory_8(a, v >> 8);
    m68k_write_memory_8(a + 1, v);
}
void m68k_write_memory_32(unsigned int a, unsigned int v) {
    m68k_write_memory_16(a, v >> 16);
    m68k_write_memory_16(a + 2, v);
}

/* ------------------------------------------------------------------------ */
/* exec.library / ciab.resource stubs + instruction hook                    */
/* ------------------------------------------------------------------------ */
static volatile int halted = 0;
static uint32_t pt = 0;             /* base of the glue + routine */
static uint32_t pt_end = 0;         /* end of the loaded hunks, the routine's whole state lives in [pt, pt_end) */
static uint32_t pt_vec = 0;         /* glue's Vec slot (is_Code, is_Data) */

static void return_from_stub(uint32_t d0) {
    m68k_set_reg(M68K_REG_D0, d0);
    uint32_t sp = m68k_get_reg(NULL, M68K_REG_SP);
    m68k_set_reg(M68K_REG_SP, sp + 4);
    m68k_set_reg(M68K_REG_PC, rd32(sp));
}

static int name_is(uint32_t a, const char *s) {
    size_t n = strlen(s) + 1;
    return a + n <= RAM_SIZE && memcmp(ram + a, s, n) == 0;
}

static void exec_call(uint32_t lvo) {
    uint32_t a1 = m68k_get_reg(NULL, M68K_REG_A1) & 0xFFFFFF;
    uint32_t d0 = 0;
    if (lvo == 0x1f2) d0 = name_is(a1, "ciab.resource") ? CIAB_RES : 0;     /* OpenResource */
    if (lvo == 0x228) d0 = name_is(a1, "graphics.library") ? GFX_BASE : 0;  /* OpenLibrary  */
    return_from_stub(d0);                                                   /* CloseLibrary and the rest: no-op */
}

static void resource_call(uint32_t lvo) {
    uint32_t bit = m68k_get_reg(NULL, M68K_REG_D0) & 1;
    uint32_t a1 = m68k_get_reg(NULL, M68K_REG_A1);
    uint32_t d0 = 1;                                        /* failure */
    if (bit == 0 && lvo == 6) {                             /* AddICRVector(timer A, interrupt a1) */
        wr32(pt_vec, rd32(a1 + 18));                        /* is_Code */
        wr32(pt_vec + 4, rd32(a1 + 14));                    /* is_Data */
        ciab.icr_mask |= 1;
        d0 = 0;
    } else if (bit == 0 && lvo == 12) {                     /* RemICRVector */
        wr32(pt_vec, 0);
        ciab.icr_mask &= (uint8_t)~1;
        d0 = 0;
    }
    return_from_stub(d0);
}

static void instr_hook(unsigned int pc) {
    if (pc >= EXEC_BASE - EXEC_LVO_SPAN && pc < EXEC_BASE) { exec_call(EXEC_BASE - pc); return; }
    if (pc >= CIAB_RES - 0x20 && pc < CIAB_RES) { resource_call(CIAB_RES - pc); return; }
    if (pc == HALT_ADDR) { halted = 1; m68k_end_timeslice(); }
}

/* run a subroutine to completion with interrupts masked */
static int call_sub(uint32_t addr, uint32_t max_cycles) {
    m68k_set_reg(M68K_REG_SR, 0x2700);
    uint32_t sp = STACK_TOP - 4;
    wr32(sp, HALT_ADDR);
    m68k_set_reg(M68K_REG_SP, sp);
    m68k_set_reg(M68K_REG_PC, addr);
    halted = 0;
    uint32_t used = 0;
    while (!halted && used < max_cycles) used += (uint32_t)m68k_execute(20000);
    return halted ? 0 : -1;
}

/* park the CPU in the idle loop with interrupts enabled */
static void go_idle(void) {
    m68k_set_reg(M68K_REG_SR, 0x2000);
    m68k_set_reg(M68K_REG_SP, STACK_TOP);
    m68k_set_reg(M68K_REG_PC, IDLE_ADDR);
    halted = 0;
}

/* let a running interrupt handler finish before we poke at the state */
static void settle(void) {
    for (int i = 0; i < 2000 && m68k_get_reg(NULL, M68K_REG_PC) != IDLE_ADDR; i++) m68k_execute(100);
}

/* ------------------------------------------------------------------------ */
/* AmigaDOS hunk loader: code/data/bss hunks with 32 bit relocations         */
/* ------------------------------------------------------------------------ */
#define MAX_HUNKS 8

static int load_hunks(const uint8_t *d, uint32_t len, uint32_t *base, uint32_t *end) {
    uint32_t p = 0, seg[MAX_HUNKS], size[MAX_HUNKS];
#define U32() (p + 4 <= len ? (p += 4, ((uint32_t)d[p-4] << 24) | ((uint32_t)d[p-3] << 16) | ((uint32_t)d[p-2] << 8) | d[p-1]) : 0xFFFFFFFFu)
#define U16() (p + 2 <= len ? (p += 2, ((uint32_t)d[p-2] << 8) | d[p-1]) : 0xFFFFFFFFu)
    if (U32() != 0x3f3 || U32() != 0) return -1;            /* header, no resident names */
    uint32_t n = U32(), first = U32(), last = U32();
    if (n == 0 || n > MAX_HUNKS || first != 0 || last != n - 1) return -1;
    uint32_t next = ALLOC_BASE;
    for (uint32_t i = 0; i < n; i++) {
        size[i] = (U32() & 0x3fffffff) * 4;
        seg[i] = next;
        next += (size[i] + 7) & ~7u;
        if (next > PT_MODULE) return -2;
        memset(ram + seg[i], 0, size[i]);
    }
    int cur = -1;
    while (p < len) {
        uint32_t t = U32() & 0x3fffffff;
        if (t == 0x3e9 || t == 0x3ea) {                      /* code, data */
            if (++cur >= (int)n) return -1;
            uint32_t sz = U32() * 4;
            if (sz > size[cur] || p + sz > len) return -1;
            memcpy(ram + seg[cur], d + p, sz);
            p += sz;
        } else if (t == 0x3eb) {                             /* bss */
            if (++cur >= (int)n) return -1;
            U32();
        } else if (t == 0x3ec || t == 0x3f7) {               /* reloc32, reloc32 short */
            int s = t == 0x3f7;
            uint32_t start = p;
            for (;;) {
                uint32_t cnt = s ? U16() : U32();
                if (cnt == 0 || cnt == 0xFFFFFFFFu) break;
                uint32_t h = s ? U16() : U32();
                if (h >= n || cur < 0) return -1;
                for (uint32_t k = 0; k < cnt; k++) {
                    uint32_t off = s ? U16() : U32();
                    if (off == 0xFFFFFFFFu || off + 4 > size[cur]) return -1;
                    wr32(seg[cur] + off, rd32(seg[cur] + off) + seg[h]);
                }
            }
            if (s && ((p - start) & 2)) p += 2;              /* pad to a longword */
        } else if (t != 0x3f2) {                             /* end of hunk */
            return -1;
        }
    }
#undef U32
#undef U16
    *base = seg[0];
    *end = next;
    return 0;
}

/* ------------------------------------------------------------------------ */
/* public state                                                             */
/* ------------------------------------------------------------------------ */
static double   rate = 48000.0;
static uint32_t module_len = 0;
static uint32_t module_slots = 0;    /* patterns the loaded module has room for */
static int      playing = 0;
static int      filter_model = 1;   /* 0: none, 1: A500 (fixed RC + LED filter) */

static double cpu_acc = 0, paula_acc = 0;
static int    cia_rem = 0;
static int    cpu_over = 0;
static int    external_clock = 0;   /* 1: the host fires the ticks with ust_tick, CIA-B and the CPU stand still */

/* mixer: per channel left and right gains ramping to their targets, off = Paula's hard L R R L */
static int   mix_on = 0;
static float mix_l[4], mix_r[4], mix_step_l[4], mix_step_r[4], mix_to_l[4], mix_to_r[4];
static int   mix_ramp = 0;
static float chan_peak[4];          /* mixer path: each channel's peak since it was last read, pre-fader */

/* filters */
static float rc_a = 0.f, rc_l = 0.f, rc_r = 0.f;
static float bq_b0, bq_b1, bq_b2, bq_a1, bq_a2;
static float bq_l1, bq_l2, bq_r1, bq_r2;

static void setup_filters(void) {
    rc_a = (float)(1.0 - exp(-2.0 * M_PI * 4900.0 / rate));          /* A500 fixed 6 dB/oct  */
    double w0 = 2.0 * M_PI * 3275.0 / rate, q = 0.7071;              /* LED: 12 dB/oct Butterworth */
    double cw = cos(w0), sw = sin(w0), al = sw / (2.0 * q);
    double a0 = 1.0 + al;
    bq_b0 = (float)(((1.0 - cw) / 2.0) / a0);
    bq_b1 = (float)((1.0 - cw) / a0);
    bq_b2 = bq_b0;
    bq_a1 = (float)((-2.0 * cw) / a0);
    bq_a2 = (float)((1.0 - al) / a0);
    rc_l = rc_r = bq_l1 = bq_l2 = bq_r1 = bq_r2 = 0.f;
}

#define MAX_FRAMES 4096
static float out_l[MAX_FRAMES], out_r[MAX_FRAMES];

#define SCRATCH_SIZE (1u << 20)
static uint8_t scratch[SCRATCH_SIZE];

/* ------------------------------------------------------------------------ */
/* API                                                                      */
/* ------------------------------------------------------------------------ */
EXPORT uint8_t *ust_scratch(void)        { return scratch; }
EXPORT uint32_t ust_scratch_size(void)   { return SCRATCH_SIZE; }
EXPORT float   *ust_out_l(void)          { return out_l; }
EXPORT float   *ust_out_r(void)          { return out_r; }

EXPORT void ust_init(double sample_rate) {
    rate = sample_rate > 8000 ? sample_rate : 48000.0;
    memset(ram, 0, sizeof ram);
    pt = 0; pt_vec = 0;
    module_len = 0; playing = 0;
    journal_reset(0, 0);
    memset(ch, 0, sizeof ch);
    dmacon = 0x0200; intreq = 0;
    memset(&ciab, 0, sizeof ciab);
    ciaa_pra = 0;
    cpu_acc = paula_acc = 0; cia_rem = 0; cpu_over = 0;
    setup_filters();

    /* fake jump tables: every LVO entry is an RTS in case the hook misses */
    for (uint32_t a = EXEC_BASE - EXEC_LVO_SPAN; a < EXEC_BASE; a += 2) wr16(a, 0x4e75);
    for (uint32_t a = CIAB_RES - 0x20; a < CIAB_RES; a += 2) wr16(a, 0x4e75);
    wr16(GFX_BASE + 206, 0x0004);  /* DisplayFlags: PAL */
    wr16(IDLE_ADDR, 0x60fe);       /* bra.s * */
    wr16(HALT_ADDR, 0x60fe);

    m68k_set_cpu_type(M68K_CPU_TYPE_68000);
    m68k_init();
    m68k_set_instr_hook_callback(instr_hook);
    wr32(0, STACK_TOP);            /* reset SSP */
    wr32(4, IDLE_ADDR);            /* reset PC */
    m68k_pulse_reset();
    wr32(4, EXEC_BASE);            /* AbsExecBase */
    go_idle();
}

/* Load assets/ptplay and let the routine install its CIA interrupt. */
EXPORT int ust_load_program(const uint8_t *data, uint32_t len) {
    uint32_t base, end;
    pt = 0; pt_vec = 0; module_len = 0; playing = 0;
    int r = load_hunks(data, len, &base, &end);
    if (r) return r;
    if (rd32(base + G_MAGIC) != 0x50544349u) return -4;   /* "PTCI" */
    pt = base;
    pt_end = end;
    pt_vec = rd32(pt + G_VEC);
    wr32(0x78, pt + G_LEV6);                   /* level 6 autovector -> Lev6 */
    if (call_sub(pt + G_SETCIAINT, 1000000)) return -3;
    if (!ciab.icr_mask) return -5;             /* the routine did not get its timer */
    go_idle();
    return 0;
}

/* Load a 31 instrument module (header, patterns, samples), with room for `slots` patterns before the samples (0: as
 * the file lays them out), so a pattern added later moves no sample. */
static int load_module(const uint8_t *m, uint32_t len, uint32_t slots) {
    if (!pt) return -1;
    if (len < 1084) return -2;
    uint32_t count = 0;
    for (int i = 0; i < 128; i++) if (m[952 + i] + 1u > count) count = m[952 + i] + 1u;
    const uint32_t patterns_end = 1084 + count * 1024 < len ? 1084 + count * 1024 : len;
    if (slots < count) slots = count;
    const uint32_t ram_len = slots == count ? len : 1084 + slots * 1024 + (len - patterns_end);
    if (PT_MODULE + ram_len > MODULE_LIMIT) return -2;
    settle();
    playing = 0;
    call_sub(pt + G_END, 1000000);             /* mt_end: silence */
    journal_reset(0, 0);
    if (ram_len == len) {
        memcpy(ram + PT_MODULE, m, len);
    } else {
        memset(ram + PT_MODULE, 0, ram_len);
        memcpy(ram + PT_MODULE, m, patterns_end);
        memcpy(ram + PT_MODULE + 1084 + slots * 1024, m + patterns_end, len - patterns_end);
    }
    module_len = ram_len;
    module_slots = slots;
    /* ProTracker's loader sanitises sample headers before the routine ever
     * sees them: a repeat length of 0 becomes 1 (AUDxLEN = 0 would loop
     * 65536 words of memory) and loops are clamped to the sample. */
    for (int i = 0; i < 31; i++) {
        uint32_t h = PT_MODULE + 20 + 30 * i;
        uint32_t ln = rd16(h + 22), rs = rd16(h + 26), rl = rd16(h + 28);
        if (ln && rs >= ln) { rs = 0; rl = 1; }
        if (ln && rs + rl > ln) rl = ln - rs;
        if (rl == 0) rl = 1;
        wr16(h + 26, rs);
        wr16(h + 28, rl);
    }
    /* mt_init places the samples behind the highest pattern it finds, and every new maximum shortens its scan: the first
     * entry claims the slots meanwhile */
    const uint8_t first = ram[PT_MODULE + 952];
    if (slots > count) ram[PT_MODULE + 952] = (uint8_t)(slots - 1);
    call_sub(pt + G_INIT, 4000000);            /* mt_init (falls through mt_end) */
    ram[PT_MODULE + 952] = first;
    journal_reset(PT_MODULE, PT_MODULE + ram_len);
    go_idle();
    return 0;
}

EXPORT int ust_load_module(const uint8_t *m, uint32_t len) { return load_module(m, len, 0); }

EXPORT int ust_load_module_slots(const uint8_t *m, uint32_t len, uint32_t slots) { return load_module(m, len, slots); }

/* Write a byte of the loaded module's header or patterns, the routine reads them as it plays. */
EXPORT void ust_module_poke(uint32_t offset, uint8_t value) {
    if (module_len && offset < 1084 + module_slots * 1024) ram[PT_MODULE + offset] = value;
}

EXPORT int ust_play(void) {
    if (!module_len) return -1;
    settle();
    wr8(rd32(pt + G_ENABLE), 0xff);            /* st mt_Enable */
    playing = 1;
    return 0;
}

EXPORT void ust_stop(void) {
    if (!pt) return;
    settle();
    call_sub(pt + G_END, 1000000);
    playing = 0;
    go_idle();
}

static void log_tick(void);

/* ticks per row after the last tick, never 0 */
static int tick_speed(void) {
    int speed = pt ? (int)rd8(rd32(pt + G_SPEED)) : 6;
    return speed > 0 ? speed : 6;
}

/* Run the routine's tick interrupt once, to completion, right now. Returns the 68000 cycles spent. */
static double fire_tick(void) {
    double cycles = 0;
    ciab.icr_flags |= 1;
    ciab.irq = 1;
    intreq |= 0x2000;
    m68k_set_irq(6);
    for (int guard = 0; guard < 1000; guard++) {
        cycles += m68k_execute(200);
        if (!ciab.irq && !(intreq & 0x2000) && m68k_get_reg(NULL, M68K_REG_PC) == IDLE_ADDR) break;
    }
    if (log_on) log_tick();
    return cycles;
}

/* Move a channel's DMA on by `clocks` colour clocks without producing output. */
static void chan_advance(Chan *c, double clocks) {
    if (!c->on || clocks <= 0) return;
    uint32_t per = c->per ? c->per : 65536;
    if (clocks < c->percnt) { c->percnt -= (int32_t)clocks; return; }
    clocks -= c->percnt;
    uint64_t steps = 1 + (uint64_t)(clocks / per);
    c->percnt = (int32_t)(per - fmod(clocks, (double)per));
    if (c->phase == 1) { steps--; c->phase = 0; }
    uint64_t words = (steps + 1) / 2;
    c->phase = (uint8_t)(steps & 1);
    if (words == 0) { c->out = (int8_t)(c->data & 0xff); return; }
    if (words <= c->lencnt) {
        c->ptr += 2 * (uint32_t)words;
        c->lencnt -= (uint32_t)words;
    } else {
        uint32_t loop = c->len ? c->len : 65536;
        uint32_t last = (uint32_t)((words - c->lencnt - 1) % loop) + 1;
        c->ptr = c->lc + 2 * last;
        c->lencnt = loop - last;
    }
    c->data = (uint16_t)rd16((c->ptr - 2) & 0x1FFFFE);
    c->out = c->phase ? (int8_t)(c->data >> 8) : (int8_t)(c->data & 0xff);
}

static void log_tick(void) {
    if (log_len == log_cap) {
        uint32_t cap = log_cap ? log_cap * 2 : 4096;
        TickRegs *grown = (TickRegs *)realloc(log_ticks, cap * sizeof(TickRegs));
        if (!grown) { log_on = 0; return; }
        log_ticks = grown;
        log_cap = cap;
    }
    TickRegs *entry = &log_ticks[log_len++];
    for (int i = 0; i < 4; i++) { entry->lc[i] = ch[i].lc; entry->len[i] = ch[i].len; entry->per[i] = ch[i].per; }
}

/* Log every tick from now on (tick 0 = the next one), or stop logging. Starting clears the log. */
EXPORT void ust_log(int on) {
    if (on) log_len = log_restart_len = 0;
    log_on = on ? 1 : 0;
}

EXPORT uint32_t ust_log_ticks(void) { return log_len; }

/* Forget the log from tick `count` on, and log again from there with `on`. */
EXPORT void ust_log_truncate(uint32_t count, int on) {
    if (count < log_len) log_len = count;
    while (log_restart_len > 0 && log_restarts[log_restart_len - 1].tick >= log_len) log_restart_len--;
    log_on = on ? 1 : 0;
}

/* Rebuild the DMA position of every running channel for the state before tick `count` plus `last` of a tick, tick t
 * lasting `paula_clocks_per_beat` * (beats[t + 1] - beats[t]) since the channel's last restart. Needs `count` in the
 * log and `beats` up to `count`. */
EXPORT int ust_paula_rebuild(uint32_t count, double paula_clocks_per_beat, double last, const double *beats) {
    if (count == 0 || count > log_len) return -1;
    for (int i = 0; i < 4; i++) {
        Chan *c = &ch[i];
        if (!c->on) continue;
        int found = -1;
        for (int r = (int)log_restart_len - 1; r >= 0; r--) {
            if (log_restarts[r].chan == i && log_restarts[r].tick < count) { found = r; break; }
        }
        if (found < 0) continue;
        const Restart *restart = &log_restarts[found];
        c->ptr = restart->ptr;
        c->lencnt = restart->len ? restart->len : 65536;
        c->phase = 0;
        c->percnt = 1;
        for (uint32_t t = restart->tick; t < count; t++) {
            c->lc = log_ticks[t].lc[i];
            c->len = log_ticks[t].len[i];
            c->per = log_ticks[t].per[i];
            double clocks = paula_clocks_per_beat * (beats[t + 1] - beats[t]);
            chan_advance(c, t + 1 == count ? clocks * last : clocks);
        }
    }
    return 0;
}

EXPORT void ust_set_external_clock(int on) { external_clock = journal_on = on ? 1 : 0; cpu_over = 0; }

/* One tick of the routine at this point of the audio stream (external clock). */
EXPORT void ust_tick(void) {
    if (!pt || !playing) return;
    fire_tick();
}

/* Replay `ticks` ticks silently, Paula's DMA moved on by `paula_clocks_per_tick` after each, the last one only by `last`
 * of it. Returns the CPU cycles. */
EXPORT double ust_skip_ticks(int ticks, double paula_clocks_per_tick, double last) {
    if (!pt || !playing) return 0;
    settle();
    double cycles = 0;
    for (int t = 0; t < ticks; t++) {
        cycles += fire_tick();
        double clocks = paula_clocks_per_tick * (t + 1 == ticks ? last : 1.0);
        for (int i = 0; i < 4; i++) chan_advance(&ch[i], clocks);
    }
    cpu_over = 0;
    return cycles;
}

/* Channel `c`'s peak since the last call, 1 = a full scale byte at volume 64. Only the mixer path measures. */
EXPORT float ust_chan_peak(int c) {
    float peak = chan_peak[c & 3] / 8192.f;
    chan_peak[c & 3] = 0.f;
    return peak;
}

/* Move every running channel's DMA on by `clocks` colour clocks without output. */
EXPORT void ust_paula_advance(double clocks) {
    for (int i = 0; i < 4; i++) chan_advance(&ch[i], clocks);
}

/* Paula colour clocks for one beat at `bpm`. */
EXPORT double ust_paula_clocks_per_beat(double bpm) { return PAULA_HZ * 60.0 / bpm; }

/* ticks per row the routine plays at now */
EXPORT int ust_tick_speed(void) { return tick_speed(); }

/* Snapshot of everything playback changes once idle: the routine's hunk, Paula, DMACON, CIA-B, the LED bit and the
 * journal position of the module's rewritten bytes. */
EXPORT uint32_t ust_snapshot_size(void) {
    return (pt_end - pt) + sizeof ch + sizeof dmacon + sizeof intreq + sizeof ciab + sizeof ciaa_pra + sizeof journal_cur;
}

EXPORT void ust_snapshot_save(uint8_t *target) {
    settle();
    memcpy(target, ram + pt, pt_end - pt); target += pt_end - pt;
    memcpy(target, ch, sizeof ch); target += sizeof ch;
    memcpy(target, &dmacon, sizeof dmacon); target += sizeof dmacon;
    memcpy(target, &intreq, sizeof intreq); target += sizeof intreq;
    memcpy(target, &ciab, sizeof ciab); target += sizeof ciab;
    memcpy(target, &ciaa_pra, sizeof ciaa_pra); target += sizeof ciaa_pra;
    memcpy(target, &journal_cur, sizeof journal_cur);
}

EXPORT void ust_snapshot_load(const uint8_t *source) {
    memcpy(ram + pt, source, pt_end - pt); source += pt_end - pt;
    memcpy(ch, source, sizeof ch); source += sizeof ch;
    memcpy(&dmacon, source, sizeof dmacon); source += sizeof dmacon;
    memcpy(&intreq, source, sizeof intreq); source += sizeof intreq;
    memcpy(&ciab, source, sizeof ciab); source += sizeof ciab;
    memcpy(&ciaa_pra, source, sizeof ciaa_pra); source += sizeof ciaa_pra;
    uint32_t cursor;
    memcpy(&cursor, source, sizeof cursor);
    journal_seek(cursor);
    m68k_set_irq(0);
    go_idle();
    playing = 1;
    cpu_over = 0;
}

/* Mix channel `c` with `left` and `right` gains, reached linearly over `ramp` frames. The first call turns the mixer on,
 * starting from Paula's hard L R R L. */
EXPORT void ust_set_mix(int c, float left, float right, int ramp) {
    if (!mix_on) {
        for (int i = 0; i < 4; i++) {
            int l = i == 0 || i == 3;
            mix_l[i] = mix_to_l[i] = l ? 1.f : 0.f;
            mix_r[i] = mix_to_r[i] = l ? 0.f : 1.f;
        }
        mix_on = 1;
    }
    c &= 3;
    mix_to_l[c] = left;
    mix_to_r[c] = right;
    mix_ramp = ramp > 0 ? ramp : 0;
    for (int i = 0; i < 4; i++) {
        if (mix_ramp == 0) { mix_l[i] = mix_to_l[i]; mix_r[i] = mix_to_r[i]; mix_step_l[i] = mix_step_r[i] = 0.f; }
        else { mix_step_l[i] = (mix_to_l[i] - mix_l[i]) / (float)mix_ramp; mix_step_r[i] = (mix_to_r[i] - mix_r[i]) / (float)mix_ramp; }
    }
}

EXPORT void ust_set_filter(int on)    { filter_model = on ? 1 : 0; }
EXPORT void ust_set_led(int on)       { ciaa_pra = (uint8_t)((ciaa_pra & ~2) | (on ? 0 : 2)); }
EXPORT void ust_set_declick(int on)   { declick = on ? 1 : 0; }

EXPORT int    ust_song_len(void)      { return module_len ? (int)rd8(PT_MODULE + 950) : 0; }
EXPORT int    ust_song_pos(void)      { return pt ? (int)rd8(rd32(pt + G_SONGPOS)) : 0; }
EXPORT int    ust_row(void)           { return pt ? (int)(rd16(rd32(pt + G_PATTPOS)) >> 4) : 0; }
EXPORT int    ust_speed(void)         { return pt ? (int)rd8(rd32(pt + G_SPEED)) : 0; }
EXPORT int    ust_tempo(void)         { return pt ? (int)rd16(rd32(pt + G_TEMPO)) : 0; }
EXPORT int    ust_pattern(void)       { return module_len ? (int)rd8(PT_MODULE + 952 + (ust_song_pos() & 0x7f)) : 0; }
EXPORT double ust_tick_hz(void)       { return CIA_HZ / ((double)ciab.latch + 1.0); }
EXPORT int    ust_chan_period(int c)  { return ch[c & 3].per; }
EXPORT int    ust_chan_volume(int c)  { return chan_volume(&ch[c & 3]); }
EXPORT int    ust_chan_dma(int c)     { return ch[c & 3].on; }

/* copies the 20 byte song name into scratch and returns its length */
EXPORT int ust_title(void) {
    int n = 0;
    while (module_len && n < 20 && ram[PT_MODULE + n]) { scratch[n] = ram[PT_MODULE + n]; n++; }
    scratch[n] = 0;
    return n;
}

/* raw 4 byte pattern cell of the current row */
EXPORT uint32_t ust_cell(int c) {
    if (!module_len) return 0;
    return rd32(PT_MODULE + 1084 + ust_pattern() * 1024 + (rd16(rd32(pt + G_PATTPOS)) & 0x3f0) + 4 * (c & 3));
}

/* Render planar audio into ust_out_l()/ust_out_r(). */
EXPORT int ust_render(int frames) {
    if (frames > MAX_FRAMES) frames = MAX_FRAMES;
    if (frames < 0) frames = 0;
    for (int f = 0; f < frames; f++) {
        /* --- CPU + CIA for one output frame --- */
        if (!external_clock) {
            cpu_acc += CPU_HZ;
            int cycles = (int)(cpu_acc / rate);
            cpu_acc -= cycles * rate;
            int want = cycles - cpu_over;
            cia_rem += cycles;
            while (cia_rem >= 10) { cia_rem -= 10; ciab_tick(); }
            if (pt && want > 0) cpu_over = m68k_execute(want) - want; else cpu_over = 0;
        }

        /* --- Paula for one output frame (box-filtered decimation) --- */
        paula_acc += PAULA_HZ;
        int n = (int)(paula_acc / rate);
        paula_acc -= n * rate;
        float g[4], fadeL = 0.f, fadeR = 0.f, fades[4] = {0.f, 0.f, 0.f, 0.f};
        for (int i = 0; i < 4; i++) {
            Chan *c = &ch[i];
            float target = (float)chan_volume(c);
            if (declick) {
                const float step = 64.f * (float)(1000.0 / (DECLICK_MS * rate));   /* full scale per frame */
                float d = target - c->gain;
                if (d > step) d = step; else if (d < -step) d = -step;
                c->gain += d;
                if (c->fade_gain > 0.f) {
                    c->fade_gain -= step / 64.f;
                    if (c->fade_gain < 0.f) c->fade_gain = 0.f;
                    float fade = c->fade_val * c->fade_gain;
                    fades[i] = fade;
                    if (i == 0 || i == 3) fadeL += fade; else fadeR += fade;
                }
            } else {
                c->gain = target;
                c->fade_gain = 0.f;
            }
            g[i] = c->gain;
        }
        float fl, fr;
        if (mix_on) {
            if (mix_ramp > 0) {
                for (int i = 0; i < 4; i++) { mix_l[i] += mix_step_l[i]; mix_r[i] += mix_step_r[i]; }
                if (--mix_ramp == 0) for (int i = 0; i < 4; i++) { mix_l[i] = mix_to_l[i]; mix_r[i] = mix_to_r[i]; }
            }
            float sum[4] = {0.f, 0.f, 0.f, 0.f};
            for (int t = 0; t < n; t++) {
                chan_tick(&ch[0]); chan_tick(&ch[1]); chan_tick(&ch[2]); chan_tick(&ch[3]);
                sum[0] += ch[0].out * g[0]; sum[1] += ch[1].out * g[1]; sum[2] += ch[2].out * g[2]; sum[3] += ch[3].out * g[3];
            }
            fl = fr = 0.f;
            if (n) {
                for (int i = 0; i < 4; i++) {
                    float v = sum[i] / (float)n + fades[i];
                    if (fabsf(v) > chan_peak[i]) chan_peak[i] = fabsf(v);
                    fl += v * mix_l[i];
                    fr += v * mix_r[i];
                }
                fl /= 16384.0f;
                fr /= 16384.0f;
            }
        } else {
            float l = 0.f, r = 0.f;
            for (int t = 0; t < n; t++) {
                chan_tick(&ch[0]); chan_tick(&ch[1]); chan_tick(&ch[2]); chan_tick(&ch[3]);
                l += ch[0].out * g[0] + ch[3].out * g[3];
                r += ch[1].out * g[1] + ch[2].out * g[2];
            }
            fl = n ? (l / (float)n + fadeL) / 16384.0f : 0.f;
            fr = n ? (r / (float)n + fadeR) / 16384.0f : 0.f;
        }

        if (filter_model) {
            rc_l += rc_a * (fl - rc_l); fl = rc_l;
            rc_r += rc_a * (fr - rc_r); fr = rc_r;
            if (!(ciaa_pra & 2)) {                     /* LED on -> filter on */
                float y = bq_b0 * fl + bq_l1; bq_l1 = bq_b1 * fl - bq_a1 * y + bq_l2; bq_l2 = bq_b2 * fl - bq_a2 * y; fl = y;
                y = bq_b0 * fr + bq_r1;       bq_r1 = bq_b1 * fr - bq_a1 * y + bq_r2; bq_r2 = bq_b2 * fr - bq_a2 * y; fr = y;
            }
        }
        out_l[f] = fl;
        out_r[f] = fr;
    }
    return frames;
}
