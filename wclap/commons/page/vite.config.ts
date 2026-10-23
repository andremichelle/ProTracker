import {resolve} from "path"
import {defineConfig} from "vite"

// the plugin page, served by the host from the bundle next to module.wasm
export default defineConfig({
    root: import.meta.dirname,
    base: "./",
    publicDir: false,
    resolve: {alias: {"@": resolve(import.meta.dirname, "./src")}},
    esbuild: {target: "esnext"},
    build: {target: "esnext", emptyOutDir: false}
})
