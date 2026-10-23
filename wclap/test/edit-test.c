// Native test of position list edits: an edit applied while the plugin plays, or before a jump, must sound bit identical
// to a plugin that loaded the edited module from the start. Build and run with wclap/test/run.sh.

#include <clap/clap.h>
#include <clap/ext/draft/webview.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

extern const clap_plugin_entry_t clap_entry;

#define RATE 48000.0
#define BLOCK 128
#define BPM 125.0

static uint8_t *received = NULL;
static uint32_t received_len = 0;
static int failures = 0;

static bool host_send(const clap_host_t *host, const void *buffer, uint32_t size) {
    (void) host;
    if (size > 8 && ((const uint8_t *) buffer)[0] == 2) {
        free(received);
        received = malloc(size - 8);
        memcpy(received, (const uint8_t *) buffer + 8, size - 8);
        received_len = size - 8;
    }
    return true;
}

static void mark_dirty(const clap_host_t *host) {(void) host;}

static const clap_host_webview_t host_webview = {.send = host_send};
static const clap_host_state_t host_state = {.mark_dirty = mark_dirty};

static const void *host_get_extension(const clap_host_t *host, const char *id) {
    (void) host;
    if (strcmp(id, CLAP_EXT_WEBVIEW) == 0) {return &host_webview;}
    if (strcmp(id, CLAP_EXT_STATE) == 0) {return &host_state;}
    return NULL;
}

static void host_noop(const clap_host_t *host) {(void) host;}

static const clap_host_t host = {
    .clap_version = CLAP_VERSION_INIT, .name = "edit-test", .vendor = "", .url = "", .version = "1",
    .get_extension = host_get_extension, .request_restart = host_noop, .request_process = host_noop,
    .request_callback = host_noop
};

static uint32_t events_size(const clap_input_events_t *list) {(void) list; return 0;}
static const clap_event_header_t *events_get(const clap_input_events_t *list, uint32_t index) {(void) list; (void) index; return NULL;}
static bool events_push(const clap_output_events_t *list, const clap_event_header_t *event) {(void) list; (void) event; return true;}
static const clap_input_events_t in_events = {.ctx = NULL, .size = events_size, .get = events_get};
static const clap_output_events_t out_events = {.ctx = NULL, .try_push = events_push};

typedef struct {const clap_plugin_t *plugin; const clap_plugin_webview_t *webview; double beats;} Plugin;

static uint8_t *slurp(const char *path, uint32_t *len) {
    FILE *file = fopen(path, "rb");
    if (file == NULL) {perror(path); exit(1);}
    fseek(file, 0, SEEK_END);
    const long size = ftell(file);
    fseek(file, 0, SEEK_SET);
    uint8_t *bytes = malloc((size_t) size);
    if (fread(bytes, 1, (size_t) size, file) != (size_t) size) {exit(1);}
    fclose(file);
    *len = (uint32_t) size;
    return bytes;
}

static double process(Plugin *p, int playing, float *left, float *right) {
    static float scratch[2][BLOCK];
    float *channels[2] = {left != NULL ? left : scratch[0], right != NULL ? right : scratch[1]};
    clap_audio_buffer_t output = {.data32 = channels, .data64 = NULL, .channel_count = 2, .latency = 0, .constant_mask = 0};
    clap_event_transport_t transport;
    memset(&transport, 0, sizeof(transport));
    transport.flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_BEATS_TIMELINE | (playing ? CLAP_TRANSPORT_IS_PLAYING : 0);
    transport.song_pos_beats = (clap_beattime) llround(p->beats * (double) CLAP_BEATTIME_FACTOR);
    transport.tempo = BPM;
    const clap_process_t data = {
        .steady_time = -1, .frames_count = BLOCK, .transport = &transport, .audio_inputs = NULL, .audio_outputs = &output,
        .audio_inputs_count = 0, .audio_outputs_count = 1, .in_events = &in_events, .out_events = &out_events
    };
    struct timespec from, to;
    clock_gettime(CLOCK_MONOTONIC, &from);
    p->plugin->process(p->plugin, &data);
    clock_gettime(CLOCK_MONOTONIC, &to);
    if (playing) {p->beats += BPM * BLOCK / (60.0 * RATE);}
    return (to.tv_sec - from.tv_sec) * 1.0e6 + (to.tv_nsec - from.tv_nsec) / 1.0e3;
}

static Plugin open_plugin(const uint8_t *module, uint32_t len) {
    const clap_plugin_factory_t *factory = clap_entry.get_factory(CLAP_PLUGIN_FACTORY_ID);
    Plugin p = {factory->create_plugin(factory, &host, "studio.opendaw.protracker"), NULL, 0.0};
    if (p.plugin == NULL || !p.plugin->init(p.plugin) || !p.plugin->activate(p.plugin, RATE, 1, BLOCK)) {
        fprintf(stderr, "plugin did not start\n");
        exit(1);
    }
    p.webview = p.plugin->get_extension(p.plugin, CLAP_EXT_WEBVIEW);
    uint8_t *message = calloc(4 + len, 1);
    message[0] = 3;
    memcpy(message + 4, module, len);
    if (!p.webview->receive(p.plugin, message, 4 + len)) {fprintf(stderr, "load refused\n"); exit(1);}
    free(message);
    // the filters run on through a jump, a seek restores only the machine: off, so any history meets the same output
    uint8_t param[16] = {5};
    const uint32_t filter = 13;
    const double off = 0.0;
    memcpy(param + 4, &filter, 4);
    memcpy(param + 8, &off, 8);
    p.webview->receive(p.plugin, param, sizeof(param));
    process(&p, 0, NULL, NULL);
    return p;
}

static void close_plugin(Plugin *p) {p->plugin->destroy(p->plugin);}

static uint8_t *fetch_module(Plugin *p, uint32_t *len) {
    const uint8_t request = 2;
    p->webview->receive(p->plugin, &request, 1);
    *len = received_len;
    uint8_t *copy = malloc(received_len);
    memcpy(copy, received, received_len);
    return copy;
}

static int set_pattern(Plugin *p, int position, int pattern) {
    const uint8_t message[3] = {7, (uint8_t) position, (uint8_t) pattern};
    return p->webview->receive(p->plugin, message, 3);
}

static int insert_pattern(Plugin *p, int position) {
    const uint8_t message[2] = {8, (uint8_t) position};
    return p->webview->receive(p->plugin, message, 2);
}

// blocks of playback from the current beat into `out` (left then right per block)
static double render(Plugin *p, int blocks, float *out) {
    double worst = 0.0;
    for (int block = 0; block < blocks; block++) {
        const double micros = process(p, 1, out + block * 2 * BLOCK, out + block * 2 * BLOCK + BLOCK);
        if (micros > worst) {worst = micros;}
    }
    return worst;
}

static int blocks_for(double beats) {return (int) (beats * 60.0 * RATE / BPM / BLOCK);}

static void expect(int condition, const char *what) {
    printf("%s %s\n", condition ? "ok  " : "FAIL", what);
    if (!condition) {failures++;}
}

static int same(const float *a, const float *b, int blocks) {
    return memcmp(a, b, (size_t) blocks * 2 * BLOCK * sizeof(float)) == 0;
}

static void report(const float *a, const float *b, int blocks) {
    for (int index = 0; index < blocks * 2 * BLOCK; index++) {
        if (a[index] != b[index]) {
            printf("     first difference in block %d, %s sample %d: %g vs %g\n", index / (2 * BLOCK),
                   index % (2 * BLOCK) < BLOCK ? "left" : "right", index % BLOCK, a[index], b[index]);
            break;
        }
    }
    int count = 0, last = -1;
    double worst = 0.0;
    for (int index = 0; index < blocks * 2 * BLOCK; index++) {
        const double difference = fabs((double) a[index] - (double) b[index]);
        if (difference > 0.0) {count++; last = index;}
        if (difference > worst) {worst = difference;}
    }
    printf("     %d samples differ, the largest by %g, the last in block %d\n", count, worst, last / (2 * BLOCK));
}

static double energy(const float *a, int blocks) {
    double sum = 0.0;
    for (int index = 0; index < blocks * 2 * BLOCK; index++) {sum += a[index] * a[index];}
    return sum;
}

// A plays from 0, the edit lands at `edit_at` beats, then A jumps to `jump` (or plays on if jump < 0) and renders `blocks`.
// B loads the edited module and renders the same blocks from the same beat. Returns B's module.
typedef int (*Edit)(Plugin *);

static void compare(const char *name, const uint8_t *module, uint32_t len, Edit edit, double edit_at, double jump, double beats) {
    const int blocks = blocks_for(beats);
    float *a = calloc((size_t) blocks * 2 * BLOCK, sizeof(float));
    float *b = calloc((size_t) blocks * 2 * BLOCK, sizeof(float));
    Plugin pa = open_plugin(module, len);
    const int lead = blocks_for(edit_at);
    float *skip = calloc((size_t) (lead + 1) * 2 * BLOCK, sizeof(float));
    render(&pa, lead, skip);
    expect(edit(&pa), "the plugin takes the edit");
    const double apply = process(&pa, 1, skip, skip + BLOCK);
    if (jump >= 0.0) {pa.beats = jump;}
    const double start = pa.beats;
    struct timespec from, to;
    clock_gettime(CLOCK_MONOTONIC, &from);
    const double worst = render(&pa, blocks, a);
    clock_gettime(CLOCK_MONOTONIC, &to);
    uint32_t edited_len;
    uint8_t *edited = fetch_module(&pa, &edited_len);
    close_plugin(&pa);
    Plugin pb = open_plugin(edited, edited_len);
    // Paula's fractional clock runs on through a jump, so B plays as many frames before it as A did
    render(&pb, lead + 1, skip);
    pb.beats = start;
    render(&pb, blocks, b);
    close_plugin(&pb);
    char what[256];
    snprintf(what, sizeof(what), "%s: bit identical to the edited module loaded fresh (edit block %.0f us, worst block %.0f us)",
             name, apply, worst);
    expect(same(a, b, blocks) && energy(a, blocks) > 0.0, what);
    if (!same(a, b, blocks)) {report(a, b, blocks);}
    printf("     energy %g %g\n", energy(a, blocks), energy(b, blocks));
    (void) from; (void) to;
    free(a); free(b); free(skip); free(edited);
}

static int set_cell(Plugin *p, int pattern, int row, int channel, int period, int sample, int effect, int arg) {
    const uint8_t message[8] = {9, (uint8_t) pattern, (uint8_t) row, (uint8_t) channel,
        (uint8_t) ((sample & 0xf0) | (period >> 8)), (uint8_t) (period & 0xff), (uint8_t) (((sample & 0x0f) << 4) | effect),
        (uint8_t) arg};
    return p->webview->receive(p->plugin, message, sizeof(message));
}

// pattern 1 plays at positions 2, 3, 6 and 7, from beat 32
static int cell_note(Plugin *p) {return set_cell(p, 1, 0, 0, 428, 1, 0, 0);}
static int cell_speed(Plugin *p) {return set_cell(p, 1, 4, 1, 0, 0, 0xF, 3);}
static int cell_break(Plugin *p) {return set_cell(p, 1, 8, 2, 0, 0, 0xD, 0);}
static int cell_jump(Plugin *p) {return set_cell(p, 1, 12, 3, 0, 0, 0xB, 5);}
static int cell_late_row(Plugin *p) {return set_cell(p, 1, 48, 0, 0, 0, 0xF, 4);}

static void header_of(uint8_t *header, const char *name, int length, int finetune, int volume, int start, int repeat) {
    memset(header, 0, 30);
    strncpy((char *) header, name, 22);
    header[22] = (uint8_t) ((length / 2) >> 8); header[23] = (uint8_t) (length / 2);
    header[24] = (uint8_t) (finetune & 15);
    header[25] = (uint8_t) volume;
    header[26] = (uint8_t) ((start / 2) >> 8); header[27] = (uint8_t) (start / 2);
    header[28] = (uint8_t) ((repeat / 2) >> 8); header[29] = (uint8_t) (repeat / 2);
}

static int set_sample_header(Plugin *p, int slot, int finetune, int volume, int start, int repeat) {
    uint8_t message[34] = {10, (uint8_t) slot};
    header_of(message + 4, "edited", 0, finetune, volume, start, repeat);
    return p->webview->receive(p->plugin, message, sizeof(message));
}

static int set_sample(Plugin *p, int slot, int length, int start, int repeat) {
    uint8_t *message = calloc(34 + (size_t) length, 1);
    message[0] = 11;
    message[1] = (uint8_t) slot;
    header_of(message + 4, "sine", length, 0, 48, start, repeat);
    for (int index = 0; index < length; index++) {message[34 + index] = (uint8_t) (int8_t) lrint(100.0 * sin(index * 0.1));}
    const int taken = p->webview->receive(p->plugin, message, 34 + (uint32_t) length);
    free(message);
    return taken;
}

// sample 12 plays in patterns 3, 5 and 6 (first at beat 96), sample 9 in pattern 2 (beat 64), sample 5 everywhere
static int header_late(Plugin *p) {return set_sample_header(p, 11, -3, 60, 200, 1000);}
static int header_pattern_2(Plugin *p) {return set_sample_header(p, 8, 2, 20, 100, 2000);}
static int header_playing(Plugin *p) {return set_sample_header(p, 4, 0, 30, 0, 2);}
static int sample_replace(Plugin *p) {return set_sample(p, 1, 4000, 1000, 3000);}
static int sample_clear(Plugin *p) {return set_sample(p, 11, 0, 0, 2);}
static int sample_grow(Plugin *p) {return set_sample(p, 4, 20000, 0, 2);}

static int edit_none(Plugin *p) {return set_pattern(p, 1, 0);}
static int edit_set(Plugin *p) {return set_pattern(p, 1, 4);}
static int edit_set_new(Plugin *p) {return set_pattern(p, 3, 9);}
static int edit_insert(Plugin *p) {return insert_pattern(p, 1);}
static int edit_insert_end(Plugin *p) {return insert_pattern(p, 24);}
static int edit_both(Plugin *p) {return insert_pattern(p, 2) && set_pattern(p, 5, 0) && set_pattern(p, 2, 6);}

int main(int argc, char **argv) {
    if (argc < 2) {fprintf(stderr, "usage: edit-test module.mod\n"); return 1;}
    clap_entry.init("");
    uint32_t len;
    uint8_t *module = slurp(argv[1], &len);
    const int count = 8;
    if (getenv("PROBE") != NULL) {
        Plugin probe = open_plugin(module, len);
        float *out = calloc((size_t) blocks_for(16.0) * 2 * BLOCK, sizeof(float));
        render(&probe, blocks_for(16.0), out);
        printf("probe energy %g beats %g\n", energy(out, blocks_for(16.0)), probe.beats);
        close_plugin(&probe);
        return 0;
    }

    compare("control: an edit that changes nothing, playing on", module, len, edit_none, 2.0, -1.0, 48.0);
    compare("control: an edit that changes nothing, jump", module, len, edit_none, 2.0, 30.0, 16.0);
    compare("set while playing", module, len, edit_set, 2.0, -1.0, 48.0);
    compare("set, jump past it", module, len, edit_set, 2.0, 30.0, 16.0);
    compare("set, jump far", module, len, edit_set, 2.0, 120.0, 16.0);
    compare("set a new pattern, jump past it", module, len, edit_set_new, 2.0, 50.0, 16.0);
    compare("set after playing past it, jump back", module, len, edit_set, 40.0, 18.0, 24.0);
    compare("insert while playing", module, len, edit_insert, 2.0, -1.0, 48.0);
    compare("insert, jump past it", module, len, edit_insert, 2.0, 70.0, 16.0);
    compare("insert at the end, jump to the end", module, len, edit_insert_end, 2.0, 380.0, 32.0);
    compare("three edits in one block, jump", module, len, edit_both, 2.0, 60.0, 24.0);

    compare("step note while playing", module, len, cell_note, 2.0, -1.0, 48.0);
    compare("step note, jump into the pattern", module, len, cell_note, 2.0, 33.0, 16.0);
    compare("step speed while playing", module, len, cell_speed, 2.0, -1.0, 60.0);
    compare("step speed, jump past it", module, len, cell_speed, 2.0, 90.0, 16.0);
    compare("step pattern break, jump past it", module, len, cell_break, 2.0, 60.0, 24.0);
    compare("step position jump while playing", module, len, cell_jump, 2.0, -1.0, 60.0);
    compare("step in a later row of the playing pattern", module, len, cell_late_row, 34.0, -1.0, 32.0);
    compare("step after playing past it, jump back", module, len, cell_speed, 50.0, 30.0, 24.0);

    compare("sample header while playing, before it plays", module, len, header_late, 2.0, -1.0, 110.0);
    compare("sample header, jump past it", module, len, header_pattern_2, 2.0, 66.0, 16.0);
    compare("header of a sample that plays now, jump", module, len, header_playing, 2.0, 40.0, 16.0);
    compare("sample replaced, jump", module, len, sample_replace, 2.0, 66.0, 16.0);
    compare("sample cleared, jump", module, len, sample_clear, 2.0, 100.0, 16.0);
    compare("sample grown, every sample behind it moves, jump", module, len, sample_grow, 2.0, 20.0, 16.0);

    Plugin p = open_plugin(module, len);
    expect(set_pattern(&p, 3, 9), "a new pattern past the last one");
    process(&p, 0, NULL, NULL);
    uint32_t edited_len;
    uint8_t *edited = fetch_module(&p, &edited_len);
    expect(edited_len == len + 2 * 1024, "two empty patterns are created");
    expect(edited[952 + 3] == 9, "the position plays the new pattern");
    expect(memcmp(edited + 1084 + 10 * 1024, module + 1084 + count * 1024, len - 1084 - count * 1024) == 0, "the samples move behind them");
    free(edited);
    expect(set_pattern(&p, 3, 1), "back to an existing pattern");
    edited = fetch_module(&p, &edited_len);
    expect(edited_len == len + 2 * 1024 && edited[952 + edited[950]] == 9, "the unused patterns stay, a free entry keeps them");
    free(edited);
    expect(!set_pattern(&p, 30, 0), "a position past the song is refused");
    expect(!set_pattern(&p, 0, 64), "a pattern past the format is refused");
    expect(!set_cell(&p, 40, 0, 0, 0, 0, 0, 0), "a step of a pattern the module does not have is refused");
    expect(!set_cell(&p, 0, 64, 0, 0, 0, 0, 0), "a row past 63 is refused");
    expect(!set_cell(&p, 0, 0, 0, 0, 32, 0, 0), "a sample past 31 is refused");
    expect(set_cell(&p, 0, 5, 2, 0x1AC, 0x13, 0xC, 0x20), "a step");
    edited = fetch_module(&p, &edited_len);
    const uint8_t *step = edited + 1084 + 5 * 16 + 2 * 4;
    expect(step[0] == 0x11 && step[1] == 0xAC && step[2] == 0x3C && step[3] == 0x20, "the step lands in the module as stored");
    free(edited);
    close_plugin(&p);

    p = open_plugin(module, len);
    expect(!set_sample_header(&p, 31, 0, 64, 0, 2), "slot 32 is refused");
    expect(!set_sample_header(&p, 4, 0, 65, 0, 2), "a volume past 64 is refused");
    expect(!set_sample_header(&p, 4, 0, 64, 3000, 2000), "a loop past the sample is refused");
    expect(set_sample(&p, 1, 4000, 1000, 3000), "a new sample");
    edited = fetch_module(&p, &edited_len);
    expect(edited_len == len - 7764 + 4000, "the module holds the new length");
    expect(((edited[20 + 30 + 22] << 8) | edited[20 + 30 + 23]) * 2 == 4000, "the header has the new length");
    expect(memcmp(edited + edited_len - 6308, module + len - 6308, 6308) == 0, "the samples behind it are kept");
    free(edited);
    expect(!set_sample(&p, 1, 3, 0, 2), "an odd length is refused");
    close_plugin(&p);

    printf(failures == 0 ? "all passed\n" : "%d failed\n", failures);
    return failures == 0 ? 0 : 1;
}
