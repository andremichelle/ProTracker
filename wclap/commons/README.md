# ProTracker WebCLAP

Peter "Crayon" Hanning's ProTracker 2.3A playroutine running unmodified on an emulated Amiga (a Musashi 68000, Paula
and CIA-B), locked to the host's musical time. A mixer pans each channel, the page shows the song and edits the
position list, the steps and the samples.

Developed at <https://github.com/andremichelle/ProTracker>, this folder is written by `wclap/commons/export.sh`
there. Change the plugin there and export it again.

## Layout

```
build.sh        builds module.wasm, the page and the examples into $OUT
plugin/         protracker.c, the CLAP plugin
emu/ust.c       the emulator around the 68000 (Paula, CIA-B, the external clock, snapshots)
emu/musashi/    Musashi 68000 core, without its FPU, PMMU and SoftFloat (a 68000 has none of them)
emu/pt/         PT-CIAPlay.s (the playroutine), ptglue.s (the glue) and ptplay, both assembled
mods/           the example modules, the first is the one a new plugin plays
page/           the plugin page (TypeScript, built with Vite)
```

## emu/pt/ptplay

`ptplay` is code for the emulated 68000, not for the browser: the plugin loads it into the emulated Amiga's memory,
and everything it does stays there. It is `ptglue.s` (which includes `PT-CIAPlay.s`) assembled with vasm:

```
vasmm68k_mot -Fhunkexe -nocase -o ptplay ptglue.s
```

vasm is at <http://sun.hasenbraten.de/vasm/> (`make CPU=m68k SYNTAX=mot`). The result has this SHA-256:

```
4240b098abc5398b46b682f1d33910061acd91e685e9da7aa5c9f72951c89c39
```

## Licenses

1. The plugin, the emulator and the page: MIT, see `LICENSE`.
2. The playroutine `PT-CIAPlay.s`: Peter "Crayon" Hanning / Mushroom Studios, 1992, public domain. The ProTracker
   2.3A ReadMe (1993) releases the distribution as Public Domain, the 2.3D help file says "(C) 1992 Mushroom Studios.
   This program is Public Domain".
3. Musashi: Karl Stenerud, MIT, see `emu/musashi/readme.txt`.
4. The example modules: CC0.
