#!/usr/bin/env bash
# Builds the plugin natively with the edit test and runs it on an example. Needs $CLAP_INCLUDE like build.sh and
# wclap/gen/assets.h from a build.sh run.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="protracker.c ../emu/ust.c ../emu/musashi/m68kcpu.c ../emu/musashi/m68kops.c ../emu/musashi/softfloat/softfloat.c"
cc -O2 -w -DM68K_NO_SETJMP -I../emu/musashi -Igen -I"$CLAP_INCLUDE" $SRC test/edit-test.c -lm -o test/edit-test
test/edit-test mods/jam_-_highway_encounter.mod
