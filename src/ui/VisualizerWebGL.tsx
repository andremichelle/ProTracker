import css from "./VisualizerWebGL.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {AudioState, sampleBands} from "@/ui/audioReactive"
import * as THREE from "three"
import {EffectComposer} from "three/addons/postprocessing/EffectComposer.js"
import {RenderPass} from "three/addons/postprocessing/RenderPass.js"
import {UnrealBloomPass} from "three/addons/postprocessing/UnrealBloomPass.js"
import {OutputPass} from "three/addons/postprocessing/OutputPass.js"
import {OrbitControls} from "three/addons/controls/OrbitControls.js"
import {ParametricGeometry} from "three/addons/geometries/ParametricGeometry.js"
import {mobius} from "three/addons/geometries/ParametricFunctions.js"

const className = Html.adoptStyleSheet(css, "VisualizerWebGL")

// A square grid of bars read radially outward from the center, like a classic
// tracker/Winamp-era spectrum analyzer bent into a floor instead of a single row.
const GRID_SIZE = 14
const BAR_COUNT = GRID_SIZE * GRID_SIZE
const BAR_SPACING = 0.5
const STAR_COUNT = 900

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

const dummy = new THREE.Object3D()
const barColor = new THREE.Color()

type CoreShape = "icosahedron" | "torusKnot" | "octahedron" | "dodecahedron" | "tetrahedron" | "mobius"

type Preset = {
    name: string
    shape: CoreShape
    hueBase: number   // 0-1, center of the palette
    hueSpread: number // how much of the wheel the grid/stars sweep across
    hueSpeed: number  // how fast the sweep drifts over time
    tint: number      // multiplies the floor grid + starfield's baked-in vertex colors
    planets?: boolean  // swap the wireframe core (and the bar grid) for a little orbiting solar system
    vga?: boolean      // swap everything for the VGA tribute screen, floating as a real plane in the scene
    cityscape?: boolean // turn the bar grid into a rain-lit skyline silhouette, Blade-Runner style
    folding?: boolean  // swap the grid/core for hinged slabs that fold against each other, Inception style
    museumGallery?: "os" | "games" // float a little gallery of retro OS or arcade-game screens around the scene
    coreScale?: number // multiplies the core object's base size (default 1) - the "object" side of the balance
    barScale?: number  // multiplies the bar grid's reactive amplitude (default 1) - the "EQ" side of the balance
}

// Structurally distinct "themes" (shape/layout), each with its own color "variant" on top
// (hueBase/hueSpread/hueSpeed/tint) - cheap to add more of either without rebuilding anything.
// coreScale/barScale vary the EQ-vs-object balance per preset instead of it being fixed everywhere.
const PRESETS: ReadonlyArray<Preset> = [
    {name: "Spectrum Grid", shape: "icosahedron", hueBase: 0.5, hueSpread: 1, hueSpeed: 0.015, tint: 0xffffff},
    {name: "Tunnel Knot", shape: "torusKnot", hueBase: 0.78, hueSpread: 0.25, hueSpeed: 0.02, tint: 0xdd88ff, coreScale: 1.8, barScale: 0.5},
    {name: "Octa Pulse", shape: "octahedron", hueBase: 0.1, hueSpread: 0.35, hueSpeed: 0.01, tint: 0xffcc66, coreScale: 0.5, barScale: 1.6},
    {name: "Dodeca Dream", shape: "dodecahedron", hueBase: 0.52, hueSpread: 0.3, hueSpeed: 0.008, tint: 0x66ccff, coreScale: 1.6, barScale: 0.6},
    {name: "Phosphor Mono", shape: "icosahedron", hueBase: 0.33, hueSpread: 0.04, hueSpeed: 0.002, tint: 0x55ff88, coreScale: 0.3, barScale: 1.4},
    {name: "Sunset Bars", shape: "tetrahedron", hueBase: 0.02, hueSpread: 0.15, hueSpeed: 0.012, tint: 0xff8855, coreScale: 0.7, barScale: 1.3},
    {name: "Deep Space", shape: "torusKnot", hueBase: 0.63, hueSpread: 0.2, hueSpeed: 0.006, tint: 0x3355ff, coreScale: 2.2, barScale: 0.35},
    {name: "Neon Grid", shape: "octahedron", hueBase: 0.5, hueSpread: 1, hueSpeed: 0.05, tint: 0xffffff, coreScale: 0.4, barScale: 1.7},
    {name: "Mono Cyan", shape: "icosahedron", hueBase: 0.5, hueSpread: 0.02, hueSpeed: 0.004, tint: 0x33ffee},
    {name: "Candy", shape: "dodecahedron", hueBase: 0.85, hueSpread: 0.6, hueSpeed: 0.03, tint: 0xff99dd, coreScale: 1.4, barScale: 0.8},
    {name: "Möbius Loop", shape: "mobius", hueBase: 0.72, hueSpread: 0.4, hueSpeed: 0.015, tint: 0xffffff},
    {name: "Orbital System", shape: "icosahedron", hueBase: 0.58, hueSpread: 0.5, hueSpeed: 0.01, tint: 0xffffff, planets: true},
    {name: "VGA Tribute", shape: "icosahedron", hueBase: 0.5, hueSpread: 1, hueSpeed: 0.01, tint: 0xffffff, vga: true},
    {name: "Neon City", shape: "icosahedron", hueBase: 0.85, hueSpread: 0.35, hueSpeed: 0.02, tint: 0xffffff, cityscape: true},
    {name: "Folding Dream", shape: "icosahedron", hueBase: 0.6, hueSpread: 0.5, hueSpeed: 0.01, tint: 0xffffff, folding: true},
    {name: "Retro OS Museum", shape: "icosahedron", hueBase: 0.5, hueSpread: 1, hueSpeed: 0.01, tint: 0xffffff, museumGallery: "os"},
    {name: "Arcade Game Museum", shape: "icosahedron", hueBase: 0.5, hueSpread: 1, hueSpeed: 0.01, tint: 0xffffff, museumGallery: "games"}
]

const PLANET_COUNT = 6

// ---- VGA tribute screen: a tiny 320x200 framebuffer, drawn with a real canvas 2D context and
// mapped as a texture onto an actual plane inside the 3D scene (not a flat DOM overlay) - so it
// sits among the stars/floor grid like a floating monitor, and can tumble in 3D (see the "balloon"
// easter egg below) without needing any special-cased rendering path.
const FB_WIDTH = 320
const FB_HEIGHT = 200

const VGA_PALETTE = [
    "#000000", "#0000AA", "#00AA00", "#00AAAA",
    "#AA0000", "#AA00AA", "#AA5500", "#AAAAAA",
    "#555555", "#5555FF", "#55FF55", "#55FFFF",
    "#FF5555", "#FF55FF", "#FFFF55", "#FFFFFF"
] as const

const VGA_BOUNCE_COLORS = [9, 10, 11, 12, 13, 14, 15, 3, 2]

// Entirely original wording - a lighthearted nod to VGA-Copy, a real 1990s MS-DOS floppy-disk
// utility by Thomas Mönkemeier known for its VGA-mode interface, not a reproduction of its actual
// screens/code. No demoscene group names, logos, or real scrolltext are referenced or paraphrased.
const VGA_SCROLLTEXT =
    "   WELCOME TO THE PROTRACKER+ 4.2B VGA TRIBUTE SCREEN ...   " +
    "A SMALL ORIGINAL HOMAGE TO THE EARLY-1990S MS-DOS ERA, " +
    "AND ESPECIALLY TO VGA-COPY, THOMAS MOENKEMEIER'S BELOVED FLOPPY-DISK UTILITY " +
    "THAT TAUGHT A GENERATION WHAT A VGA SCREEN COULD LOOK LIKE ...   " +
    "BIG RESPECT TO EVERY CODER, COMPOSER AND SYSOP FROM THAT ERA ...   " +
    "LONG LIVE THE FLOPPY DISK, THE TRACKER AND THE SCENE ...   " +
    "THANKS FOR LISTENING ON PROTRACKER+ - NOW GO MAKE SOME NOISE ...   "

type VgaBounce = {x: number, y: number, vx: number, vy: number, colorIndex: number, pulse: number}

// ---- Retro OS Museum: a little gallery of floating flat screens, each one a canvas-texture
// plane (the same trick as the VGA tribute screen) looping a stylized homage to a classic
// command-line/desktop look - generic UI conventions (prompt syntax, window chrome, directory
// listing layout, color scheme) rather than any real OS's actual logo or exact boot banner text.
type MuseumKind = "dos" | "c64" | "gui" | "unix" | "shooter" | "maze" | "castle" | "platformer" | "racer" | "puzzle"

type MuseumProfile = {
    name: string
    kind: MuseumKind
    bg: string
    fg: string
    accent: string
    prompt: string
    detail: ReadonlyArray<string> // dos: extra DIR-style lines; gui: icon labels; unix: boot log lines
}

const MUSEUM_OS_PROFILES: ReadonlyArray<MuseumProfile> = [
    {name: "MS-DOS 3.3", kind: "dos", bg: "#000000", fg: "#AAAAAA", accent: "#FFFFFF", prompt: "C:\\>",
        detail: ["TRACKER   MOD     47845  01-01-90", "AUTOEXEC  BAT        64  01-01-90", "CONFIG    SYS        12  01-01-90"]},
    {name: "DR-DOS", kind: "dos", bg: "#000000", fg: "#55FF55", accent: "#FFFF55", prompt: "A>",
        detail: ["COMMAND   COM     23210  03-07-91", "DRDOS     SYS      8192  03-07-91"]},
    {name: "Novell DOS", kind: "dos", bg: "#0000AA", fg: "#FFFFFF", accent: "#55FFFF", prompt: "C:\\>",
        detail: ["NWCLIENT  EXE     51200  06-15-94", "NET       CFG       512  06-15-94"]},
    {name: "Amiga Workbench", kind: "gui", bg: "#9999BB", fg: "#000000", accent: "#0000AA", prompt: "",
        detail: ["Disk1", "Trash", "Tools", "System"]},
    {name: "Atari TOS", kind: "gui", bg: "#FFFFFF", fg: "#000000", accent: "#000000", prompt: "",
        detail: ["Floppy", "Trash", "App", "Folder"]},
    {name: "Commodore 64", kind: "c64", bg: "#4040C0", fg: "#A0C0FF", accent: "#8080E0", prompt: "READY.",
        detail: []},
    {name: "Windows 3.x", kind: "gui", bg: "#008080", fg: "#000000", accent: "#C0C0C0", prompt: "",
        detail: ["File Mgr", "Write", "Paint", "Clock"]},
    {name: "OS/2 Warp", kind: "gui", bg: "#101040", fg: "#FFFFFF", accent: "#8888CC", prompt: "",
        detail: ["Drives", "Templates", "Shredder"]},
    {name: "Red Hat Linux", kind: "unix", bg: "#000000", fg: "#FF5555", accent: "#FFFFFF", prompt: "login:",
        detail: ["Starting syslogd ...", "Starting network ...", "Mounting filesystems ..."]},
    {name: "SCO UNIX", kind: "unix", bg: "#000000", fg: "#00AAAA", accent: "#FFFFFF", prompt: "login:",
        detail: ["INIT: entering run level 3", "Starting OpenDesktop ...", "cron started"]},
    {name: "Solaris", kind: "unix", bg: "#000000", fg: "#FFAA00", accent: "#FFFFFF", prompt: "login:",
        detail: ["SunOS Release 5.6", "checking filesystems ...", "starting NIS services ..."]}
]

// Original, made-up titles evoking classic arcade/home-computer genres (shooter, maze-chase,
// castle-siege artillery duel, platformer, pseudo-3D racer, falling-block puzzle) - not real
// game names, logos, or character designs, just the generic visual conventions of each genre.
const MUSEUM_GAME_PROFILES: ReadonlyArray<MuseumProfile> = [
    {name: "Galaxy Defender", kind: "shooter", bg: "#000010", fg: "#FFFFFF", accent: "#55FF55", prompt: "INSERT COIN", detail: []},
    {name: "Asteroid Field", kind: "shooter", bg: "#000000", fg: "#FFFFFF", accent: "#FFFFFF", prompt: "INSERT COIN", detail: []},
    {name: "Maze Muncher", kind: "maze", bg: "#000000", fg: "#FF5555", accent: "#FFFF55", prompt: "PRESS START", detail: []},
    {name: "Dungeon Delver", kind: "maze", bg: "#100800", fg: "#CC8844", accent: "#FFAA33", prompt: "PRESS START", detail: []},
    {name: "Boulder Run", kind: "maze", bg: "#1a0f00", fg: "#AA7733", accent: "#FFCC55", prompt: "PRESS START", detail: []},
    {name: "Castle Siege", kind: "castle", bg: "#335577", fg: "#FFFFFF", accent: "#777777", prompt: "PRESS FIRE", detail: []},
    {name: "Block Jumper", kind: "platformer", bg: "#4488CC", fg: "#FFFFFF", accent: "#FF8833", prompt: "PRESS START", detail: []},
    {name: "Pixel Quest", kind: "platformer", bg: "#225522", fg: "#FFFFFF", accent: "#FFDD33", prompt: "PRESS START", detail: []},
    {name: "Turbo Rally", kind: "racer", bg: "#222222", fg: "#FFFFFF", accent: "#FF3333", prompt: "GET READY", detail: []},
    {name: "Gem Puzzle", kind: "puzzle", bg: "#110022", fg: "#FFFFFF", accent: "#FF55FF", prompt: "PRESS START", detail: []},
    {name: "Space Trader", kind: "puzzle", bg: "#000820", fg: "#55DDFF", accent: "#FFCC33", prompt: "PRESS START", detail: ["CREDITS: 1000", "FUEL: 85%"]}
]

const MUSEUM_FB_WIDTH = 256
const MUSEUM_FB_HEIGHT = 176

type MuseumScreen = {
    canvas: HTMLCanvasElement
    ctx: CanvasRenderingContext2D
    texture: THREE.CanvasTexture
    plane: THREE.Mesh
    material: THREE.MeshBasicMaterial
    profile: MuseumProfile
    radius: number
    height: number
    speed: number
    phase: number
}

const museumGeometry = new THREE.PlaneGeometry(2.6, 1.77)

const drawDosScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace"
    ctx.textBaseline = "top"
    ctx.textAlign = "left"
    ctx.fillStyle = profile.fg
    let y = 10
    ctx.fillText(`${profile.prompt}DIR`, 10, y); y += 16
    ctx.fillText(" VOLUME IN DRIVE HAS NO LABEL", 10, y); y += 14
    ctx.fillText(" DIRECTORY OF \\", 10, y); y += 18
    for (const entry of profile.detail) {ctx.fillText(" " + entry, 10, y); y += 14}
    y += 4
    ctx.fillText(`   ${profile.detail.length} FILE(S)   655360 BYTES FREE`, 10, y); y += 20
    const blink = Math.floor(seconds * 2) % 2 === 0
    ctx.fillText(profile.prompt + (blink ? "_" : " "), 10, y)
}

const drawC64Screen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    const border = 14
    ctx.fillStyle = profile.accent
    ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = profile.bg
    ctx.fillRect(border, border, w - border * 2, h - border * 2)
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace"
    ctx.textBaseline = "top"
    ctx.textAlign = "center"
    ctx.fillStyle = profile.fg
    ctx.fillText("**** COMMODORE-STYLE 64 BASIC ****", w / 2, border + 10)
    ctx.fillText("64K RAM SYSTEM  38911 BASIC BYTES FREE", w / 2, border + 28)
    ctx.textAlign = "left"
    const blink = Math.floor(seconds * 2) % 2 === 0
    ctx.fillText(profile.prompt, border + 6, border + 54)
    if (blink) {ctx.fillRect(border + 6 + profile.prompt.length * 6.6, border + 54, 7, 11)}
}

const MUSEUM_ICON_COLOR = "#FFD966"

const drawGuiScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    // A simple window: title bar + body, with a little icon grid inside.
    const winX = 10, winY = 10, winW = w - 20, winH = h - 20
    ctx.fillStyle = profile.accent
    ctx.fillRect(winX, winY, winW, 16)
    ctx.fillStyle = profile.fg === "#000000" ? "#FFFFFF" : "#000000"
    ctx.font = "bold 10px ui-monospace, Menlo, Consolas, monospace"
    ctx.textBaseline = "top"
    ctx.textAlign = "left"
    ctx.fillText(profile.name.toUpperCase(), winX + 5, winY + 3)
    ctx.fillStyle = "#DDDDDD"
    ctx.fillRect(winX, winY + 16, winW, winH - 16)
    ctx.strokeStyle = "#555555"
    ctx.strokeRect(winX, winY, winW, winH)
    const iconSize = 24
    ctx.font = "8px ui-monospace, Menlo, Consolas, monospace"
    ctx.textAlign = "center"
    profile.detail.forEach((label, i) => {
        const col = i % 4, row = Math.floor(i / 4)
        const ix = winX + 16 + col * 56
        const iy = winY + 30 + row * 50 + Math.sin(seconds * 0.6 + i) * 1.5
        ctx.fillStyle = MUSEUM_ICON_COLOR
        ctx.fillRect(ix, iy, iconSize, iconSize * 0.8)
        ctx.fillStyle = "#000000"
        ctx.fillText(label, ix + iconSize / 2, iy + iconSize * 0.8 + 3)
    })
}

const drawUnixScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    ctx.font = "10px ui-monospace, Menlo, Consolas, monospace"
    ctx.textBaseline = "top"
    ctx.textAlign = "left"
    ctx.fillStyle = profile.fg
    let y = 10
    for (const line of profile.detail) {ctx.fillText(line, 10, y); y += 14}
    y += 8
    ctx.fillStyle = profile.accent
    const cycle = seconds % 8
    const username = "guest"
    const typed = cycle < 2 ? username.slice(0, Math.floor((cycle / 2) * username.length)) : username
    const blink = Math.floor(seconds * 2) % 2 === 0
    const cursor = cycle < 2.3 ? (blink ? "_" : " ") : ""
    ctx.fillText(`${profile.prompt} ${typed}${cursor}`, 10, y)
    if (cycle >= 2.3) {
        y += 16
        ctx.fillStyle = profile.fg
        ctx.fillText(cycle < 5 ? "Password: ********" : "Last login: today", 10, y)
    }
}

// Shared title/prompt chrome for the arcade-style game screens below.
const drawArcadeChrome = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.font = "bold 12px ui-monospace, Menlo, Consolas, monospace"
    ctx.textAlign = "center"
    ctx.textBaseline = "top"
    ctx.fillStyle = profile.accent
    ctx.fillText(profile.name.toUpperCase(), w / 2, 8)
    if (Math.floor(seconds * 1.5) % 2 === 0) {
        ctx.font = "10px ui-monospace, Menlo, Consolas, monospace"
        ctx.fillStyle = profile.fg
        ctx.fillText(profile.prompt, w / 2, h - 16)
    }
}

const drawShooterScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    for (let i = 0; i < 30; i++) {
        const seed = i * 53.7
        const x = (seed * 7) % w
        const y = (seed * 11 + seconds * 20) % h
        ctx.fillStyle = profile.fg
        ctx.fillRect(x, y, 1, 1)
    }
    // A simple wedge-shaped ship near the bottom, drifting slightly side to side.
    const shipX = w / 2 + Math.sin(seconds * 0.8) * w * 0.25
    const shipY = h - 34
    ctx.fillStyle = profile.accent
    ctx.beginPath()
    ctx.moveTo(shipX, shipY - 8)
    ctx.lineTo(shipX + 7, shipY + 8)
    ctx.lineTo(shipX - 7, shipY + 8)
    ctx.closePath()
    ctx.fill()
    // A few descending enemies, looping from the top once they pass the bottom.
    for (let i = 0; i < 4; i++) {
        const ex = w * (0.2 + i * 0.2)
        const ey = (seconds * 30 + i * 40) % (h - 50) + 20
        ctx.save()
        ctx.translate(ex, ey)
        ctx.rotate(Math.PI / 4)
        ctx.fillStyle = profile.fg
        ctx.fillRect(-4, -4, 8, 8)
        ctx.restore()
    }
    ctx.textAlign = "left"
    ctx.textBaseline = "top"
    ctx.font = "9px ui-monospace, Menlo, Consolas, monospace"
    ctx.fillStyle = profile.fg
    ctx.fillText(`SCORE ${(Math.floor(seconds * 37) % 100000).toString().padStart(6, "0")}`, 8, 24)
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawMazeScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    const left = 20, top = 40, right = w - 20, bottom = h - 30
    ctx.strokeStyle = "#444444"
    ctx.lineWidth = 2
    ctx.strokeRect(left, top, right - left, bottom - top)
    for (let i = 1; i < 3; i++) {
        const x = left + (right - left) * (i / 3)
        ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + (bottom - top) * 0.5); ctx.stroke()
    }
    // A mover looping clockwise around the inner rectangle's perimeter, eating fixed dots.
    const perimeter = 2 * (right - left - 20) + 2 * (bottom - top - 20)
    const t = (seconds * 40) % perimeter
    const path = {x: left + 10, y: top + 10}
    let remaining = t
    const segW = right - left - 20, segH = bottom - top - 20
    if (remaining <= segW) {path.x += remaining} else {
        remaining -= segW; path.x += segW
        if (remaining <= segH) {path.y += remaining} else {
            remaining -= segH; path.y += segH
            if (remaining <= segW) {path.x -= remaining} else {
                remaining -= segW; path.x -= segW; path.y -= remaining
            }
        }
    }
    ctx.fillStyle = profile.accent
    ctx.beginPath()
    ctx.arc(path.x, path.y, 5, 0, Math.PI * 2)
    ctx.fill()
    // A chaser, same path with a phase offset.
    const t2 = (t + perimeter * 0.4) % perimeter
    let remaining2 = t2
    const path2 = {x: left + 10, y: top + 10}
    if (remaining2 <= segW) {path2.x += remaining2} else {
        remaining2 -= segW; path2.x += segW
        if (remaining2 <= segH) {path2.y += remaining2} else {
            remaining2 -= segH; path2.y += segH
            if (remaining2 <= segW) {path2.x -= remaining2} else {
                remaining2 -= segW; path2.x -= segW; path2.y -= remaining2
            }
        }
    }
    ctx.fillStyle = profile.fg
    ctx.beginPath()
    ctx.moveTo(path2.x, path2.y - 5)
    ctx.lineTo(path2.x + 5, path2.y + 5)
    ctx.lineTo(path2.x - 5, path2.y + 5)
    ctx.closePath()
    ctx.fill()
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawCastleScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    const groundY = h - 40
    ctx.fillStyle = "#335522"
    ctx.fillRect(0, groundY, w, h - groundY)
    const drawCastle = (x: number): void => {
        ctx.fillStyle = profile.accent
        ctx.fillRect(x, groundY - 30, 26, 30)
        for (let i = 0; i < 3; i++) {ctx.fillRect(x + i * 9, groundY - 36, 6, 6)}
    }
    drawCastle(14)
    drawCastle(w - 40)
    // A projectile arcing between the two castles on a repeating loop.
    const t = (seconds * 0.6) % 1
    const px = 30 + t * (w - 70)
    const py = groundY - 28 - Math.sin(t * Math.PI) * 60
    ctx.fillStyle = profile.fg
    ctx.beginPath()
    ctx.arc(px, py, 3, 0, Math.PI * 2)
    ctx.fill()
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawPlatformerScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    const platforms = [{x: 20, y: h - 30, w: 60}, {x: 110, y: h - 70, w: 50}, {x: 190, y: h - 50, w: 46}]
    ctx.fillStyle = "#664422"
    for (const platform of platforms) {ctx.fillRect(platform.x, platform.y, platform.w, 8)}
    // A hero hopping between the platforms on a repeating loop.
    const cycle = (seconds * 0.5) % platforms.length
    const index = Math.floor(cycle)
    const from = platforms[index], to = platforms[(index + 1) % platforms.length]
    const frac = cycle - index
    const heroX = from.x + from.w / 2 + (to.x + to.w / 2 - (from.x + from.w / 2)) * frac
    const heroY = from.y - 10 - Math.sin(frac * Math.PI) * 24
    ctx.fillStyle = profile.accent
    ctx.fillRect(heroX - 5, heroY - 10, 10, 10)
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawRacerScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    const horizon = h * 0.4
    ctx.fillStyle = "#101010"
    ctx.fillRect(0, horizon, w, h - horizon)
    ctx.strokeStyle = "#666666"
    ctx.beginPath()
    ctx.moveTo(w * 0.42, horizon); ctx.lineTo(0, h)
    ctx.moveTo(w * 0.58, horizon); ctx.lineTo(w, h)
    ctx.stroke()
    ctx.strokeStyle = profile.accent
    ctx.lineWidth = 3
    const dashOffset = (seconds * 120) % 24
    for (let y = horizon + dashOffset; y < h; y += 24) {
        const scale = (y - horizon) / (h - horizon)
        const dashW = 2 + scale * 4
        ctx.fillStyle = profile.accent
        ctx.fillRect(w / 2 - dashW / 2, y, dashW, 10)
    }
    ctx.fillStyle = "#DD3333"
    ctx.fillRect(w / 2 - 12, h - 26, 24, 16)
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawPuzzleScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    ctx.fillStyle = profile.bg
    ctx.fillRect(0, 0, w, h)
    const cols = 6, rows = 5, cell = 20
    const left = (w - cols * cell) / 2, top = 28
    const palette = ["#FF5555", "#55FF55", "#5588FF", "#FFFF55", "#FF55FF", "#55FFFF"]
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const seed = (r * cols + c) * 13 + Math.floor(seconds * 0.8)
            ctx.fillStyle = palette[seed % palette.length]
            ctx.fillRect(left + c * cell + 1, top + r * cell + 1, cell - 2, cell - 2)
        }
    }
    for (const line of profile.detail) {
        ctx.font = "9px ui-monospace, Menlo, Consolas, monospace"
        ctx.textAlign = "left"
        ctx.textBaseline = "top"
        ctx.fillStyle = profile.fg
        ctx.fillText(line, 8, h - 34)
    }
    drawArcadeChrome(ctx, w, h, profile, seconds)
}

const drawMuseumScreen = (ctx: CanvasRenderingContext2D, w: number, h: number, profile: MuseumProfile, seconds: number): void => {
    switch (profile.kind) {
        case "dos": return drawDosScreen(ctx, w, h, profile, seconds)
        case "c64": return drawC64Screen(ctx, w, h, profile, seconds)
        case "gui": return drawGuiScreen(ctx, w, h, profile, seconds)
        case "unix": return drawUnixScreen(ctx, w, h, profile, seconds)
        case "shooter": return drawShooterScreen(ctx, w, h, profile, seconds)
        case "maze": return drawMazeScreen(ctx, w, h, profile, seconds)
        case "castle": return drawCastleScreen(ctx, w, h, profile, seconds)
        case "platformer": return drawPlatformerScreen(ctx, w, h, profile, seconds)
        case "racer": return drawRacerScreen(ctx, w, h, profile, seconds)
        case "puzzle": return drawPuzzleScreen(ctx, w, h, profile, seconds)
    }
}

const drawVgaDiamond = (ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, color: string): void => {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(cx, cy - radius)
    ctx.lineTo(cx + radius, cy)
    ctx.lineTo(cx, cy + radius)
    ctx.lineTo(cx - radius, cy)
    ctx.closePath()
    ctx.fill()
}

const formatElapsed = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.min(99, Math.floor(totalSeconds / 60))
    const seconds = totalSeconds % 60
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

export const VisualizerWebGL = ({lifecycle, player}: Construct) => {
    const canvasHost: HTMLDivElement = <div className="canvas-host"/>
    const title = Inject.value("PROTRACKER+ 4.2B // WEBGL VIEW")
    const stateLine = Inject.value("STANDBY")
    const statusLine = Inject.value("")
    const hud: HTMLDivElement = (
        <div className="hud">
            <div className="panel">
                <b>{title}</b>
                <span>{stateLine}</span>
                <span>{statusLine}</span>
            </div>
        </div>
    )
    const stage: HTMLDivElement = <div className="stage">{canvasHost}{hud}</div>

    const speed = lifecycle.own(new DefaultObservableValue(1))
    const reactivity = lifecycle.own(new DefaultObservableValue(1))
    const speedValue = <span>1.00x</span> as HTMLSpanElement
    const reactivityValue = <span>1.00x</span> as HTMLSpanElement
    const speedInput: HTMLInputElement = (
        <input type="range" min="0.1" max="3" step="0.05" value="1"
               oninput={() => {
                   const value = parseFloat(speedInput.value)
                   speed.setValue(value)
                   speedValue.textContent = `${value.toFixed(2)}x`
               }}/>
    )
    const reactivityInput: HTMLInputElement = (
        <input type="range" min="0" max="2" step="0.05" value="1"
               oninput={() => {
                   const value = parseFloat(reactivityInput.value)
                   reactivity.setValue(value)
                   reactivityValue.textContent = `${value.toFixed(2)}x`
               }}/>
    )
    const glow = lifecycle.own(new DefaultObservableValue(1))
    const glowValue = <span>1.00x</span> as HTMLSpanElement
    const glowInput: HTMLInputElement = (
        <input type="range" min="0" max="2.5" step="0.05" value="1"
               oninput={() => {
                   const value = parseFloat(glowInput.value)
                   glow.setValue(value)
                   glowValue.textContent = `${value.toFixed(2)}x`
               }}/>
    )
    const presetSelect: HTMLSelectElement = (
        <select>
            {PRESETS.map(preset => <option value={preset.name}>{preset.name}</option>)}
        </select>
    )
    const spinInput: HTMLInputElement = <input type="checkbox" checked/>
    const consoleEl: HTMLDivElement = <div className="console"/>
    consoleEl.hidden = true
    stage.appendChild(consoleEl)
    const consoleInput: HTMLInputElement = (
        <input type="checkbox" onchange={() => {consoleEl.hidden = !consoleInput.checked}}/>
    )
    const controlsBar: HTMLDivElement = (
        <div className="controls">
            <label>Preset {presetSelect}</label>
            <label>Speed {speedInput} {speedValue}</label>
            <label>Reactivity {reactivityInput} {reactivityValue}</label>
            <label>Glow {glowInput} {glowValue}</label>
            <label>{spinInput} Free spin</label>
            <label>{consoleInput} Console</label>
        </div>
    )
    const element: HTMLDivElement = <div className={className}>{controlsBar}{stage}</div>

    // Optional Doom/Quake-style console: a scrolling log of short status/fun lines, off by
    // default. Purely cosmetic/debug flavor - nothing here is read back by anything else.
    const consoleLines: Array<string> = []
    const pushConsoleLine = (line: string): void => {
        consoleLines.push(line)
        if (consoleLines.length > 3) {consoleLines.shift()}
        consoleEl.textContent = consoleLines.map(entry => `> ${entry}`).join("\n")
    }
    let lastConsoleStatAt = 0
    let lastPunchLogAt = 0

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x020305)
    scene.fog = new THREE.FogExp2(0x020305, 0.022)

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120)

    const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: "high-performance"})
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
    canvasHost.appendChild(renderer.domElement)

    // Free-look on demand: auto-orbits by itself, but a drag/scroll/pinch takes over
    // immediately and OrbitControls' own damping hands auto-rotate back a moment after release.
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1.2, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.06
    controls.minDistance = 4
    controls.maxDistance = 45
    controls.maxPolarAngle = Math.PI * 0.49 // stop just short of going under the floor
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.6
    camera.position.setFromSphericalCoords(15, Math.PI / 2 - 0.38, 0)
    controls.update()

    const composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.5, 0.7, 0.1)
    composer.addPass(bloomPass)
    composer.addPass(new OutputPass())

    // The bar grid: one InstancedMesh, unlit (MeshBasicMaterial) so bar brightness maps
    // directly to bloom intensity instead of depending on scene lighting.
    const barGeometry = new THREE.BoxGeometry(0.3, 1, 0.3)
    const barMaterial = new THREE.MeshBasicMaterial({color: 0xffffff})
    const bars = new THREE.InstancedMesh(barGeometry, barMaterial, BAR_COUNT)
    bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    const barBins = new Int32Array(BAR_COUNT)
    const barAngles = new Float32Array(BAR_COUNT)
    // "Neon City" preset only: a fixed per-building height bias, so the grid reads as a skyline
    // silhouette instead of a flat spectrum analyzer - spectrum reactivity still rides on top.
    const cityHeights = new Float32Array(BAR_COUNT)
    const half = (GRID_SIZE - 1) / 2
    for (let i = 0; i < GRID_SIZE; i++) {
        for (let j = 0; j < GRID_SIZE; j++) {
            const index = i * GRID_SIZE + j
            const dx = i - half, dz = j - half
            const dist = Math.hypot(dx, dz) / Math.hypot(half, half) // 0 at center, 1 at corners
            barBins[index] = Math.min(255, Math.floor(Math.pow(dist, 1.3) * 230))
            barAngles[index] = Math.atan2(dz, dx)
            cityHeights[index] = Math.random()
            dummy.position.set(dx * BAR_SPACING, 0, dz * BAR_SPACING)
            dummy.scale.set(1, 0.01, 1)
            dummy.updateMatrix()
            bars.setMatrixAt(index, dummy.matrix)
            bars.setColorAt(index, barColor.setHSL(0.48, 1, 0.1))
        }
    }
    scene.add(bars)

    // Falling rain for "Neon City" - plain points, wraps back to the top once it passes the floor.
    const RAIN_COUNT = 500
    const rainGeometry = new THREE.BufferGeometry()
    const rainPositions = new Float32Array(RAIN_COUNT * 3)
    for (let i = 0; i < RAIN_COUNT; i++) {
        rainPositions[i * 3] = (Math.random() - 0.5) * 20
        rainPositions[i * 3 + 1] = Math.random() * 14
        rainPositions[i * 3 + 2] = (Math.random() - 0.5) * 20
    }
    rainGeometry.setAttribute("position", new THREE.BufferAttribute(rainPositions, 3))
    const rainMaterial = new THREE.PointsMaterial({
        color: 0x99ccff, size: 0.05, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false
    })
    const rain = new THREE.Points(rainGeometry, rainMaterial)
    rain.visible = false
    scene.add(rain)

    // "Folding Dream" preset: hinged slabs arranged in a ring, each swinging open/closed on its
    // own phase - a cheap stand-in for Inception's folding-city non-Euclidean fight scene.
    const FOLD_COUNT = 6
    const foldGeometry = new THREE.PlaneGeometry(3.2, 3.2)
    const foldingGroup = new THREE.Group()
    foldingGroup.visible = false
    const foldHinges: ReadonlyArray<{hinge: THREE.Group, material: THREE.MeshBasicMaterial, phase: number}> =
        Array.from({length: FOLD_COUNT}, (_, i) => {
            const angle = (i / FOLD_COUNT) * Math.PI * 2
            const hinge = new THREE.Group()
            hinge.position.set(Math.cos(angle) * 2.2, 1.6, Math.sin(angle) * 2.2)
            hinge.rotation.y = -angle
            const material = new THREE.MeshBasicMaterial({
                color: 0xffffff, wireframe: true, transparent: true, opacity: 0.65, side: THREE.DoubleSide
            })
            const slab = new THREE.Mesh(foldGeometry, material)
            slab.position.x = 1.6 // hinges from the group's local origin edge, not its own center
            hinge.add(slab)
            foldingGroup.add(hinge)
            return {hinge, material, phase: i * 0.7}
        })
    scene.add(foldingGroup)

    // "Retro OS Museum" / "Arcade Game Museum" presets: a little gallery of floating screens,
    // each looping a stylized, non-pixel-exact homage to a classic boot/title screen. The same
    // set of floating planes is reused for both galleries - applyPreset() just swaps which
    // profile each screen is currently drawing (see MUSEUM_OS_PROFILES/MUSEUM_GAME_PROFILES).
    const museumScreens: ReadonlyArray<MuseumScreen> = MUSEUM_OS_PROFILES.map((profile, i) => {
        const canvas = document.createElement("canvas")
        canvas.width = MUSEUM_FB_WIDTH
        canvas.height = MUSEUM_FB_HEIGHT
        const ctx = canvas.getContext("2d") as CanvasRenderingContext2D
        const texture = new THREE.CanvasTexture(canvas)
        texture.magFilter = THREE.NearestFilter
        texture.minFilter = THREE.NearestFilter
        texture.generateMipmaps = false
        const material = new THREE.MeshBasicMaterial({map: texture, side: THREE.DoubleSide})
        const plane = new THREE.Mesh(museumGeometry, material)
        return {
            canvas, ctx, texture, plane, material, profile,
            radius: 5 + (i % 3) * 1.6,
            height: 1 + (i % 4) * 1.3,
            speed: 0.05 + (i % 5) * 0.012,
            phase: (i / MUSEUM_OS_PROFILES.length) * Math.PI * 2
        }
    })
    const museumGroup = new THREE.Group()
    museumGroup.visible = false
    museumScreens.forEach(screen => museumGroup.add(screen.plane))
    scene.add(museumGroup)

    // Faint XYZ axis gizmo at the origin, under the bar grid.
    const axisGroup = new THREE.Group()
    const axisLength = 9
    const addAxis = (dir: THREE.Vector3, color: number): void => {
        const points = [new THREE.Vector3(0, 0, 0), dir.clone().multiplyScalar(axisLength)]
        const geometry = new THREE.BufferGeometry().setFromPoints(points)
        const material = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.25})
        axisGroup.add(new THREE.Line(geometry, material))
    }
    addAxis(new THREE.Vector3(1, 0, 0), 0xff3366)
    addAxis(new THREE.Vector3(0, 1, 0), 0x33ff88)
    addAxis(new THREE.Vector3(0, 0, 1), 0x3399ff)
    scene.add(axisGroup)

    const floorGrid = new THREE.GridHelper(GRID_SIZE * BAR_SPACING * 1.4, 28, 0x0affd9, 0x0a2a2e)
    ;(floorGrid.material as THREE.Material).transparent = true
    ;(floorGrid.material as THREE.Material).opacity = 0.35
    scene.add(floorGrid)

    // A pulsing wireframe core, tying back to the ASCII 3D view's shapes. Each preset just
    // points it at a different pre-built geometry rather than rebuilding anything.
    const coreGeometries: Record<CoreShape, THREE.BufferGeometry> = {
        icosahedron: new THREE.IcosahedronGeometry(1.4, 1),
        torusKnot: new THREE.TorusKnotGeometry(1, 0.34, 120, 16),
        octahedron: new THREE.OctahedronGeometry(1.6, 1),
        dodecahedron: new THREE.DodecahedronGeometry(1.4, 0),
        tetrahedron: new THREE.TetrahedronGeometry(1.7, 1),
        mobius: new ParametricGeometry(mobius, 120, 24)
    }
    const coreMaterial = new THREE.MeshBasicMaterial({color: 0x66ffe0, wireframe: true, transparent: true, opacity: 0.85})
    const core = new THREE.Mesh(coreGeometries.icosahedron, coreMaterial)
    core.position.y = 3.2
    scene.add(core)

    // "Orbital System" preset: a little sun-and-planets rig orbiting the core on its own
    // inclined planes, each planet's size/speed pulled from a different spectrum bin.
    const planetGroup = new THREE.Group()
    planetGroup.visible = false
    const planetGeometry = new THREE.SphereGeometry(0.22, 16, 16)
    const planets: ReadonlyArray<{mesh: THREE.Mesh, radius: number, tilt: number, speed: number, bin: number}> =
        Array.from({length: PLANET_COUNT}, (_, i) => {
            const material = new THREE.MeshBasicMaterial({color: 0xffffff})
            const mesh = new THREE.Mesh(planetGeometry, material)
            const orbit = new THREE.Group()
            orbit.rotation.x = (i / PLANET_COUNT) * 0.6
            orbit.rotation.z = (i / PLANET_COUNT) * 1.3
            orbit.add(mesh)
            planetGroup.add(orbit)
            mesh.userData.orbit = orbit
            return {mesh, radius: 2.4 + i * 0.9, tilt: i * 0.5, speed: 0.25 + i * 0.07, bin: 20 + i * 30}
        })
    planetGroup.position.y = 3.2
    scene.add(planetGroup)

    // VGA tribute plane: a real textured mesh in the scene, not a DOM overlay.
    const vgaCanvas = document.createElement("canvas")
    vgaCanvas.width = FB_WIDTH
    vgaCanvas.height = FB_HEIGHT
    const vgaCtx = vgaCanvas.getContext("2d")
    const vgaTexture = new THREE.CanvasTexture(vgaCanvas)
    vgaTexture.magFilter = THREE.NearestFilter
    vgaTexture.minFilter = THREE.NearestFilter
    vgaTexture.generateMipmaps = false
    const vgaGeometry = new THREE.PlaneGeometry(6.4, 4)
    const vgaMaterial = new THREE.MeshBasicMaterial({map: vgaTexture})
    const vgaPlane = new THREE.Mesh(vgaGeometry, vgaMaterial)
    const vgaRestPosition = new THREE.Vector3(0, 3.2, 0)
    vgaPlane.position.copy(vgaRestPosition)
    vgaPlane.visible = false
    scene.add(vgaPlane)
    const vgaBounce: VgaBounce = {x: FB_WIDTH / 2, y: FB_HEIGHT / 2 + 20, vx: 1.3, vy: 1.0, colorIndex: 0, pulse: 0}
    const vgaCycle = {value: 0}

    // Easter egg: "hanging on a balloon" - most of the time the screen just sits flat and still,
    // but on a random 0-100 second timer (or a direct click on the screen) it breaks loose and
    // floats/tumbles in full 3D for a while, revealing it was a real plane in the scene all along.
    const scheduleNextBalloon = (now: number): number => now + Math.random() * 100_000
    let vgaFlipActive = false
    let vgaFlipStart = 0
    let vgaFlipEnd = 0
    let vgaNextFlipAt = scheduleNextBalloon(performance.now())
    const triggerVgaFlip = (now: number): void => {
        vgaFlipActive = true
        vgaFlipStart = now
        vgaFlipEnd = now + 12_000 + Math.random() * 8_000
    }
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let pointerDownAt: {x: number, y: number} | null = null
    renderer.domElement.addEventListener("pointerdown", event => {
        pointerDownAt = {x: event.clientX, y: event.clientY}
    })
    renderer.domElement.addEventListener("pointerup", event => {
        if (!activePreset.vga || pointerDownAt === null) {pointerDownAt = null; return}
        const moved = Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y)
        pointerDownAt = null
        if (moved > 6) {return} // a drag (orbiting the camera), not a click
        const rect = renderer.domElement.getBoundingClientRect()
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(pointer, camera)
        if (raycaster.intersectObject(vgaPlane).length > 0) {triggerVgaFlip(performance.now())}
    })

    const starGeometry = new THREE.BufferGeometry()
    const starPositions = new Float32Array(STAR_COUNT * 3)
    const starColors = new Float32Array(STAR_COUNT * 3)
    const starPalette = [new THREE.Color(0x3399ff), new THREE.Color(0xff33aa), new THREE.Color(0x66ffe0)]
    for (let i = 0; i < STAR_COUNT; i++) {
        starPositions[i * 3] = (Math.random() - 0.5) * 90
        starPositions[i * 3 + 1] = (Math.random() - 0.5) * 90
        starPositions[i * 3 + 2] = (Math.random() - 0.5) * 90
        const color = starPalette[i % starPalette.length]
        starColors[i * 3] = color.r; starColors[i * 3 + 1] = color.g; starColors[i * 3 + 2] = color.b
    }
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3))
    starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3))
    const stars = new THREE.Points(starGeometry, new THREE.PointsMaterial({
        size: 0.09, transparent: true, opacity: 0.8, vertexColors: true
    }))
    scene.add(stars)

    const resize = (): boolean => {
        const width = canvasHost.clientWidth, height = canvasHost.clientHeight
        if (width === 0 || height === 0) {return false}
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        renderer.setSize(width, height, false)
        composer.setSize(width, height)
        return true
    }

    const spectrum = new Uint8Array(256)
    const audio: AudioState = {lastTime: performance.now(), bassEnvelope: 0, punch: 0}
    let activePreset = PRESETS[0]
    const floorTint = (floorGrid.material as THREE.Material & {color: THREE.Color}).color
    const starTint = (stars.material as THREE.PointsMaterial).color

    const applyPreset = (preset: Preset): void => {
        activePreset = preset
        core.geometry = coreGeometries[preset.shape]
        core.visible = !preset.planets && !preset.vga && !preset.folding && !preset.museumGallery
        bars.visible = !preset.vga && !preset.folding && !preset.museumGallery
        planetGroup.visible = preset.planets === true
        vgaPlane.visible = preset.vga === true
        rain.visible = preset.cityscape === true
        foldingGroup.visible = preset.folding === true
        museumGroup.visible = preset.museumGallery !== undefined
        if (preset.museumGallery !== undefined) {
            const gallery = preset.museumGallery === "os" ? MUSEUM_OS_PROFILES : MUSEUM_GAME_PROFILES
            museumScreens.forEach((screen, i) => {screen.profile = gallery[i % gallery.length]})
        }
        floorTint.set(preset.tint)
        starTint.set(preset.tint)
        scene.rotation.z = 0
        if (preset.vga) {
            vgaNextFlipAt = scheduleNextBalloon(performance.now())
            vgaFlipActive = false
        }
    }
    applyPreset(PRESETS[0])
    pushConsoleLine(`PRESET: ${PRESETS[0].name.toUpperCase()}`)
    presetSelect.addEventListener("change", () => {
        const preset = PRESETS.find(p => p.name === presetSelect.value)
        if (preset !== undefined) {
            applyPreset(preset)
            pushConsoleLine(`PRESET: ${preset.name.toUpperCase()}`)
        }
    })

    lifecycle.own(AnimationFrame.add(() => {
        if (element.closest("[hidden]") !== null) {return}
        if (!resize()) {return}
        player.getSpectrum(spectrum)
        const now = performance.now()
        const {bass, mid, treble, punch} = sampleBands(spectrum, now, audio)
        const seconds = now * 0.001
        const speedValueNow = speed.getValue()
        const reactivityValueNow = reactivity.getValue()
        const glowValueNow = glow.getValue()
        const preset = activePreset

        // Fog/world-tilt are shared scene state, so they're set uniformly for every preset
        // rather than needing a reset branch everywhere else.
        const fog = scene.fog as THREE.FogExp2
        fog.color.setHex(preset.cityscape ? 0x220022 : 0x020305)
        fog.density = preset.cityscape ? 0.045 : 0.022
        scene.rotation.z = preset.folding ? Math.sin(seconds * 0.1 * speedValueNow) * 0.12 * reactivityValueNow : 0

        const barScale = preset.barScale ?? 1
        if (!preset.vga && !preset.folding && !preset.museumGallery) {
            for (let index = 0; index < BAR_COUNT; index++) {
                const level = spectrum[barBins[index]] / 255
                // Sizes go wild: a steep curve plus a punch-driven overshoot, so quiet bars stay
                // low but a beat sends them shooting well past their steady-state height. "Neon
                // City" adds a fixed per-building bias on top, so it reads as a skyline, not an EQ.
                // barScale/coreScale (on the core below) vary the EQ-vs-object balance per preset.
                const base = preset.cityscape ? 0.3 + cityHeights[index] * 4.5 : 0.05
                const reactive = (preset.cityscape ? 4 : 10) * barScale
                const height = base + Math.pow(level, 1.6) * reactive * (0.5 + reactivityValueNow) + punch * 3.5 * reactivityValueNow * barScale
                const i = Math.floor(index / GRID_SIZE), j = index % GRID_SIZE
                const dx = i - half, dz = j - half
                dummy.position.set(dx * BAR_SPACING, height / 2 - 0.5, dz * BAR_SPACING)
                dummy.scale.set(1, Math.max(0.02, height), 1)
                dummy.updateMatrix()
                bars.setMatrixAt(index, dummy.matrix)
                const hue = (preset.hueBase + (barAngles[index] / (Math.PI * 2)) * preset.hueSpread + seconds * preset.hueSpeed * speedValueNow + 1) % 1
                const lightness = 0.08 + level * 0.65 + punch * 0.25 * reactivityValueNow
                bars.setColorAt(index, barColor.setHSL(hue, 0.9, Math.min(0.95, lightness)))
            }
            bars.instanceMatrix.needsUpdate = true
            if (bars.instanceColor) {bars.instanceColor.needsUpdate = true}
        }

        if (preset.cityscape) {
            const positions = rainGeometry.attributes.position.array as Float32Array
            const fallSpeed = (6 + bass * 4 * reactivityValueNow) * speedValueNow * (1 / 60)
            for (let i = 0; i < RAIN_COUNT; i++) {
                positions[i * 3 + 1] -= fallSpeed
                if (positions[i * 3 + 1] < 0) {positions[i * 3 + 1] = 14}
            }
            rainGeometry.attributes.position.needsUpdate = true
        }

        if (preset.folding) {
            const amplitude = 0.9 + bass * 1.4 * reactivityValueNow + punch * 1.0
            for (const {hinge, material, phase} of foldHinges) {
                hinge.rotation.x = Math.sin(seconds * 0.5 * speedValueNow + phase) * amplitude
                const hue = (preset.hueBase + phase * 0.1 + seconds * preset.hueSpeed) % 1
                material.color.setHSL(hue, 0.8, 0.5 + 0.2 * Math.sin(seconds + phase))
            }
            foldingGroup.rotation.y = seconds * 0.05 * speedValueNow
        }

        if (preset.museumGallery) {
            for (const screen of museumScreens) {
                const angle = screen.phase + seconds * screen.speed * speedValueNow
                screen.plane.position.set(
                    Math.cos(angle) * screen.radius,
                    screen.height + Math.sin(seconds * 0.3 + screen.phase) * 0.3,
                    Math.sin(angle) * screen.radius
                )
                screen.plane.rotation.y = -angle + Math.PI / 2
                screen.plane.rotation.z = Math.sin(seconds * 0.4 + screen.phase) * 0.15
                drawMuseumScreen(screen.ctx, MUSEUM_FB_WIDTH, MUSEUM_FB_HEIGHT, screen.profile, seconds)
                screen.texture.needsUpdate = true
            }
        }

        // Free spin vs static: the checkbox simply flips OrbitControls' autoRotate; a
        // drag/scroll/pinch still always takes over immediately either way.
        controls.autoRotate = spinInput.checked
        controls.autoRotateSpeed = 0.6 * speedValueNow + punch * 5 * reactivityValueNow
        controls.target.y = 1.2 + Math.sin(seconds * 0.2) * 0.3 * reactivityValueNow
        controls.update()

        if (preset.planets) {
            for (const planet of planets) {
                const level = spectrum[planet.bin] / 255
                const orbit = planet.mesh.userData.orbit as THREE.Group
                orbit.rotation.y = seconds * planet.speed * speedValueNow + planet.tilt
                planet.mesh.position.set(planet.radius * (1 + level * 0.15 * reactivityValueNow), 0, 0)
                const scale = 0.6 + level * 2.2 * reactivityValueNow + punch * 1.2
                planet.mesh.scale.setScalar(scale)
                const hue = (preset.hueBase + planet.tilt * 0.12 + seconds * preset.hueSpeed) % 1
                ;(planet.mesh.material as THREE.MeshBasicMaterial).color.setHSL(hue, 0.85, 0.3 + level * 0.5)
            }
        }

        if (preset.vga && vgaCtx !== null) {
            if (!vgaFlipActive && now >= vgaNextFlipAt) {triggerVgaFlip(now)}
            if (vgaFlipActive && now >= vgaFlipEnd) {
                vgaFlipActive = false
                vgaNextFlipAt = scheduleNextBalloon(now)
            }
            if (vgaFlipActive) {
                // Hanging-on-a-balloon sway plus a full 3D tumble while it's loose.
                const t = (now - vgaFlipStart) * 0.001
                vgaPlane.position.x = vgaRestPosition.x + Math.sin(t * 0.9) * 1.1
                vgaPlane.position.y = vgaRestPosition.y + Math.sin(t * 1.3) * 0.5 + 0.3
                vgaPlane.position.z = vgaRestPosition.z + Math.cos(t * 0.7) * 1.1
                vgaPlane.rotation.y = t * 1.1 * speedValueNow
                vgaPlane.rotation.x = Math.sin(t * 0.6) * 0.6
                vgaPlane.rotation.z = Math.sin(t * 0.4) * 0.3
            } else {
                // Drift gently back to resting flat whenever it's not actively flipping.
                vgaPlane.position.lerp(vgaRestPosition, 0.08)
                vgaPlane.rotation.x *= 0.9
                vgaPlane.rotation.y *= 0.9
                vgaPlane.rotation.z *= 0.9
            }

            vgaCtx.fillStyle = VGA_PALETTE[1]
            vgaCtx.fillRect(0, 0, FB_WIDTH, FB_HEIGHT)
            vgaCtx.strokeStyle = VGA_PALETTE[14]
            vgaCtx.lineWidth = 2
            vgaCtx.strokeRect(3, 3, FB_WIDTH - 6, FB_HEIGHT - 6)
            vgaCtx.strokeStyle = VGA_PALETTE[15]
            vgaCtx.lineWidth = 1
            vgaCtx.strokeRect(7, 7, FB_WIDTH - 14, FB_HEIGHT - 14)

            vgaCtx.textBaseline = "top"
            vgaCtx.textAlign = "center"
            vgaCtx.font = "bold 12px ui-monospace, Menlo, Consolas, monospace"
            vgaCtx.fillStyle = VGA_PALETTE[14]
            vgaCtx.fillText("P R O T R A C K E R +   4 . 2 B", FB_WIDTH / 2, 14)
            vgaCtx.font = "9px ui-monospace, Menlo, Consolas, monospace"
            vgaCtx.fillStyle = VGA_PALETTE[11]
            vgaCtx.fillText("- V G A   T R I B U T E   S C R E E N -", FB_WIDTH / 2, 28)

            const status = player.currentStatus
            const playing = player.playing.getValue()
            vgaCtx.font = "9px ui-monospace, Menlo, Consolas, monospace"
            vgaCtx.fillStyle = playing ? VGA_PALETTE[10] : VGA_PALETTE[7]
            vgaCtx.fillText(playing ? "** PLAYING **" : "** STANDBY **", FB_WIDTH / 2, 40)
            vgaCtx.fillStyle = VGA_PALETTE[7]
            const info = isDefined(status)
                ? `POS ${status.pos.toString().padStart(2, "0")}  PAT ${status.pattern.toString().padStart(2, "0")}  ROW ${status.row.toString().padStart(2, "0")}  SPD ${status.speed}/${status.tempo}  ${formatElapsed(player.elapsedMs)}`
                : "LOAD A MODULE AND PRESS PLAY"
            vgaCtx.fillText(info, FB_WIDTH / 2, 51)

            const cycleSpeed = 6 * speedValueNow * (1 + bass * reactivityValueNow)
            vgaCycle.value = (vgaCycle.value + cycleSpeed * (1 / 60)) % VGA_PALETTE.length
            const barY = 62, barHeight = 10, swatches = 16
            const swatchWidth = (FB_WIDTH - 16) / swatches
            for (let i = 0; i < swatches; i++) {
                const index = Math.floor((i + vgaCycle.value) % VGA_PALETTE.length)
                vgaCtx.fillStyle = VGA_PALETTE[index]
                vgaCtx.fillRect(8 + i * swatchWidth, barY, Math.ceil(swatchWidth), barHeight)
            }
            vgaCtx.strokeStyle = VGA_PALETTE[0]
            vgaCtx.lineWidth = 1
            vgaCtx.strokeRect(8, barY, FB_WIDTH - 16, barHeight)

            const playAreaTop = barY + barHeight + 10
            const playAreaBottom = FB_HEIGHT - 26
            const baseRadius = 11
            const moveSpeed = speedValueNow * (1 + bass * 0.6 * reactivityValueNow)
            vgaBounce.x += vgaBounce.vx * moveSpeed
            vgaBounce.y += vgaBounce.vy * moveSpeed
            let bounced = false
            if (vgaBounce.x - baseRadius < 10) {vgaBounce.x = 10 + baseRadius; vgaBounce.vx = Math.abs(vgaBounce.vx); bounced = true}
            if (vgaBounce.x + baseRadius > FB_WIDTH - 10) {vgaBounce.x = FB_WIDTH - 10 - baseRadius; vgaBounce.vx = -Math.abs(vgaBounce.vx); bounced = true}
            if (vgaBounce.y - baseRadius < playAreaTop) {vgaBounce.y = playAreaTop + baseRadius; vgaBounce.vy = Math.abs(vgaBounce.vy); bounced = true}
            if (vgaBounce.y + baseRadius > playAreaBottom) {vgaBounce.y = playAreaBottom - baseRadius; vgaBounce.vy = -Math.abs(vgaBounce.vy); bounced = true}
            if (bounced) {vgaBounce.colorIndex = (vgaBounce.colorIndex + 1) % VGA_BOUNCE_COLORS.length; vgaBounce.pulse = 1}
            vgaBounce.pulse *= 0.9
            const radius = baseRadius * (1 + vgaBounce.pulse * 0.6 + punch * 1.2 * reactivityValueNow)
            drawVgaDiamond(vgaCtx, vgaBounce.x, vgaBounce.y, radius, VGA_PALETTE[VGA_BOUNCE_COLORS[vgaBounce.colorIndex]])
            vgaCtx.strokeStyle = VGA_PALETTE[15]
            vgaCtx.lineWidth = 1
            vgaCtx.beginPath()
            vgaCtx.moveTo(vgaBounce.x, vgaBounce.y - radius)
            vgaCtx.lineTo(vgaBounce.x + radius, vgaBounce.y)
            vgaCtx.lineTo(vgaBounce.x, vgaBounce.y + radius)
            vgaCtx.lineTo(vgaBounce.x - radius, vgaBounce.y)
            vgaCtx.closePath()
            vgaCtx.stroke()

            const twinkleCount = 40
            for (let i = 0; i < twinkleCount; i++) {
                const seedVal = i * 97.31
                const x = 12 + ((seedVal * 13.7 + seconds * 4 * speedValueNow) % (FB_WIDTH - 24))
                const y = playAreaTop + ((seedVal * 7.3) % (playAreaBottom - playAreaTop))
                const flicker = (Math.sin(seconds * 3 + i) + 1) / 2
                if (flicker > 0.6 - treble * reactivityValueNow * 0.3) {
                    vgaCtx.fillStyle = VGA_PALETTE[8 + (i % 8)]
                    vgaCtx.fillRect(Math.floor(x), Math.floor(y), 1, 1)
                }
            }

            const scrollSpeed = 40 * speedValueNow * (1 + punch * reactivityValueNow)
            vgaCtx.font = "11px ui-monospace, Menlo, Consolas, monospace"
            const measuredWidth = vgaCtx.measureText(VGA_SCROLLTEXT).width
            const loopWidth = measuredWidth + FB_WIDTH
            const x0 = FB_WIDTH - ((seconds * scrollSpeed) % loopWidth)
            vgaCtx.textAlign = "left"
            vgaCtx.fillStyle = VGA_PALETTE[0]
            vgaCtx.fillRect(6, FB_HEIGHT - 22, FB_WIDTH - 12, 14)
            vgaCtx.strokeStyle = VGA_PALETTE[6]
            vgaCtx.strokeRect(6, FB_HEIGHT - 22, FB_WIDTH - 12, 14)
            vgaCtx.save()
            vgaCtx.beginPath()
            vgaCtx.rect(8, FB_HEIGHT - 22, FB_WIDTH - 16, 14)
            vgaCtx.clip()
            vgaCtx.fillStyle = VGA_PALETTE[14]
            vgaCtx.fillText(VGA_SCROLLTEXT, x0, FB_HEIGHT - 20)
            vgaCtx.fillText(VGA_SCROLLTEXT, x0 - loopWidth, FB_HEIGHT - 20)
            vgaCtx.restore()

            vgaCtx.fillStyle = "rgba(0, 0, 0, 0.22)"
            for (let y = 0; y < FB_HEIGHT; y += 2) {vgaCtx.fillRect(0, y, FB_WIDTH, 1)}

            vgaTexture.needsUpdate = true
        } else {
            core.rotation.x = seconds * 0.4 * speedValueNow
            core.rotation.y = seconds * 0.6 * speedValueNow
            // Wild core pulse: bass alone nearly doubles it, a punch hit can triple it briefly.
            // coreScale (preset data, not the local pulse below) sets the base EQ-vs-object balance.
            const coreScale = (preset.coreScale ?? 1) * (1 + bass * 1.6 * reactivityValueNow + punch * 1.4)
            core.scale.setScalar(coreScale)
            ;(core.material as THREE.MeshBasicMaterial).color.setHSL((preset.hueBase + (seconds * preset.hueSpeed) % preset.hueSpread) % 1, 0.8, 0.65)
        }

        axisGroup.rotation.y = seconds * 0.05 * speedValueNow
        stars.rotation.y = seconds * 0.01 * speedValueNow
        stars.rotation.x = Math.sin(seconds * 0.03) * 0.1

        bloomPass.strength = (1.3 + punch * 2 * reactivityValueNow + treble * 0.4) * glowValueNow
        ;(floorGrid.material as THREE.Material).opacity = 0.25 + mid * 0.5 * reactivityValueNow

        const status = player.currentStatus
        stateLine.value = player.playing.getValue() ? "PLAYING" : "STANDBY"
        statusLine.value = isDefined(status)
            ? `POS ${status.pos.toString().padStart(2, "0")}  PAT ${status.pattern.toString().padStart(2, "0")}  ROW ${status.row.toString().padStart(2, "0")}`
            : "LOAD A MODULE AND PRESS PLAY"

        if (!consoleEl.hidden) {
            if (punch > 0.55 && now - lastPunchLogAt > 400) {
                lastPunchLogAt = now
                pushConsoleLine("PUNCH!")
            }
            if (now - lastConsoleStatAt > 2000) {
                lastConsoleStatAt = now
                pushConsoleLine(`BASS ${bass.toFixed(2)}  MID ${mid.toFixed(2)}  TREB ${treble.toFixed(2)}  BARS ${BAR_COUNT}`)
            }
        }

        composer.render()
    }))

    lifecycle.own(Terminable.create(() => {
        barGeometry.dispose()
        barMaterial.dispose()
        Object.values(coreGeometries).forEach(geometry => geometry.dispose())
        coreMaterial.dispose()
        planetGeometry.dispose()
        planets.forEach(planet => (planet.mesh.material as THREE.MeshBasicMaterial).dispose())
        vgaGeometry.dispose()
        vgaMaterial.dispose()
        vgaTexture.dispose()
        rainGeometry.dispose()
        rainMaterial.dispose()
        foldGeometry.dispose()
        foldHinges.forEach(({material}) => material.dispose())
        museumGeometry.dispose()
        museumScreens.forEach(screen => {
            screen.material.dispose()
            screen.texture.dispose()
        })
        starGeometry.dispose()
        ;(stars.material as THREE.PointsMaterial).dispose()
        ;(floorGrid.material as THREE.Material).dispose()
        floorGrid.geometry.dispose()
        axisGroup.children.forEach(child => {
            const line = child as THREE.Line
            line.geometry.dispose()
            ;(line.material as THREE.Material).dispose()
        })
        composer.dispose()
        renderer.dispose()
    }))

    return element
}
