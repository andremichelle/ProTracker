import css from "./Visualizer3D.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {AudioState, sampleBands} from "@/ui/audioReactive"
import {
    drawMatrixRain, matrixChars, ramp, SizeId, SizePreset, SIZE_OPTIONS, SIZE_PRESETS, ThemeId, THEME_OPTIONS
} from "@/ui/visualizerTheme"

const className = Html.adoptStyleSheet(css, "Visualizer3D")

type Vec3 = readonly [number, number, number]
type Triangle = readonly [Vec3, Vec3, Vec3]

// ---- Shape geometry: each shape is just a flat list of triangles (no shared vertex indexing),
// so adding a new shape only means producing a new Triangle[] and registering it below.

const PHI = (1 + Math.sqrt(5)) / 2
const normalizeVertex = ([x, y, z]: Vec3): Vec3 => {
    const length = Math.hypot(x, y, z)
    return [x / length, y / length, z / length]
}
const buildIcosahedron = (): ReadonlyArray<Triangle> => {
    const rawVertices: ReadonlyArray<Vec3> = [
        [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
        [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
        [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]
    ]
    const vertices = rawVertices.map(normalizeVertex)
    // Standard icosahedron triangulation (20 faces, CCW winding seen from outside).
    const faces: ReadonlyArray<readonly [number, number, number]> = [
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
        [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
        [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
        [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]
    ]
    return faces.map(([ia, ib, ic]) => [vertices[ia], vertices[ib], vertices[ic]] as Triangle)
}

const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
const subdivideTetra = (tetra: readonly [Vec3, Vec3, Vec3, Vec3], depth: number): ReadonlyArray<readonly [Vec3, Vec3, Vec3, Vec3]> => {
    if (depth === 0) {return [tetra]}
    const [p0, p1, p2, p3] = tetra
    const m01 = mid(p0, p1), m02 = mid(p0, p2), m03 = mid(p0, p3)
    const m12 = mid(p1, p2), m13 = mid(p1, p3), m23 = mid(p2, p3)
    const corners: ReadonlyArray<readonly [Vec3, Vec3, Vec3, Vec3]> = [
        [p0, m01, m02, m03], [p1, m01, m12, m13], [p2, m02, m12, m23], [p3, m03, m13, m23]
    ]
    return corners.flatMap(corner => subdivideTetra(corner, depth - 1))
}
const buildSierpinskiTetrahedron = (): ReadonlyArray<Triangle> => {
    const base: readonly [Vec3, Vec3, Vec3, Vec3] = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]]
    const tetras = subdivideTetra(base, 2)
    const triangles = tetras.flatMap(([p0, p1, p2, p3]): Triangle[] => [
        [p0, p1, p2], [p0, p1, p3], [p0, p2, p3], [p1, p2, p3]
    ])
    const maxLength = triangles.reduce((max, tri) =>
        tri.reduce((innerMax, v) => Math.max(innerMax, Math.hypot(v[0], v[1], v[2])), max), 0)
    return triangles.map(tri => tri.map(v => [v[0] / maxLength, v[1] / maxLength, v[2] / maxLength] as Vec3) as unknown as Triangle)
}

const subdivideSphereTriangle = (triangle: Triangle, depth: number): ReadonlyArray<Triangle> => {
    if (depth === 0) {return [triangle]}
    const [a, b, c] = triangle
    const ab = normalizeVertex(mid(a, b))
    const bc = normalizeVertex(mid(b, c))
    const ca = normalizeVertex(mid(c, a))
    return [
        ...subdivideSphereTriangle([a, ab, ca], depth - 1),
        ...subdivideSphereTriangle([ab, b, bc], depth - 1),
        ...subdivideSphereTriangle([ca, bc, c], depth - 1),
        ...subdivideSphereTriangle([ab, bc, ca], depth - 1)
    ]
}
const buildGlobe = (): ReadonlyArray<Triangle> => buildIcosahedron().flatMap(triangle => subdivideSphereTriangle(triangle, 1))

const cuboidTriangles = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): ReadonlyArray<Triangle> => {
    const a: Vec3 = [x0, y0, z0], b: Vec3 = [x1, y0, z0], c: Vec3 = [x1, y1, z0], d: Vec3 = [x0, y1, z0]
    const e: Vec3 = [x0, y0, z1], f: Vec3 = [x1, y0, z1], g: Vec3 = [x1, y1, z1], h: Vec3 = [x0, y1, z1]
    return [
        [a, b, c], [a, c, d], // back
        [f, e, h], [f, h, g], // front
        [e, a, d], [e, d, h], // left
        [b, f, g], [b, g, c], // right
        [d, c, g], [d, g, h], // top
        [e, f, b], [e, b, a]  // bottom
    ]
}
// A single row of audio-driven bars, like a classic 3D spectrum-analyzer display.
const EQUALIZER_BARS = 14
const buildEqualizer = (spectrum: Uint8Array, reactivity: number): ReadonlyArray<Triangle> => {
    const halfWidth = (2 / EQUALIZER_BARS) * 0.4
    const bars: Triangle[] = []
    for (let i = 0; i < EQUALIZER_BARS; i++) {
        const cx = -1 + (i + 0.5) * (2 / EQUALIZER_BARS)
        const bin = 8 + i * 8
        const amplitude = Math.min(1, (spectrum[bin] / 255) * (0.6 + 0.9 * reactivity))
        const top = -1 + amplitude * 2.2
        bars.push(...cuboidTriangles(cx - halfWidth, cx + halfWidth, -1, top, -halfWidth, halfWidth))
    }
    return bars
}

export type ShapeId = "icosahedron" | "fractal" | "globe" | "equalizer"
const SHAPES: Record<Exclude<ShapeId, "equalizer">, ReadonlyArray<Triangle>> = {
    icosahedron: buildIcosahedron(),
    fractal: buildSierpinskiTetrahedron(),
    globe: buildGlobe()
}
// Only convex, consistently-wound shapes benefit from backface culling; the
// equalizer's many independent boxes aren't guaranteed consistent winding,
// so it relies purely on the depth test instead.
const SHAPE_CULL: Record<ShapeId, boolean> = {icosahedron: true, fractal: true, globe: true, equalizer: false}
export const SHAPE_OPTIONS: ReadonlyArray<{ id: ShapeId, label: string }> = [
    {id: "icosahedron", label: "Icosahedron"},
    {id: "fractal", label: "Sierpinski Fractal"},
    {id: "globe", label: "Globe"},
    {id: "equalizer", label: "3D Equalizer"}
]

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 =>
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const normalize = (v: Vec3): Vec3 => {
    const length = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / length, v[1] / length, v[2] / length]
}
const rotate = ([x, y, z]: Vec3, angleX: number, angleY: number): Vec3 => {
    const y1 = y * Math.cos(angleX) - z * Math.sin(angleX)
    const z1 = y * Math.sin(angleX) + z * Math.cos(angleX)
    const x2 = x * Math.cos(angleY) + z1 * Math.sin(angleY)
    const z2 = -x * Math.sin(angleY) + z1 * Math.cos(angleY)
    return [x2, y1, z2]
}
const edge = (x0: number, y0: number, x1: number, y1: number, px: number, py: number): number =>
    (px - x0) * (y1 - y0) - (py - y0) * (x1 - x0)

type Controls = {
    speed: DefaultObservableValue<number>
    reactivity: DefaultObservableValue<number>
    shape: DefaultObservableValue<ShapeId>
    theme: DefaultObservableValue<ThemeId>
}

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

const draw = (screen: HTMLPreElement, size: SizePreset, spectrum: Uint8Array, player: Player,
              time: number, audio: AudioState, controls: Controls): void => {
    const columns = Math.max(40, Math.min(160, Math.floor(screen.clientWidth / size.cellWidth)))
    const rows = Math.max(16, Math.min(60, Math.floor(screen.clientHeight / (size.fontSizeRem * 16 * 1.13))))
    const art = Array.from({length: rows}, () => Array(columns).fill(" ") as string[])
    const depth = Array.from({length: rows}, () => Array(columns).fill(Infinity) as number[])
    const write = (row: number, column: number, text: string): void => {
        if (row < 0 || row >= rows || column >= columns) {return}
        for (let index = 0; index < text.length && column + index < columns; index++) {
            art[row][column + index] = text[index]
        }
    }
    const horizontal = `+${"-".repeat(columns - 2)}+`
    for (let row = 0; row < rows; row++) {
        art[row][0] = "|"
        art[row][columns - 1] = "|"
    }
    write(0, 0, horizontal)

    const {bass, mid, treble, punch} = sampleBands(spectrum, time, audio)

    const reactivity = controls.reactivity.getValue()
    const speedBase = controls.speed.getValue()
    const shapeId = controls.shape.getValue()
    const themeId = controls.theme.getValue()
    const activeRamp = themeId === "matrix" ? matrixChars : ramp

    const status = player.currentStatus
    const state = player.playing.getValue() ? "PLAYING" : "STANDBY"
    write(0, 2, ` PROTRACKER+ 4.2B  /  BB-STYLE ASCII 3D  /  ${state} `)

    const plotTop = 1
    const plotBottom = rows - 2
    const plotWidth = columns - 2
    const plotHeight = plotBottom - plotTop + 1
    const cx = 1 + plotWidth / 2
    const cy = plotTop + plotHeight / 2
    const seconds = time * 0.001
    const spin = speedBase * (0.25 + (bass + punch * 1.5) * 1.4 * reactivity)
    // The equalizer is a bar chart, not a solid to tumble — a fixed tilt plus a slow yaw
    // keeps it readable while still feeling 3D; other shapes get the full reactive spin.
    const angleX = shapeId === "equalizer" ? 0.5 : seconds * 0.6 * spin
    const angleY = shapeId === "equalizer" ? seconds * 0.15 * speedBase : seconds * 0.9 * spin
    const dist = 3.0
    const pulse = 1 + (bass * 0.3 + punch * 0.4) * reactivity
    const scale = Math.min(plotWidth * 0.42, plotHeight * 0.78) * pulse
    const aspect = 0.52
    // Light direction wobbles with mid-band energy so shading stays alive even at rest.
    const lightDir = normalize([
        0.5 + Math.sin(seconds * 1.3) * mid * 0.6 * reactivity,
        -0.6 + Math.cos(seconds * 0.9) * mid * 0.4 * reactivity,
        0.9
    ])

    // Matrix theme: digital-rain background, drawn before the shape so it shows through gaps.
    if (themeId === "matrix") {
        drawMatrixRain(art, columns, plotTop, plotBottom, seconds, speedBase)
    }

    const cull = SHAPE_CULL[shapeId]
    const baseTriangles = shapeId === "equalizer" ? buildEqualizer(spectrum, reactivity) : SHAPES[shapeId]
    const spikeEnabled = shapeId === "icosahedron"
    const camTriangles = baseTriangles.map((triangle, triIndex) => {
        return triangle.map((v, vertIndex) => {
            let point = v
            if (spikeEnabled) {
                const bin = 18 + ((triIndex * 3 + vertIndex) * 7) % 110
                const spike = (spectrum[bin] / 255) * mid * 0.9 * reactivity
                point = [point[0] * (1 + spike), point[1] * (1 + spike), point[2] * (1 + spike)]
            }
            return rotate(point, angleX, angleY)
        }) as unknown as Triangle
    })
    const projected = camTriangles.map(triangle => triangle.map(v => {
        const factor = dist / (dist - v[2])
        return [cx + v[0] * scale * factor, cy + v[1] * scale * factor * aspect] as const
    }))
    const items = camTriangles
        .map((triangle, index) => {
            const [a, b, c] = triangle
            const normal = normalize(cross(sub(b, a), sub(c, a)))
            const avgZ = (a[2] + b[2] + c[2]) / 3
            return {index, normal, avgZ}
        })
        .filter(item => !cull || item.normal[2] > 0)
        .sort((p, q) => p.avgZ - q.avgZ)

    for (const item of items) {
        const [pa, pb, pc] = projected[item.index]
        const luminance = Math.min(1, Math.max(0, dot(item.normal, lightDir)) + punch * 0.6)
        const glyph = activeRamp[Math.min(activeRamp.length - 1, Math.floor(luminance * (activeRamp.length - 1)))]
        const minX = Math.max(1, Math.floor(Math.min(pa[0], pb[0], pc[0])))
        const maxX = Math.min(columns - 2, Math.ceil(Math.max(pa[0], pb[0], pc[0])))
        const minY = Math.max(plotTop, Math.floor(Math.min(pa[1], pb[1], pc[1])))
        const maxY = Math.min(plotBottom, Math.ceil(Math.max(pa[1], pb[1], pc[1])))
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const w0 = edge(pa[0], pa[1], pb[0], pb[1], x, y)
                const w1 = edge(pb[0], pb[1], pc[0], pc[1], x, y)
                const w2 = edge(pc[0], pc[1], pa[0], pa[1], x, y)
                const inside = (w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)
                if (inside && item.avgZ < depth[y][x]) {
                    depth[y][x] = item.avgZ
                    art[y][x] = glyph
                }
            }
        }
    }

    if (themeId !== "matrix") {
        // Sparse treble-reactive starfield, homage to the classic bb demo background.
        const starCount = Math.floor(plotWidth * plotHeight * 0.01 * (0.3 + treble * reactivity))
        for (let index = 0; index < starCount; index++) {
            const x = 1 + Math.floor((index * 97 + Math.floor(seconds * 24 * speedBase)) % plotWidth)
            const y = plotTop + Math.floor((index * 53 + Math.floor(seconds * 11 * speedBase)) % plotHeight)
            if (art[y][x] === " ") {art[y][x] = treble > 0.5 ? "." : " "}
        }
    }

    write(rows - 1, 0, `+${"-".repeat(columns - 2)}+`)
    const label = isDefined(status)
        ? ` POS ${status.pos.toString().padStart(2, "0")}  PAT ${status.pattern.toString().padStart(2, "0")}  BASS ${(bass * 100).toFixed(0)}% `
        : " LOAD A MODULE AND PRESS PLAY "
    write(rows - 1, 2, label)
    screen.textContent = art.map(line => line.join("")).join("\n")
}

export const Visualizer3D = ({lifecycle, player}: Construct) => {
    const screen: HTMLPreElement = <pre role="img" aria-label="Music-reactive rotating 3D ASCII art"/>
    const speed = lifecycle.own(new DefaultObservableValue(1))
    const reactivity = lifecycle.own(new DefaultObservableValue(1))
    const shape = lifecycle.own(new DefaultObservableValue<ShapeId>("icosahedron"))
    const theme = lifecycle.own(new DefaultObservableValue<ThemeId>("classic"))
    let sizePreset = SIZE_PRESETS.normal

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
    const shapeSelect: HTMLSelectElement = (
        <select onchange={() => shape.setValue(shapeSelect.value as ShapeId)}>
            {SHAPE_OPTIONS.map(option => <option value={option.id}>{option.label}</option>)}
        </select>
    )
    const themeSelect: HTMLSelectElement = (
        <select onchange={() => {
            const id = themeSelect.value as ThemeId
            theme.setValue(id)
            element.classList.remove("theme-classic", "theme-matrix", "theme-amber")
            element.classList.add(`theme-${id}`)
        }}>
            {THEME_OPTIONS.map(option => <option value={option.id}>{option.label}</option>)}
        </select>
    )
    const sizeSelect: HTMLSelectElement = (
        <select onchange={() => {
            const id = sizeSelect.value as SizeId
            sizePreset = SIZE_PRESETS[id]
            screen.style.fontSize = `${sizePreset.fontSizeRem}rem`
        }}>
            {SIZE_OPTIONS.map(option => <option value={option.id} selected={option.id === "normal"}>{option.label}</option>)}
        </select>
    )
    const controlsBar: HTMLDivElement = (
        <div className="controls">
            <label>Speed {speedInput} {speedValue}</label>
            <label>Reactivity {reactivityInput} {reactivityValue}</label>
            <label>Shape {shapeSelect}</label>
            <label>Theme {themeSelect}</label>
            <label>Size {sizeSelect}</label>
        </div>
    )
    const element: HTMLDivElement = <div className={`${className} theme-classic`}>{controlsBar}{screen}</div>
    const spectrum = new Uint8Array(256)
    const audio: AudioState = {lastTime: performance.now(), bassEnvelope: 0, punch: 0}
    lifecycle.own(AnimationFrame.add(() => {
        if (element.closest("[hidden]") !== null || element.clientWidth === 0) {return}
        player.getSpectrum(spectrum)
        draw(screen, sizePreset, spectrum, player, performance.now(), audio, {speed, reactivity, shape, theme})
    }))
    return element
}
