#!/usr/bin/env bash
# Writes the WebCLAP's source into an opendaw-commons checkout: wclap/commons/export.sh ../opendaw-commons
set -euo pipefail
COMMONS="$(cd "$1" && pwd)"
cd "$(dirname "$0")/../.."
TARGET="$COMMONS/wclaps/protracker"
SOURCE="$TARGET/source"
rm -rf "$TARGET"
mkdir -p "$SOURCE/plugin" "$SOURCE/emu/musashi" "$SOURCE/emu/pt" "$SOURCE/mods" "$SOURCE/page/src"
cp wclap/commons/meta.json "$TARGET/"
cp wclap/commons/build.sh wclap/commons/README.md LICENSE "$SOURCE/"
cp wclap/protracker.c "$SOURCE/plugin/"
cp emu/ust.c "$SOURCE/emu/"
cp emu/musashi/m68k.h emu/musashi/m68kconf.h emu/musashi/m68kcpu.c emu/musashi/m68kcpu.h emu/musashi/m68kops.c \
    emu/musashi/m68kops.h emu/musashi/readme.txt "$SOURCE/emu/musashi/"
cp emu/pt/PT-CIAPlay.s emu/pt/ptglue.s assets/ptplay "$SOURCE/emu/pt/"
cp wclap/mods/*.mod "$SOURCE/mods/"
cp wclap/commons/page/package.json wclap/commons/page/package-lock.json wclap/commons/page/vite.config.ts \
    wclap/commons/page/tsconfig.json wclap/page/index.html wclap/page/main.ts wclap/page/page.sass "$SOURCE/page/"
# the page's own files, what wclap/page/main.ts imports
for file in Module.ts ModuleEdit.ts Replayer.ts Status.ts styles.sass \
    ui/Channels.sass ui/Channels.tsx ui/PatternView.sass ui/PatternView.tsx ui/PositionFlyout.sass ui/Positions.sass \
    ui/Positions.tsx ui/StepFlyout.sass ui/components/Button.sass ui/components/Button.tsx \
    wclap/Mixer.sass wclap/Mixer.tsx wclap/PluginLink.ts wclap/PluginPage.sass wclap/PluginPage.tsx \
    wclap/SampleEditor.sass wclap/SampleEditor.tsx; do
    mkdir -p "$SOURCE/page/src/$(dirname "$file")"
    cp "src/$file" "$SOURCE/page/src/$file"
done
echo "exported to $TARGET"
