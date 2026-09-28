#!/bin/sh
# Builds the WASM module (web/ust.wasm) and the native test harness (emu/native/ust-native).
set -e
cd "$(dirname "$0")"

SRC="ust.c musashi/m68kcpu.c musashi/m68kops.c musashi/softfloat/softfloat.c"
EXPORTS=_ust_init,_ust_scratch,_ust_scratch_size,_ust_out_l,_ust_out_r,_ust_load_program,_ust_load_module,_ust_play,_ust_stop,_ust_render,_ust_set_filter,_ust_set_led,_ust_set_declick,_ust_song_len,_ust_song_pos,_ust_row,_ust_speed,_ust_tempo,_ust_tick_hz,_ust_pattern,_ust_title,_ust_chan_period,_ust_chan_volume,_ust_chan_dma,_ust_cell

echo "== native"
cc -O2 -w -DM68K_NO_SETJMP -Imusashi $SRC native/main.c -lm -o native/ust-native

if command -v emcc >/dev/null 2>&1; then
  echo "== wasm"
  emcc -O3 -DM68K_NO_SETJMP -Imusashi $SRC \
    -sSTANDALONE_WASM=1 --no-entry \
    -sEXPORTED_FUNCTIONS="[$EXPORTS]" \
    -sINITIAL_MEMORY=8388608 -sSTACK_SIZE=131072 -sALLOW_MEMORY_GROWTH=0 \
    -o ../web/ust.wasm
  ls -la ../web/ust.wasm
else
  echo "emcc not found, skipping wasm build"
fi
