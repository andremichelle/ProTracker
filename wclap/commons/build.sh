#!/usr/bin/env bash
# Builds the ProTracker WebCLAP into $OUT: module.wasm, the plugin page and the example modules.
# Needs emcc, $CLAP_INCLUDE (the folder holding clap/clap.h), node and npm.
set -euo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
EXAMPLES="jam_-_heatwave_cruise.mod 8bit_castle.mod jam_-_highway_encounter.mod kc-dancinonamiga.mod"
# the playroutine and the first example compiled in as C arrays
node -e '
const fs = require("fs")
const array = (name, path) => {
    const bytes = fs.readFileSync(path)
    const rows = []
    for (let at = 0; at < bytes.length; at += 16) {rows.push(Array.from(bytes.subarray(at, at + 16), byte => `0x${byte.toString(16).padStart(2, "0")}`).join(", "))}
    return `static const uint8_t ${name}[] = {\n${rows.join(",\n")}\n};\nstatic const uint32_t ${name}_len = ${bytes.length};\n`
}
process.stdout.write("#include <stdint.h>\n" + array("ptplay", process.argv[1]) + array("default_mod", process.argv[2]))
' emu/pt/ptplay "mods/${EXAMPLES%% *}" > "$WORK/assets.h"
emcc plugin/protracker.c emu/ust.c emu/musashi/m68kcpu.c emu/musashi/m68kops.c -O3 -DM68K_NO_SETJMP \
    -Iemu/musashi -I"$WORK" -I"$CLAP_INCLUDE" -o "$OUT/module.wasm" \
    -sSTANDALONE_WASM=1 --no-entry \
    -sEXPORTED_FUNCTIONS=_malloc,_free -Wl,--export=clap_entry \
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=8MB -sSTACK_SIZE=256KB -sALLOW_TABLE_GROWTH=1 \
    -sERROR_ON_UNDEFINED_SYMBOLS=1
# the page builds outside source/, so its node_modules never land in the reviewed folder
cp -R page "$WORK/page"
(cd "$WORK/page" && npm ci --no-audit --no-fund --loglevel error && npx vite build --logLevel warn --outDir "$OUT")
mkdir -p "$OUT/mods"
for example in $EXAMPLES; do cp "mods/$example" "$OUT/mods/"; done
node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\n")' $EXAMPLES > "$OUT/mods/index.json"
