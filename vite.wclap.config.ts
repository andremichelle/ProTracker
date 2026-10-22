import {resolve} from "path"
import {defineConfig} from "vite"

// the WebCLAP plugin page, served by the host from the bundle next to module.wasm
export default defineConfig({
    root: resolve(import.meta.dirname, "wclap/page"),
    base: "./",
    publicDir: false,
    resolve: {alias: {"@": resolve(import.meta.dirname, "./src")}},
    esbuild: {target: "esnext"},
    build: {target: "esnext", outDir: resolve(import.meta.dirname, "wclap/out/page"), emptyOutDir: true}
})
