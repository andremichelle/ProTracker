import {resolve} from "path"
import {defineConfig} from "vite"

// GitHub Pages serves the site under the repository name
const REPO_BASE = "/ProTracker"

export default defineConfig(({command}) => ({
    base: command === "build" ? `${REPO_BASE}/` : "/",
    publicDir: "assets",            // ptplay, ust.wasm, thieves.mod
    resolve: {alias: {"@": resolve(__dirname, "./src")}},
    server: {port: 8080, host: "localhost"},
    preview: {port: 8080, host: "localhost"},
    esbuild: {target: "esnext"},
    build: {target: "esnext", sourcemap: true},
    worker: {format: "es"}
}))
