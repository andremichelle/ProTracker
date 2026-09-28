# ProTracker 2.3A playroutine in WebAssembly

Peter "Crayon" Hanning's original ProTracker 2.3A CIA playroutine, running as
68000 machine code inside a small purpose-built Amiga emulator compiled to
WebAssembly. Only what the routine touches is emulated: chip RAM, the 68000,
Paula's four audio DMA channels, the CIA-B timers that pace playback, and the
three exec calls the routine makes to get its interrupt.

The project started as an emulation of Karsten Obarski's Ultimate SoundTracker
V1.8 binary, which is why the exports are still prefixed `ust_`. That backend
was removed: it played its own 1988 format faithfully but nothing from the
ProTracker era.

## The routine

`emu/pt/PT-CIAPlay.s` is `PT-CIAPlay.s` from the ProTracker 2.3 release A
disk, the playroutine Crayon shipped for use in demos and games (its header
still says "V2.1A Playroutine, Mushroom Studios 1992"). It is unmodified apart
from line endings. `emu/pt/ptglue.s` wraps it with a 44 byte entry table and
a level 6 interrupt handler that does what exec's `ciab.resource` would do:
read the CIA interrupt register and call the vector the routine registered
with `AddICRVector`. Both are assembled into `assets/ptplay`, an AmigaDOS hunk
executable:

```
vasmm68k_mot -Fhunkexe -nocase -o assets/ptplay emu/pt/ptglue.s
```

vasm is at <http://sun.hasenbraten.de/vasm/> (`make CPU=m68k SYNTAX=mot`).
`-nocase` is needed because the source mixes `mt_counter` and `mt_Counter`.

At load time the emulator answers `OpenResource("ciab.resource")`,
`OpenLibrary("graphics.library")` (the routine reads `DisplayFlags` to pick
PAL) and `AddICRVector`/`RemICRVector` with stubs. From then on the routine
programs CIA-B timer A itself (1773447 / BPM E-clock cycles, 50 Hz at 125)
and talks to Paula directly.

Modules are copied to `$80000`, where the glue's `mt_data` points, with one
change ProTracker's own loader also makes: a sample repeat length of 0
becomes 1, and loops running past the sample end are clamped. Without it the
routine writes `AUDxLEN = 0`, Paula plays 65536 words, and a drum is followed
by whatever lies behind it in memory ("super mario land" does this on samples
2, 3 and 4). Old 15 instrument SoundTracker files are padded to the 31
instrument layout by the web page (`web/mod15.js`), as ProTracker does.

## Layout

```
assets/       ptplay (routine + glue), thieves.mod (demo module)
emu/ust.c     the emulator and its C API
emu/pt/       PT-CIAPlay.s (original), ptglue.s
emu/musashi/  Musashi 68000 core (Karl Stenerud, MIT), configured as a plain 68000;
              the FPU/softfloat files stay only because m68kcpu.c includes them
emu/native/   command line harness that renders a module to WAV
emu/build.sh  builds web/ust.wasm (emcc) and emu/native/ust-native (cc)
web/          demo page and AudioWorklet host
tools/        comparison tools
compare/      A/B page against reference renders
```

## WASM API

Built with `STANDALONE_WASM`, no imports. Pointers are offsets into the
exported `memory`.

| export | purpose |
| --- | --- |
| `ust_init(sampleRate)` | reset the machine |
| `ust_scratch()`, `ust_scratch_size()` | 1 MB staging buffer for file data |
| `ust_load_program(ptr, len)` | load `assets/ptplay`; the routine installs its CIA interrupt |
| `ust_load_module(ptr, len)` | load a 31 instrument module verbatim, run `mt_init` |
| `ust_play()`, `ust_stop()` | set `mt_Enable` / call `mt_end` |
| `ust_render(frames)` | advance CPU, CIA and Paula; output in `ust_out_l()` / `ust_out_r()` (float, ≤ 4096 frames) |
| `ust_set_filter(0/1)`, `ust_set_led(0/1)` | A500 output filter model and the LED filter (the routine switches it with `E0x`) |
| `ust_set_declick(0/1)` | 1 ms ramps on volume changes and note starts, like modern players do; off by default, since Paula produces hard steps and the routine writes volumes before restarting DMA |
| `ust_song_pos()`, `ust_row()`, `ust_speed()`, `ust_tempo()`, `ust_tick_hz()`, `ust_pattern()`, `ust_song_len()`, `ust_title()`, `ust_cell(ch)` | replayer state |
| `ust_chan_period(ch)`, `ust_chan_volume(ch)`, `ust_chan_dma(ch)` | Paula register view |

## Running the demo

```
cd emu && ./build.sh
cd .. && python3 -m http.server 8765
open http://localhost:8765/web/
```

Press Play; pick any `.mod` with the file input. The page boots the emulator
inside an AudioWorklet (the WASM bytes are compiled there, because Chrome does
not deliver a posted `WebAssembly.Module` to a worklet).

## Testing against references

Two renderers are useful as references, both installable with Homebrew:

* **UADE** (`brew install uade`) runs a real Amiga replayer on UAE's chipset
  emulation. It is the reference for the hardware side. Render with
  `uade123 -f out.wav -e wav --frequency=48000 --filter=NONE --panning=0 -t 90 -1 file.mod`.
* **libopenmpt** (`brew install libopenmpt`) interprets the format with modern
  ProTracker semantics. Render with `openmpt123 --render --output-type wav
  --samplerate 48000 --no-float file.mod`. Its waveforms do not line up with
  Paula-based renderers (0.35 correlation against UADE), so compare envelopes
  and spectra, not samples.

The native harness renders through the emulator:

```
emu/native/ust-native assets/ptplay song.mod out.wav 90 [filter 0/1] [led 0/1]
```

Tools:

* `tools/abcompare.py A.wav B.wav [seconds]` aligns B to A and prints the
  waveform correlation per second, to locate where two players disagree.
* `tools/specdiff.py A.wav B.wav seconds out.png` (numpy, matplotlib) prints
  1 ms envelope correlation, per-second spectral correlation and local lag,
  and draws both spectrograms.

Results against UADE, filters off on both sides: "delicate" (emax/TRSI) aligns
within 0.3 ms, equal level, 1 ms envelope correlation 0.985/0.94, waveform
correlation 0.94 to 0.99 per second after allowing a local lag of up to
170 µs; "super mario land" 0.96/0.98 envelope, 0.85 to 0.98 waveform. The
lag comes from Paula's per-scanline DMA slots, which UAE models and this
emulator does not; it is below audibility.

## Licenses

Musashi is MIT licensed, see `emu/musashi/readme.txt`. The playroutine is
Peter Hanning's, distributed with ProTracker for use in other productions.
"the thieves" is Karsten Obarski's example module from the UST 1.8 master
disk, converted to the 31 instrument layout.
