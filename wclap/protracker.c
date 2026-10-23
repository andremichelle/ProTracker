// ProTracker as a CLAP instrument: the emulator in emu/ust.c behind a stereo output, locked to the host's musical
// time. Four rows are a beat, its ticks spread evenly over it, so the song follows any tempo and any jump and a shuffle
// (alternating speeds) keeps its swing.
// A mixer pans each Paula channel. The state carries the params and the module, the first example is the default. The
// page (clap.webview) shows the song and the mixer, it polls the replayer state and loads modules.

#include <clap/clap.h>
#include <clap/ext/draft/webview.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "assets.h"

extern void ust_init(double sample_rate);
extern int ust_load_program(const uint8_t *data, uint32_t len);
extern int ust_load_module_slots(const uint8_t *data, uint32_t len, uint32_t slots);
extern void ust_module_poke(uint32_t offset, uint8_t value);
extern int ust_play(void);
extern int ust_render(int frames);
extern float *ust_out_l(void);
extern float *ust_out_r(void);
extern void ust_set_filter(int on);
extern void ust_set_declick(int on);
extern void ust_set_mix(int c, float left, float right, int ramp);
extern void ust_set_external_clock(int on);
extern void ust_tick(void);
extern double ust_skip_ticks(int ticks, double paula_clocks_per_tick, double last);
extern double ust_paula_clocks_per_beat(double bpm);
extern void ust_paula_advance(double clocks);
extern int ust_tick_speed(void);
extern uint32_t ust_snapshot_size(void);
extern void ust_snapshot_save(uint8_t *target);
extern void ust_snapshot_load(const uint8_t *source);
extern int ust_song_pos(void);
extern int ust_song_len(void);
extern int ust_pattern(void);
extern int ust_chan_period(int c);
extern int ust_chan_volume(int c);
extern int ust_chan_dma(int c);
extern float ust_chan_peak(int c);
extern int ust_row(void);
extern void ust_log(int on);
extern uint32_t ust_log_ticks(void);
extern void ust_log_truncate(uint32_t count, int on);
extern int ust_paula_rebuild(uint32_t count, double paula_clocks_per_beat, double last, const double *beats);

#define ROWS_PER_BEAT 4.0
#define SNAPSHOT_TICKS 128
#define MAX_SNAPSHOT_TICKS (1 << 17)
#define NOMINAL_BPM 125.0
#define JUMP_TOLERANCE_BEATS 1.0e-3
#define STATE_MAGIC 0x43575450u // "PTWC"
#define STATE_VERSION 1u
#define STATE_MAX_BYTES (4u << 20)
#define MODULE_MAX_BYTES 0x170000u
#define OUT_EVENTS 256
#define MACHINE_EDITS 64
#define TABLE_BYTES 130 // song length, restart and the 128 positions from byte 950 of the module
#define GUI_WIDTH 960
#define GUI_HEIGHT 640
#define GUI_MIN_WIDTH 640
#define GUI_MIN_HEIGHT 420

// page -> plugin
enum {
    PAGE_POLL = 1, PAGE_MODULE_REQUEST = 2, PAGE_LOAD = 3, PAGE_PARAM_BEGIN = 4, PAGE_PARAM_SET = 5, PAGE_PARAM_END = 6,
    PAGE_SET_PATTERN = 7, PAGE_INSERT_PATTERN = 8, PAGE_SET_CELL = 9
};
// plugin -> page
enum {PLUGIN_STATUS = 1, PLUGIN_MODULE = 2};
#define STATUS_BYTES (32 + PARAM_COUNT * 8)

// ids are indices into Params
enum {PARAM_PAN = 0, PARAM_VOLUME = 4, PARAM_MUTE = 8, PARAM_SEPARATION = 12, PARAM_FILTER = 13, PARAM_DECLICK = 14, PARAM_COUNT = 15};

typedef struct {const char *name; const char *module; double min, max, value; clap_param_info_flags flags;} Param;

#define AUTOMATABLE CLAP_PARAM_IS_AUTOMATABLE
#define SWITCH (CLAP_PARAM_IS_AUTOMATABLE | CLAP_PARAM_IS_STEPPED)

static const Param Params[PARAM_COUNT] = {
    {"Pan 1", "Channel 1", -1.0, 1.0, -1.0, AUTOMATABLE}, {"Pan 2", "Channel 2", -1.0, 1.0, 1.0, AUTOMATABLE},
    {"Pan 3", "Channel 3", -1.0, 1.0, 1.0, AUTOMATABLE}, {"Pan 4", "Channel 4", -1.0, 1.0, -1.0, AUTOMATABLE},
    {"Volume 1", "Channel 1", 0.0, 1.0, 1.0, AUTOMATABLE}, {"Volume 2", "Channel 2", 0.0, 1.0, 1.0, AUTOMATABLE},
    {"Volume 3", "Channel 3", 0.0, 1.0, 1.0, AUTOMATABLE}, {"Volume 4", "Channel 4", 0.0, 1.0, 1.0, AUTOMATABLE},
    {"Mute 1", "Channel 1", 0.0, 1.0, 0.0, SWITCH}, {"Mute 2", "Channel 2", 0.0, 1.0, 0.0, SWITCH},
    {"Mute 3", "Channel 3", 0.0, 1.0, 0.0, SWITCH}, {"Mute 4", "Channel 4", 0.0, 1.0, 0.0, SWITCH},
    {"Stereo Separation", "", 0.0, 1.0, 1.0, AUTOMATABLE},
    {"A500 Filter", "", 0.0, 1.0, 1.0, SWITCH},
    {"Declick", "", 0.0, 1.0, 0.0, SWITCH}
};

void emscripten_notify_memory_growth(size_t index) {(void) index;}

// a param change from the page, reported to the host as a gesture and a value
typedef struct {uint16_t type; clap_id id; double value;} OutEvent;

// what an edit changes in the song, so the pass is cut where the routine first reads it
enum {CUT_POSITION, CUT_POSITIONS_FROM, CUT_PATTERN};

// an edit for the machine: bytes at an offset of the module and where the song changed
typedef struct {uint32_t offset, length; uint8_t bytes[TABLE_BYTES]; int cut, value;} MachineEdit;

// what the page shows, taken at the end of every block
typedef struct {uint8_t playing, pos, pattern, row, speed, song_len; uint16_t period[4]; uint8_t volume[4], dma[4]; float peak[4];} Display;

typedef struct {
    clap_plugin_t plugin;
    const clap_host_t *host;
    double sample_rate;
    int ready;
    int playing;
    uint8_t *snapshots;      // the machine before tick k * SNAPSHOT_TICKS
    uint32_t snapshot_size;
    uint32_t snapshot_count;
    uint32_t snapshot_capacity;
    double *times;           // the beat tick k fires at, for every tick of the snapshot pass and the one after
    uint8_t *tick_pos;       // the song position after tick k of the pass
    uint32_t tick_count;     // ticks in the snapshot pass
    int pass_ended;          // the pass reached the song end or the cap, else an edit cut it and a seek runs it on
    int64_t next_tick;       // the next tick to fire
    double next_beat;        // the beat it fires at
    double beat_start;       // past the snapshot pass: the beat being played, measured ahead when it starts
    int64_t beat_start_tick;
    int64_t beat_ticks;
    uint8_t *fork;           // a snapshot to measure the next beat with
    double expected_beats;   // where the next block starts if the transport does not jump
    double values[PARAM_COUNT];
    int mix_dirty;
    uint8_t *module;         // the module as loaded, what the state saves
    uint32_t module_len;
    uint32_t module_serial;  // counts module swaps, the page fetches the module when it changes
    uint8_t *pending_module; // a module from the page, swapped in at the next block start
    uint32_t pending_len;
    volatile int pending_ready;
    MachineEdit machine_edits[MACHINE_EDITS];
    volatile uint32_t edit_write, edit_read;
    OutEvent out_events[OUT_EVENTS];
    volatile uint32_t out_write, out_read;
    Display display;
    uint32_t gui_width, gui_height;
    const clap_host_params_t *host_params;
    const clap_host_state_t *host_state;
    const clap_host_webview_t *host_webview;
} Tracker;

// the emulator is one machine in globals, so one plugin per module instance
static int instances = 0;

static const char *features[] = {CLAP_PLUGIN_FEATURE_INSTRUMENT, CLAP_PLUGIN_FEATURE_SAMPLER, CLAP_PLUGIN_FEATURE_STEREO, NULL};

static const clap_plugin_descriptor_t descriptor = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "studio.opendaw.protracker",
    .name = "ProTracker",
    .vendor = "André Michelle",
    .url = "https://github.com/andremichelle/ProTracker",
    .manual_url = "",
    .support_url = "",
    .version = "0.0.1",
    .description = "Peter \"Crayon\" Hanning's ProTracker 2.3A playroutine on an emulated Amiga",
    .features = features
};

static bool tracker_init(const clap_plugin_t *plugin) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    const clap_host_t *host = tracker->host;
    tracker->host_params = (const clap_host_params_t *) host->get_extension(host, CLAP_EXT_PARAMS);
    tracker->host_state = (const clap_host_state_t *) host->get_extension(host, CLAP_EXT_STATE);
    tracker->host_webview = (const clap_host_webview_t *) host->get_extension(host, CLAP_EXT_WEBVIEW);
    return true;
}

static void tracker_destroy(const clap_plugin_t *plugin) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    instances--;
    free(tracker->snapshots);
    free(tracker->times);
    free(tracker->tick_pos);
    free(tracker->fork);
    free(tracker->module);
    free(tracker->pending_module);
    free(tracker);
}

// the length of the tick just fired in rows of a quarter beat, by the speed it left behind
static double tick_slots(void) {return 1.0 / (ROWS_PER_BEAT * ust_tick_speed());}

// Every tick of a beat (four rows, pattern delays count) fires at an even share of it, so a shuffle keeps its swing.
// `slots` holds the row times, the last group stays as it is if the pass ended inside it.
static void spread_beats(double *slots, uint32_t count) {
    uint32_t first = 0;
    while (first < count) {
        const double beat = floor(slots[first] + 1.0e-9);
        uint32_t end = first;
        while (end < count && slots[end] < beat + 1.0 - 1.0e-9) {end++;}
        if (slots[end] < beat + 1.0 - 1.0e-9) {break;}
        for (uint32_t index = first; index < end; index++) {slots[index] = beat + (double) (index - first) / (double) (end - first);}
        first = end;
    }
}

// Ticks in the beat starting now, counted on a fork of the machine that is thrown away.
static int64_t measure_beat(Tracker *tracker) {
    ust_snapshot_save(tracker->fork);
    double slots = 0.0;
    int64_t ticks = 0;
    while (slots < 1.0 - 1.0e-9 && ticks < 1024) {
        ust_skip_ticks(1, 0.0, 1.0);
        slots += tick_slots();
        ticks++;
    }
    ust_snapshot_load(tracker->fork);
    return ticks;
}

// the beat `next_tick` fires at: from the pass, past it measured beat by beat
static void schedule(Tracker *tracker) {
    if (tracker->next_tick < tracker->tick_count) {
        tracker->next_beat = tracker->times[tracker->next_tick];
        return;
    }
    if (tracker->next_tick == tracker->tick_count) {
        tracker->beat_start = tracker->times[tracker->tick_count];
        tracker->beat_start_tick = tracker->next_tick;
        tracker->beat_ticks = measure_beat(tracker);
    } else if (tracker->next_tick - tracker->beat_start_tick >= tracker->beat_ticks) {
        tracker->beat_start += 1.0;
        tracker->beat_start_tick = tracker->next_tick;
        tracker->beat_ticks = measure_beat(tracker);
    }
    tracker->next_beat = tracker->beat_start
        + (double) (tracker->next_tick - tracker->beat_start_tick) / (double) tracker->beat_ticks;
}

static int is_beat(double beats) {return fabs(beats - round(beats)) < 1.0e-9;}

// room for `snapshots` snapshots and their ticks
static int reserve_pass(Tracker *tracker, uint32_t snapshots) {
    if (snapshots <= tracker->snapshot_capacity) {return 1;}
    uint32_t capacity = tracker->snapshot_capacity == 0 ? 64 : tracker->snapshot_capacity * 2;
    while (capacity < snapshots) {capacity *= 2;}
    const size_t ticks = (size_t) capacity * SNAPSHOT_TICKS + 1;
    uint8_t *grown = (uint8_t *) realloc(tracker->snapshots, (size_t) capacity * tracker->snapshot_size);
    if (grown != NULL) {tracker->snapshots = grown;}
    double *times = (double *) realloc(tracker->times, ticks * sizeof(double));
    if (times != NULL) {tracker->times = times;}
    uint8_t *positions = (uint8_t *) realloc(tracker->tick_pos, ticks);
    if (positions != NULL) {tracker->tick_pos = positions;}
    if (grown == NULL || times == NULL || positions == NULL) {return 0;}
    tracker->snapshot_capacity = capacity;
    return 1;
}

// A new pass, the machine at its start: mt_init leaves the routine speed - 1 ticks before row 0, they run silently, so
// row 0 plays at beat 0.
static int begin_pass(Tracker *tracker) {
    free(tracker->snapshots);
    free(tracker->times);
    free(tracker->tick_pos);
    free(tracker->fork);
    tracker->snapshots = NULL;
    tracker->times = NULL;
    tracker->tick_pos = NULL;
    tracker->snapshot_count = 0;
    tracker->snapshot_capacity = 0;
    tracker->tick_count = 0;
    tracker->pass_ended = 0;
    tracker->snapshot_size = ust_snapshot_size();
    tracker->fork = (uint8_t *) malloc(tracker->snapshot_size);
    if (tracker->fork == NULL || !reserve_pass(tracker, 1)) {return 0;}
    const int initial = ust_song_pos() * 64 + ust_row();
    ust_snapshot_save(tracker->fork);
    int lead = 0;
    while (lead < 256) {
        ust_skip_ticks(1, 0.0, 1.0);
        if (ust_song_pos() * 64 + ust_row() != initial) {break;}
        lead++;
    }
    ust_snapshot_load(tracker->fork);
    if (lead > 0 && lead < 256) {ust_skip_ticks(lead, 0.0, 1.0);}
    tracker->times[0] = 0.0;
    ust_log(1);
    return 1;
}

// The silent pass on from `tick_count`, the machine standing there, a snapshot every SNAPSHOT_TICKS, until the beat in
// which a backward position jump (the song wraps or loops with Bxx) happened is complete, the cap, or the first beat
// past `until`.
static void extend_pass(Tracker *tracker, double until) {
    const uint32_t from = tracker->tick_count;
    double slots = tracker->times[from];
    int last_pos = from == 0 ? 0 : tracker->tick_pos[from - 1];
    int ended = 0;
    ust_log_truncate(from, 1);
    for (int64_t tick = from; tick < MAX_SNAPSHOT_TICKS; tick++) {
        if (is_beat(slots) && (ended || round(slots) > until)) {break;}
        if (tick % SNAPSHOT_TICKS == 0 && tick / SNAPSHOT_TICKS == tracker->snapshot_count) {
            if (!reserve_pass(tracker, tracker->snapshot_count + 1)) {ended = 1; break;}
            ust_snapshot_save(tracker->snapshots + (size_t) tracker->snapshot_count++ * tracker->snapshot_size);
        }
        tracker->times[tick] = slots;
        ust_skip_ticks(1, 0.0, 1.0);
        slots += tick_slots();
        const int pos = ust_song_pos();
        tracker->tick_pos[tick] = (uint8_t) pos;
        tracker->tick_count = (uint32_t) tick + 1;
        if (pos < last_pos) {ended = 1;}
        last_pos = pos;
    }
    ust_log(0);
    tracker->pass_ended = ended || tracker->tick_count >= MAX_SNAPSHOT_TICKS;
    tracker->times[tracker->tick_count] = is_beat(slots) ? round(slots) : slots;
    spread_beats(tracker->times + from, tracker->tick_count - from);
}

// The machine at the end of the pass, the tick log up to it, so the pass runs on from there.
static void resume_pass(Tracker *tracker) {
    const uint32_t index = tracker->tick_count / SNAPSHOT_TICKS;
    ust_snapshot_load(tracker->snapshots + (size_t) index * tracker->snapshot_size);
    ust_log_truncate(index * SNAPSHOT_TICKS, 1);
    const uint32_t replay = tracker->tick_count - index * SNAPSHOT_TICKS;
    if (replay > 0) {ust_skip_ticks((int) replay, 0.0, 1.0);}
}

static int build_snapshots(Tracker *tracker) {
    if (!begin_pass(tracker)) {return 0;}
    extend_pass(tracker, INFINITY);
    if (tracker->snapshot_count == 0) {return 0;}
    ust_snapshot_load(tracker->snapshots);
    return 1;
}

static int reaches(const Tracker *tracker, uint8_t position, int kind, int value) {
    switch (kind) {
        case CUT_POSITION: return position == value;
        case CUT_POSITIONS_FROM: return position >= value;
        default: return tracker->module[952 + (position & 0x7f)] == value;
    }
}

// After an edit the pass stays valid up to the beat in which the routine first reaches what changed (a position, any
// position from one on, or a pattern). A beat playing past that point keeps its measure.
static void cut_pass(Tracker *tracker, int kind, int value) {
    uint32_t tick = 0;
    while (tick < tracker->tick_count && !reaches(tracker, tracker->tick_pos[tick], kind, value)) {tick++;}
    if (tick == tracker->tick_count) {return;}
    const double *times = tracker->times;
    uint32_t cut = tick;
    while (cut > 0 && !is_beat(times[cut])) {cut--;}
    if (tracker->next_tick >= cut && tracker->next_tick < tracker->tick_count) {
        uint32_t start = (uint32_t) tracker->next_tick;
        while (start > cut && !is_beat(times[start])) {start--;}
        uint32_t end = start + 1;
        while (end < tracker->tick_count && !is_beat(times[end])) {end++;}
        tracker->beat_start = times[start];
        tracker->beat_start_tick = start;
        tracker->beat_ticks = end - start;
    }
    tracker->tick_count = cut;
    if (tracker->snapshot_count > cut / SNAPSHOT_TICKS + 1) {tracker->snapshot_count = cut / SNAPSHOT_TICKS + 1;}
    tracker->pass_ended = 0;
    ust_log_truncate(cut, 0);
}

// The machine as it is at `beats`: every tick before it fired, Paula moved on to it.
static void seek(Tracker *tracker, double beats, double bpm) {
    if (!tracker->pass_ended && beats - 1.0e-9 > tracker->times[tracker->tick_count]) {
        resume_pass(tracker);
        extend_pass(tracker, beats);
    }
    const double *times = tracker->times;
    const uint32_t last = tracker->tick_count;
    const double clocks = ust_paula_clocks_per_beat(bpm);
    const double target = beats - 1.0e-9;
    if (target > times[last]) {
        // past the snapshot pass: replay tick by tick from the last snapshot, Paula moved on by each tick's length
        const uint32_t index = tracker->snapshot_count - 1;
        ust_snapshot_load(tracker->snapshots + (size_t) index * tracker->snapshot_size);
        tracker->next_tick = (int64_t) index * SNAPSHOT_TICKS;
        schedule(tracker);
        while (tracker->next_beat < target) {
            const double from = tracker->next_beat;
            ust_skip_ticks(1, 0.0, 1.0);
            tracker->next_tick++;
            schedule(tracker);
            ust_paula_advance(clocks * (fmin(tracker->next_beat, beats) - from));
        }
        return;
    }
    uint32_t low = 0, high = last;
    while (low < high) {
        const uint32_t middle = (low + high) / 2;
        if (times[middle] < target) {low = middle + 1;} else {high = middle;}
    }
    const uint32_t count = low;
    uint32_t index = count / SNAPSHOT_TICKS;
    if (index >= tracker->snapshot_count) {index = tracker->snapshot_count - 1;}
    ust_snapshot_load(tracker->snapshots + (size_t) index * tracker->snapshot_size);
    const int64_t replay = (int64_t) count - (int64_t) index * SNAPSHOT_TICKS;
    const double rest = count == 0 ? 0.0
        : fmin(1.0, fmax(0.0, (beats - times[count - 1]) / (times[count] - times[count - 1])));
    if (replay > 0) {ust_skip_ticks((int) replay, 0.0, 1.0);}
    if (count > 0 && count <= ust_log_ticks()) {ust_paula_rebuild(count, clocks, rest, times);}
    tracker->next_tick = count;
    schedule(tracker);
}

// Frames from the block start until the position has moved on by `delta` beats, tempo ramping by `tempo_inc` per frame.
static double frames_until(double delta, double tempo, double tempo_inc, double sample_rate) {
    const double target = delta * 60.0 * sample_rate;
    if (fabs(tempo_inc) < 1.0e-12) {return target / tempo;}
    const double discriminant = tempo * tempo + 2.0 * tempo_inc * target;
    return discriminant < 0.0 ? INFINITY : (-tempo + sqrt(discriminant)) / tempo_inc;
}

// equal power pan, the separation narrowing every pan towards the centre
static void apply_mix(Tracker *tracker, int ramp) {
    for (int c = 0; c < 4; c++) {
        const double pan = tracker->values[PARAM_PAN + c] * tracker->values[PARAM_SEPARATION];
        const double angle = (pan + 1.0) * M_PI * 0.25;
        const double gain = tracker->values[PARAM_MUTE + c] >= 0.5 ? 0.0 : tracker->values[PARAM_VOLUME + c];
        ust_set_mix(c, (float) (cos(angle) * gain), (float) (sin(angle) * gain), ramp);
    }
    ust_set_filter(tracker->values[PARAM_FILTER] >= 0.5);
    ust_set_declick(tracker->values[PARAM_DECLICK] >= 0.5);
    tracker->mix_dirty = 0;
}

static void handle_event(Tracker *tracker, const clap_event_header_t *header) {
    if (header->space_id != CLAP_CORE_EVENT_SPACE_ID || header->type != CLAP_EVENT_PARAM_VALUE) {return;}
    const clap_event_param_value_t *event = (const clap_event_param_value_t *) header;
    if (event->param_id >= PARAM_COUNT) {return;}
    const Param *param = &Params[event->param_id];
    tracker->values[event->param_id] = fmin(param->max, fmax(param->min, event->value));
    tracker->mix_dirty = 1;
}

// M!K! modules hold up to 100 patterns, all others 64
static int pattern_slots(const uint8_t *module) {return memcmp(module + 1080, "M!K!", 4) == 0 ? 100 : 64;}

// ProTracker counts every one of the 128 table entries, also those past the song length
static int pattern_count(const uint8_t *table) {
    int count = 0;
    for (int index = 0; index < 128; index++) {if (table[index] + 1 > count) {count = table[index] + 1;}}
    return count;
}

// the module into the machine with room for every pattern, playing from its start, the next block seeks to the transport
static int start_module(Tracker *tracker) {
    tracker->playing = 0;
    tracker->edit_read = tracker->edit_write;
    return ust_load_module_slots(tracker->module, tracker->module_len, (uint32_t) pattern_slots(tracker->module)) == 0
        && ust_play() == 0 && build_snapshots(tracker);
}

// takes ownership of `module`, keeps the previous one if the new one does not start
static bool swap_module(Tracker *tracker, uint8_t *module, uint32_t module_len) {
    uint8_t *previous = tracker->module;
    const uint32_t previous_len = tracker->module_len;
    tracker->module = module;
    tracker->module_len = module_len;
    if (tracker->ready && !start_module(tracker)) {
        tracker->module = previous;
        tracker->module_len = previous_len;
        free(module);
        start_module(tracker);
        return false;
    }
    free(previous);
    tracker->module_serial++;
    return true;
}

// An edit of the song's position list from the page: the module the state saves changes now, the machine at the next
// block start. `pattern` < 0 inserts a new empty pattern at `position`. A pattern no position plays anymore is kept by a
// free entry past the song, so nothing is lost.
static bool edit_table(Tracker *tracker, int position, int pattern) {
    if (tracker->edit_write - tracker->edit_read >= MACHINE_EDITS) {return false;}
    const uint8_t *file = tracker->module;
    const int length = file[950];
    const int slots = pattern_slots(file);
    uint8_t table[128];
    memcpy(table, file + 952, 128);
    const int before = pattern_count(table);
    const int insert = pattern < 0;
    int new_length = length;
    if (insert) {
        if (position < 0 || position > length || length >= 128 || before >= slots) {return false;}
        memmove(table + position + 1, table + position, (size_t) (127 - position));
        table[position] = (uint8_t) before;
        new_length++;
    } else {
        if (position < 0 || position >= length || pattern >= slots) {return false;}
        table[position] = (uint8_t) pattern;
    }
    const int needed = pattern_count(table);
    const int keep = needed > before ? needed : before;
    if (needed < keep) {
        if (new_length >= 128) {return false;}
        table[new_length] = (uint8_t) (keep - 1);
    }
    uint8_t *edited = tracker->module;
    if (keep > before) {
        const uint32_t samples_at = tracker->module_len < 1084u + before * 1024u ? tracker->module_len : 1084u + before * 1024u;
        const uint32_t len = 1084u + keep * 1024u + (tracker->module_len - samples_at);
        if (len > MODULE_MAX_BYTES) {return false;}
        edited = (uint8_t *) calloc(len, 1);
        if (edited == NULL) {return false;}
        memcpy(edited, file, samples_at);
        memcpy(edited + 1084 + keep * 1024, file + samples_at, tracker->module_len - samples_at);
        free(tracker->module);
        tracker->module = edited;
        tracker->module_len = len;
    }
    edited[950] = (uint8_t) new_length;
    memcpy(edited + 952, table, 128);
    MachineEdit *edit = &tracker->machine_edits[tracker->edit_write % MACHINE_EDITS];
    edit->offset = 950;
    edit->length = TABLE_BYTES;
    memcpy(edit->bytes, edited + 950, TABLE_BYTES);
    edit->cut = insert ? CUT_POSITIONS_FROM : CUT_POSITION;
    edit->value = insert && position == length ? length - 1 : position;
    tracker->edit_write++;
    tracker->module_serial++;
    if (tracker->host_state != NULL) {tracker->host_state->mark_dirty(tracker->host);}
    return true;
}

// A step of a pattern from the page: note, sample and effect as the module stores them, four bytes.
static bool edit_cell(Tracker *tracker, int pattern, int row, int channel, const uint8_t *cell) {
    if (tracker->edit_write - tracker->edit_read >= MACHINE_EDITS) {return false;}
    const uint32_t offset = 1084u + (uint32_t) pattern * 1024u + (uint32_t) row * 16u + (uint32_t) channel * 4u;
    const int sample = (cell[0] & 0xf0) | (cell[2] >> 4);
    if (pattern >= pattern_count(tracker->module + 952) || row >= 64 || channel >= 4 || sample > 31
        || offset + 4 > tracker->module_len) {return false;}
    if (memcmp(tracker->module + offset, cell, 4) == 0) {return true;}
    memcpy(tracker->module + offset, cell, 4);
    MachineEdit *edit = &tracker->machine_edits[tracker->edit_write % MACHINE_EDITS];
    edit->offset = offset;
    edit->length = 4;
    memcpy(edit->bytes, cell, 4);
    edit->cut = CUT_PATTERN;
    edit->value = pattern;
    tracker->edit_write++;
    tracker->module_serial++;
    if (tracker->host_state != NULL) {tracker->host_state->mark_dirty(tracker->host);}
    return true;
}

static void push_out_event(Tracker *tracker, uint16_t type, clap_id id, double value) {
    if (tracker->out_write - tracker->out_read >= OUT_EVENTS) {return;}
    tracker->out_events[tracker->out_write % OUT_EVENTS] = (OutEvent) {type, id, value};
    tracker->out_write++;
}

static void drain_out_events(Tracker *tracker, const clap_output_events_t *out) {
    while (tracker->out_read != tracker->out_write) {
        const OutEvent *event = &tracker->out_events[tracker->out_read % OUT_EVENTS];
        if (event->type == CLAP_EVENT_PARAM_VALUE) {
            const clap_event_param_value_t value = {
                .header = {sizeof(value), 0, CLAP_CORE_EVENT_SPACE_ID, CLAP_EVENT_PARAM_VALUE, 0},
                .param_id = event->id, .cookie = NULL, .note_id = -1, .port_index = -1, .channel = -1, .key = -1,
                .value = event->value
            };
            out->try_push(out, &value.header);
        } else {
            const clap_event_param_gesture_t gesture = {
                .header = {sizeof(gesture), 0, CLAP_CORE_EVENT_SPACE_ID, event->type, 0}, .param_id = event->id
            };
            out->try_push(out, &gesture.header);
        }
        tracker->out_read++;
    }
}

static void capture_display(Tracker *tracker, int playing) {
    Display *display = &tracker->display;
    display->playing = (uint8_t) playing;
    display->pos = (uint8_t) ust_song_pos();
    display->pattern = (uint8_t) ust_pattern();
    display->row = (uint8_t) ust_row();
    display->speed = (uint8_t) ust_tick_speed();
    display->song_len = (uint8_t) ust_song_len();
    for (int c = 0; c < 4; c++) {
        display->period[c] = (uint16_t) ust_chan_period(c);
        display->volume[c] = (uint8_t) (playing ? ust_chan_volume(c) : 0);
        display->dma[c] = (uint8_t) (playing && ust_chan_dma(c));
        const float peak = ust_chan_peak(c);
        if (peak > display->peak[c]) {display->peak[c] = peak;}
    }
}

static bool tracker_activate(const clap_plugin_t *plugin, double sample_rate, uint32_t min_frames, uint32_t max_frames) {
    (void) min_frames;
    (void) max_frames;
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    tracker->sample_rate = sample_rate;
    tracker->playing = 0;
    ust_init(sample_rate);
    apply_mix(tracker, 0);
    ust_set_external_clock(1);
    tracker->ready = ust_load_program(ptplay, ptplay_len) == 0 && start_module(tracker);
    return tracker->ready;
}

static void tracker_deactivate(const clap_plugin_t *plugin) {((Tracker *) plugin->plugin_data)->ready = 0;}

static bool tracker_start_processing(const clap_plugin_t *plugin) {(void) plugin; return true;}

static void tracker_stop_processing(const clap_plugin_t *plugin) {(void) plugin;}

static void tracker_reset(const clap_plugin_t *plugin) {((Tracker *) plugin->plugin_data)->playing = 0;}

static clap_process_status tracker_process(const clap_plugin_t *plugin, const clap_process_t *process) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    if (process->audio_outputs_count < 1 || process->audio_outputs[0].channel_count < 2) {return CLAP_PROCESS_ERROR;}
    float *left = process->audio_outputs[0].data32[0];
    float *right = process->audio_outputs[0].data32[1];
    const uint32_t frames = process->frames_count;
    const uint32_t count = process->in_events->size(process->in_events);
    for (uint32_t index = 0; index < count; index++) {handle_event(tracker, process->in_events->get(process->in_events, index));}
    drain_out_events(tracker, process->out_events);
    if (tracker->mix_dirty) {apply_mix(tracker, (int) frames);}
    if (tracker->pending_ready) {
        uint8_t *module = tracker->pending_module;
        const uint32_t module_len = tracker->pending_len;
        tracker->pending_module = NULL;
        tracker->pending_ready = 0;
        if (tracker->ready) {swap_module(tracker, module, module_len);} else {free(module);}
    }
    while (tracker->edit_read != tracker->edit_write) {
        const MachineEdit *edit = &tracker->machine_edits[tracker->edit_read % MACHINE_EDITS];
        if (tracker->ready) {
            for (uint32_t index = 0; index < edit->length; index++) {ust_module_poke(edit->offset + index, edit->bytes[index]);}
            cut_pass(tracker, edit->cut, edit->value);
        }
        tracker->edit_read++;
    }
    const clap_event_transport_t *transport = process->transport;
    const int playing = tracker->ready && transport != NULL && (transport->flags & CLAP_TRANSPORT_IS_PLAYING) != 0
        && (transport->flags & CLAP_TRANSPORT_HAS_BEATS_TIMELINE) != 0;
    if (tracker->ready) {capture_display(tracker, playing);}
    if (!playing) {
        tracker->playing = 0;
        memset(left, 0, frames * sizeof(float));
        memset(right, 0, frames * sizeof(float));
        return CLAP_PROCESS_CONTINUE;
    }
    const int has_tempo = (transport->flags & CLAP_TRANSPORT_HAS_TEMPO) != 0 && transport->tempo > 0.0;
    const double tempo = has_tempo ? transport->tempo : NOMINAL_BPM;
    const double tempo_inc = has_tempo ? transport->tempo_inc : 0.0;
    const double start = (double) transport->song_pos_beats / (double) CLAP_BEATTIME_FACTOR;
    if (!tracker->playing || fabs(start - tracker->expected_beats) > JUMP_TOLERANCE_BEATS) {seek(tracker, start, tempo);}
    tracker->playing = 1;
    uint32_t frame = 0;
    while (frame < frames) {
        const double at = frames_until(tracker->next_beat - start, tempo, tempo_inc, tracker->sample_rate);
        if (at <= (double) frame) {
            ust_tick();
            tracker->next_tick++;
            schedule(tracker);
            continue;
        }
        const uint32_t until = at >= (double) frames ? frames : (uint32_t) ceil(at);
        ust_render((int) (until - frame));
        memcpy(left + frame, ust_out_l(), (until - frame) * sizeof(float));
        memcpy(right + frame, ust_out_r(), (until - frame) * sizeof(float));
        frame = until;
    }
    tracker->expected_beats = start + (tempo * frames + tempo_inc * frames * frames * 0.5) / (60.0 * tracker->sample_rate);
    return CLAP_PROCESS_CONTINUE;
}

static uint32_t audio_ports_count(const clap_plugin_t *plugin, bool is_input) {(void) plugin; return is_input ? 0 : 1;}

static bool audio_ports_get(const clap_plugin_t *plugin, uint32_t index, bool is_input, clap_audio_port_info_t *info) {
    (void) plugin;
    if (is_input || index > 0) {return false;}
    info->id = 0;
    strcpy(info->name, "Output");
    info->flags = CLAP_AUDIO_PORT_IS_MAIN;
    info->channel_count = 2;
    info->port_type = CLAP_PORT_STEREO;
    info->in_place_pair = CLAP_INVALID_ID;
    return true;
}

static const clap_plugin_audio_ports_t audio_ports = {.count = audio_ports_count, .get = audio_ports_get};

static uint32_t params_count(const clap_plugin_t *plugin) {(void) plugin; return PARAM_COUNT;}

static bool params_get_info(const clap_plugin_t *plugin, uint32_t index, clap_param_info_t *info) {
    (void) plugin;
    if (index >= PARAM_COUNT) {return false;}
    const Param *param = &Params[index];
    memset(info, 0, sizeof(*info));
    info->id = index;
    info->flags = param->flags;
    snprintf(info->name, sizeof(info->name), "%s", param->name);
    snprintf(info->module, sizeof(info->module), "%s", param->module);
    info->min_value = param->min;
    info->max_value = param->max;
    info->default_value = param->value;
    return true;
}

static bool params_get_value(const clap_plugin_t *plugin, clap_id id, double *value) {
    if (id >= PARAM_COUNT) {return false;}
    *value = ((Tracker *) plugin->plugin_data)->values[id];
    return true;
}

static bool params_value_to_text(const clap_plugin_t *plugin, clap_id id, double value, char *text, uint32_t size) {
    (void) plugin;
    if (id >= PARAM_COUNT) {return false;}
    if (Params[id].flags & CLAP_PARAM_IS_STEPPED) {
        snprintf(text, size, "%s", value >= 0.5 ? "On" : "Off");
    } else if (id < PARAM_VOLUME) {
        const int percent = (int) lround(value * 100.0);
        if (percent == 0) {snprintf(text, size, "C");} else {snprintf(text, size, "%c%d", percent < 0 ? 'L' : 'R', abs(percent));}
    } else {
        snprintf(text, size, "%d%%", (int) lround(value * 100.0));
    }
    return true;
}

static bool params_text_to_value(const clap_plugin_t *plugin, clap_id id, const char *text, double *value) {
    (void) plugin;
    if (id >= PARAM_COUNT) {return false;}
    const Param *param = &Params[id];
    if (param->flags & CLAP_PARAM_IS_STEPPED) {
        *value = strcmp(text, "On") == 0 || atof(text) >= 0.5 ? 1.0 : 0.0;
    } else if (id < PARAM_VOLUME) {
        const double amount = text[0] == 'L' || text[0] == 'R' ? atof(text + 1) / 100.0 : text[0] == 'C' ? 0.0 : atof(text) / 100.0;
        *value = text[0] == 'L' ? -amount : amount;
    } else {
        *value = atof(text) / 100.0;
    }
    *value = fmin(param->max, fmax(param->min, *value));
    return true;
}

static void params_flush(const clap_plugin_t *plugin, const clap_input_events_t *in, const clap_output_events_t *out) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    drain_out_events(tracker, out);
    const uint32_t count = in->size(in);
    for (uint32_t index = 0; index < count; index++) {handle_event(tracker, in->get(in, index));}
    if (tracker->mix_dirty && tracker->ready) {apply_mix(tracker, 0);}
}

static const clap_plugin_params_t params = {
    .count = params_count,
    .get_info = params_get_info,
    .get_value = params_get_value,
    .value_to_text = params_value_to_text,
    .text_to_value = params_text_to_value,
    .flush = params_flush
};

// state: magic, version, param count, the params as doubles, module length, module bytes, all little endian
static bool write_all(const clap_ostream_t *stream, const void *data, uint64_t size) {
    const uint8_t *bytes = (const uint8_t *) data;
    while (size > 0) {
        const int64_t written = stream->write(stream, bytes, size);
        if (written <= 0) {return false;}
        bytes += written;
        size -= (uint64_t) written;
    }
    return true;
}

static bool state_save(const clap_plugin_t *plugin, const clap_ostream_t *stream) {
    const Tracker *tracker = (const Tracker *) plugin->plugin_data;
    const uint32_t header[3] = {STATE_MAGIC, STATE_VERSION, PARAM_COUNT};
    return write_all(stream, header, sizeof(header)) && write_all(stream, tracker->values, sizeof(tracker->values))
        && write_all(stream, &tracker->module_len, sizeof(tracker->module_len))
        && write_all(stream, tracker->module, tracker->module_len);
}

static bool state_load(const clap_plugin_t *plugin, const clap_istream_t *stream) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    uint32_t size = 0, capacity = 1 << 16;
    uint8_t *data = (uint8_t *) malloc(capacity);
    if (data == NULL) {return false;}
    for (;;) {
        if (size == capacity) {
            if (capacity >= STATE_MAX_BYTES) {free(data); return false;}
            uint8_t *grown = (uint8_t *) realloc(data, capacity * 2);
            if (grown == NULL) {free(data); return false;}
            data = grown;
            capacity *= 2;
        }
        const int64_t read = stream->read(stream, data + size, capacity - size);
        if (read < 0) {free(data); return false;}
        if (read == 0) {break;}
        size += (uint32_t) read;
    }
    uint32_t header[3];
    const uint32_t params_end = sizeof(header) + PARAM_COUNT * sizeof(double);
    uint32_t module_len = 0;
    if (size >= sizeof(header)) {memcpy(header, data, sizeof(header));}
    const bool valid = size >= params_end + sizeof(uint32_t) && header[0] == STATE_MAGIC && header[1] == STATE_VERSION
        && header[2] == PARAM_COUNT;
    if (valid) {memcpy(&module_len, data + params_end, sizeof(module_len));}
    if (!valid || module_len < 1084 || size - params_end - sizeof(uint32_t) < module_len) {free(data); return false;}
    uint8_t *module = (uint8_t *) malloc(module_len);
    if (module == NULL) {free(data); return false;}
    memcpy(module, data + params_end + sizeof(uint32_t), module_len);
    double values[PARAM_COUNT];
    memcpy(values, data + sizeof(header), sizeof(values));
    free(data);
    for (int index = 0; index < PARAM_COUNT; index++) {
        tracker->values[index] = fmin(Params[index].max, fmax(Params[index].min, values[index]));
    }
    tracker->mix_dirty = 1;
    return swap_module(tracker, module, module_len);
}

static const clap_plugin_state_t state = {.save = state_save, .load = state_load};

// webview: the page is index.html of the bundle, served by the host
static int32_t webview_get_uri(const clap_plugin_t *plugin, char *uri, uint32_t capacity) {
    (void) plugin;
    static const char page[] = "/index.html";
    if (capacity > 0 && uri != NULL) {snprintf(uri, capacity, "%s", page);}
    return (int32_t) sizeof(page);
}

static bool webview_get_resource(const clap_plugin_t *plugin, const char *path, char *mime, uint32_t capacity,
                                 const clap_ostream_t *stream) {
    (void) plugin; (void) path; (void) mime; (void) capacity; (void) stream;
    return false;
}

static void put_u32(uint8_t *target, uint32_t value) {memcpy(target, &value, 4);}

// the peaks since the last status, the page polls once per frame
static void send_status(Tracker *tracker) {
    uint8_t message[STATUS_BYTES];
    const Display *display = &tracker->display;
    memset(message, 0, sizeof(message));
    message[0] = PLUGIN_STATUS;
    message[1] = display->playing;
    message[2] = display->pos;
    message[3] = display->pattern;
    message[4] = display->row;
    message[5] = display->speed;
    message[6] = display->song_len;
    put_u32(message + 8, tracker->module_serial);
    for (int c = 0; c < 4; c++) {
        memcpy(message + 12 + c * 4, &display->period[c], 2);
        message[12 + c * 4 + 2] = display->volume[c];
        message[12 + c * 4 + 3] = display->dma[c];
    }
    for (int c = 0; c < 4; c++) {
        message[28 + c] = (uint8_t) lroundf(fminf(1.0f, tracker->display.peak[c]) * 255.0f);
        tracker->display.peak[c] = 0.0f;
    }
    memcpy(message + 32, tracker->values, PARAM_COUNT * 8);
    tracker->host_webview->send(tracker->host, message, sizeof(message));
}

static void send_module(Tracker *tracker) {
    uint8_t *message = (uint8_t *) malloc(8 + tracker->module_len);
    if (message == NULL) {return;}
    memset(message, 0, 8);
    message[0] = PLUGIN_MODULE;
    put_u32(message + 4, tracker->module_serial);
    memcpy(message + 8, tracker->module, tracker->module_len);
    tracker->host_webview->send(tracker->host, message, 8 + tracker->module_len);
    free(message);
}

static void page_param(Tracker *tracker, uint16_t type, const uint8_t *bytes, uint32_t size) {
    clap_id id;
    if (size < 8) {return;}
    memcpy(&id, bytes + 4, 4);
    if (id >= PARAM_COUNT) {return;}
    double value = tracker->values[id];
    if (type == CLAP_EVENT_PARAM_VALUE) {
        if (size < 16) {return;}
        memcpy(&value, bytes + 8, 8);
        value = fmin(Params[id].max, fmax(Params[id].min, value));
        tracker->values[id] = value;
        tracker->mix_dirty = 1;
    }
    push_out_event(tracker, type, id, value);
    if (tracker->host_params != NULL) {tracker->host_params->request_flush(tracker->host);}
}

static bool webview_receive(const clap_plugin_t *plugin, const void *buffer, uint32_t size) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    const uint8_t *bytes = (const uint8_t *) buffer;
    if (size < 1 || tracker->host_webview == NULL) {return false;}
    switch (bytes[0]) {
        case PAGE_POLL:
            send_status(tracker);
            return true;
        case PAGE_MODULE_REQUEST:
            send_module(tracker);
            return true;
        case PAGE_LOAD: {
            const uint32_t module_len = size - 4;
            if (size < 4 + 1084 || module_len > MODULE_MAX_BYTES || tracker->pending_ready) {return false;}
            uint8_t *module = (uint8_t *) malloc(module_len);
            if (module == NULL) {return false;}
            memcpy(module, bytes + 4, module_len);
            tracker->pending_module = module;
            tracker->pending_len = module_len;
            tracker->pending_ready = 1;
            if (tracker->host_state != NULL) {tracker->host_state->mark_dirty(tracker->host);}
            return true;
        }
        case PAGE_SET_PATTERN:
            return size >= 3 && edit_table(tracker, bytes[1], bytes[2]);
        case PAGE_INSERT_PATTERN:
            return size >= 2 && edit_table(tracker, bytes[1], -1);
        case PAGE_SET_CELL:
            return size >= 8 && edit_cell(tracker, bytes[1], bytes[2], bytes[3], bytes + 4);
        case PAGE_PARAM_BEGIN:
            page_param(tracker, CLAP_EVENT_PARAM_GESTURE_BEGIN, bytes, size);
            return true;
        case PAGE_PARAM_SET:
            page_param(tracker, CLAP_EVENT_PARAM_VALUE, bytes, size);
            return true;
        case PAGE_PARAM_END:
            page_param(tracker, CLAP_EVENT_PARAM_GESTURE_END, bytes, size);
            return true;
        default:
            return false;
    }
}

static const clap_plugin_webview_t webview = {
    .get_uri = webview_get_uri, .get_resource = webview_get_resource, .receive = webview_receive
};

// gui: only the webview api, the host owns the window, sizes are logical pixels
static bool gui_is_api_supported(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    (void) plugin; (void) is_floating;
    return strcmp(api, CLAP_WINDOW_API_WEBVIEW) == 0;
}

static bool gui_get_preferred_api(const clap_plugin_t *plugin, const char **api, bool *is_floating) {
    (void) plugin;
    *api = CLAP_WINDOW_API_WEBVIEW;
    *is_floating = false;
    return true;
}

static bool gui_create(const clap_plugin_t *plugin, const char *api, bool is_floating) {
    return gui_is_api_supported(plugin, api, is_floating);
}

static void gui_destroy(const clap_plugin_t *plugin) {(void) plugin;}

static bool gui_set_scale(const clap_plugin_t *plugin, double scale) {(void) plugin; (void) scale; return false;}

static bool gui_get_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    const Tracker *tracker = (const Tracker *) plugin->plugin_data;
    *width = tracker->gui_width;
    *height = tracker->gui_height;
    return true;
}

static bool gui_can_resize(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_get_resize_hints(const clap_plugin_t *plugin, clap_gui_resize_hints_t *hints) {
    (void) plugin;
    hints->can_resize_horizontally = true;
    hints->can_resize_vertically = true;
    hints->preserve_aspect_ratio = false;
    hints->aspect_ratio_width = 0;
    hints->aspect_ratio_height = 0;
    return true;
}

static bool gui_adjust_size(const clap_plugin_t *plugin, uint32_t *width, uint32_t *height) {
    (void) plugin;
    if (*width < GUI_MIN_WIDTH) {*width = GUI_MIN_WIDTH;}
    if (*height < GUI_MIN_HEIGHT) {*height = GUI_MIN_HEIGHT;}
    return true;
}

static bool gui_set_size(const clap_plugin_t *plugin, uint32_t width, uint32_t height) {
    Tracker *tracker = (Tracker *) plugin->plugin_data;
    gui_adjust_size(plugin, &width, &height);
    tracker->gui_width = width;
    tracker->gui_height = height;
    return true;
}

static bool gui_set_parent(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return true;}

static bool gui_set_transient(const clap_plugin_t *plugin, const clap_window_t *window) {(void) plugin; (void) window; return false;}

static void gui_suggest_title(const clap_plugin_t *plugin, const char *title) {(void) plugin; (void) title;}

static bool gui_show(const clap_plugin_t *plugin) {(void) plugin; return true;}

static bool gui_hide(const clap_plugin_t *plugin) {(void) plugin; return true;}

static const clap_plugin_gui_t gui = {
    .is_api_supported = gui_is_api_supported, .get_preferred_api = gui_get_preferred_api, .create = gui_create,
    .destroy = gui_destroy, .set_scale = gui_set_scale, .get_size = gui_get_size, .can_resize = gui_can_resize,
    .get_resize_hints = gui_get_resize_hints, .adjust_size = gui_adjust_size, .set_size = gui_set_size,
    .set_parent = gui_set_parent, .set_transient = gui_set_transient, .suggest_title = gui_suggest_title,
    .show = gui_show, .hide = gui_hide
};

static const void *tracker_get_extension(const clap_plugin_t *plugin, const char *id) {
    (void) plugin;
    if (strcmp(id, CLAP_EXT_STATE) == 0) {return &state;}
    if (strcmp(id, CLAP_EXT_WEBVIEW) == 0) {return &webview;}
    if (strcmp(id, CLAP_EXT_GUI) == 0) {return &gui;}
    if (strcmp(id, CLAP_EXT_PARAMS) == 0) {return &params;}
    if (strcmp(id, CLAP_EXT_AUDIO_PORTS) == 0) {return &audio_ports;}
    return NULL;
}

static void tracker_on_main_thread(const clap_plugin_t *plugin) {(void) plugin;}

static const clap_plugin_t *create(const clap_plugin_factory_t *factory, const clap_host_t *host, const char *plugin_id) {
    (void) factory;
    if (strcmp(plugin_id, descriptor.id) != 0 || instances > 0) {return NULL;}
    Tracker *tracker = (Tracker *) calloc(1, sizeof(Tracker));
    if (tracker == NULL) {return NULL;}
    instances++;
    tracker->host = host;
    tracker->sample_rate = 48000.0;
    tracker->gui_width = GUI_WIDTH;
    tracker->gui_height = GUI_HEIGHT;
    for (int index = 0; index < PARAM_COUNT; index++) {tracker->values[index] = Params[index].value;}
    tracker->module = (uint8_t *) malloc(default_mod_len);
    if (tracker->module == NULL) {
        instances--;
        free(tracker);
        return NULL;
    }
    memcpy(tracker->module, default_mod, default_mod_len);
    tracker->module_len = default_mod_len;
    tracker->plugin.desc = &descriptor;
    tracker->plugin.plugin_data = tracker;
    tracker->plugin.init = tracker_init;
    tracker->plugin.destroy = tracker_destroy;
    tracker->plugin.activate = tracker_activate;
    tracker->plugin.deactivate = tracker_deactivate;
    tracker->plugin.start_processing = tracker_start_processing;
    tracker->plugin.stop_processing = tracker_stop_processing;
    tracker->plugin.reset = tracker_reset;
    tracker->plugin.process = tracker_process;
    tracker->plugin.get_extension = tracker_get_extension;
    tracker->plugin.on_main_thread = tracker_on_main_thread;
    return &tracker->plugin;
}

static uint32_t plugin_count(const clap_plugin_factory_t *factory) {(void) factory; return 1;}

static const clap_plugin_descriptor_t *plugin_descriptor(const clap_plugin_factory_t *factory, uint32_t index) {
    (void) factory;
    return index == 0 ? &descriptor : NULL;
}

static const clap_plugin_factory_t factory = {
    .get_plugin_count = plugin_count,
    .get_plugin_descriptor = plugin_descriptor,
    .create_plugin = create
};

static bool entry_init(const char *path) {(void) path; return true;}

static void entry_deinit(void) {}

static const void *entry_get_factory(const char *id) {
    return strcmp(id, CLAP_PLUGIN_FACTORY_ID) == 0 ? &factory : NULL;
}

CLAP_EXPORT const clap_plugin_entry_t clap_entry = {
    .clap_version = CLAP_VERSION_INIT,
    .init = entry_init,
    .deinit = entry_deinit,
    .get_factory = entry_get_factory
};
