#!/usr/bin/env bash
# Builds the ProTracker WebCLAP into $OUT (default wclap/out): module.wasm, the page (vite.wclap.config.ts) and
# protracker.wclap.tar.gz holding both.
# Needs emcc 3.1.51 and the CLAP 1.2.x headers in $CLAP_INCLUDE (the folder that holds clap/clap.h).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${OUT:-out}"
# the examples the page offers, the first one is compiled in as the module a new plugin plays
EXAMPLES="8bit_castle.mod jam_-_highway_encounter.mod jam_-_heatwave_cruise.mod kc-dancinonamiga.mod stranger_-_run.mod"
mkdir -p "$OUT" gen
{
  echo "#include <stdint.h>"
  (cd ../assets && xxd -i -n ptplay ptplay)
  cp "mods/${EXAMPLES%% *}" gen/default_mod
  (cd gen && xxd -i -n default_mod default_mod)
} | sed 's/unsigned char/static const uint8_t/; s/unsigned int/static const uint32_t/' > gen/assets.h
SRC="protracker.c ../emu/ust.c ../emu/musashi/m68kcpu.c ../emu/musashi/m68kops.c ../emu/musashi/softfloat/softfloat.c"
emcc $SRC -O3 -DM68K_NO_SETJMP -I../emu/musashi -Igen -I"$CLAP_INCLUDE" -o "$OUT/module.wasm" \
    -sSTANDALONE_WASM=1 --no-entry \
    -sEXPORTED_FUNCTIONS=_malloc,_free -Wl,--export=clap_entry \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=8MB -sSTACK_SIZE=256KB -sALLOW_TABLE_GROWTH=1 \
    -sERROR_ON_UNDEFINED_SYMBOLS=1
(cd .. && npx vite build -c vite.wclap.config.ts --logLevel warn)
rm -rf "$OUT/protracker" && mkdir -p "$OUT/protracker" && cp "$OUT/module.wasm" "$OUT/protracker/" && cp -R "$OUT/page/." "$OUT/protracker/"
mkdir -p "$OUT/protracker/mods"
for example in $EXAMPLES; do cp "mods/$example" "$OUT/protracker/mods/"; done
printf '%s\n' $EXAMPLES | python3 -c 'import json, sys; print(json.dumps(sys.stdin.read().split()))' > "$OUT/protracker/mods/index.json"
COPYFILE_DISABLE=1 tar --format ustar --no-xattrs -czf "$OUT/protracker.wclap.tar.gz" -C "$OUT" protracker
ls -la "$OUT/module.wasm" "$OUT/protracker.wclap.tar.gz"
