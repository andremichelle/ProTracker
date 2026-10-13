import css from "./Visualizer.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {AudioState, sampleBands} from "@/ui/audioReactive"
import {
    drawMatrixRain, matrixChars, ramp, SizeId, SizePreset, SIZE_OPTIONS, SIZE_PRESETS, ThemeId, THEME_OPTIONS
} from "@/ui/visualizerTheme"

const className = Html.adoptStyleSheet(css, "Visualizer")

export type ModeId = "spectrum" | "oscilloscope" | "vumeter"
export const MODE_OPTIONS: ReadonlyArray<{ id: ModeId, label: string }> = [
    {id: "spectrum", label: "Spectrum"},
    {id: "oscilloscope", label: "Oscilloscope"},
    {id: "vumeter", label: "VU Meters"}
]

const VU_BARS = 24
const VU_SEGMENTS = 14

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

type Controls = {
    speed: DefaultObservableValue<number>
    reactivity: DefaultObservableValue<number>
    mode: DefaultObservableValue<ModeId>
    theme: DefaultObservableValue<ThemeId>
}

const drawFrame = (write: (row: number, column: number, text: string) => void, columns: number, rows: number): void => {
    const horizontal = `+${"-".repeat(columns - 2)}+`
    for (let row = 0; row < rows; row++) {write(row, 0, "|"); write(row, columns - 1, "|")}
    write(0, 0, horizontal)
    write(rows - 1, 0, horizontal)
}

const drawSpectrum = (art: string[][], activeRamp: string, spectrum: Uint8Array, plotTop: number, plotBottom: number,
                       plotWidth: number, seconds: number, speedBase: number, reactivity: number, bass: number): void => {
    const plotHeight = plotBottom - plotTop + 1
    const center = plotTop + Math.floor(plotHeight * 0.42)
    const barRows = plotBottom - center
    const phase = seconds * 1000 * (0.00045 + bass * reactivity * 0.002)
    for (let x = 0; x < plotWidth; x++) {
        const position = x / Math.max(1, plotWidth - 1)
        const bin = Math.floor(Math.pow(position, 1.65) * 180)
        const level = spectrum[bin] / 255
        const amplitude = level * Math.max(1, center - plotTop - 1)
        const wave = center + Math.sin(x * 0.19 + phase) * amplitude
        const waveRow = Math.round(wave)
        const glyph = activeRamp[Math.min(activeRamp.length - 1, Math.floor(level * (activeRamp.length - 1)))]
        if (level > 0.04 && waveRow >= plotTop && waveRow <= plotBottom) {art[waveRow][x + 2] = glyph}
        const barHeight = Math.round(level * barRows * (0.6 + 0.6 * reactivity))
        for (let y = 0; y < barHeight && y < barRows; y++) {
            const glyphIndex = Math.min(activeRamp.length - 1, Math.floor((y + 1) / barRows * (activeRamp.length - 1)))
            art[plotBottom - y][x + 2] = activeRamp[glyphIndex]
        }
    }
    for (let index = 0; index < Math.floor(plotWidth / 6); index++) {
        const x = 2 + (index * 17 + Math.floor(seconds * 1000 / 180 * speedBase)) % plotWidth
        const y = plotTop + (index * 11 + Math.floor(seconds * 1000 / 320 * speedBase)) % Math.max(1, plotHeight - 1)
        if (art[y][x] === " ") {art[y][x] = "."}
    }
}

// A classic scrolling dual trace: bass on top, treble below, like an oscilloscope's Y input.
const drawOscilloscope = (art: string[][], activeRamp: string, spectrum: Uint8Array, plotTop: number, plotBottom: number,
                           plotWidth: number, seconds: number, reactivity: number): void => {
    const plotHeight = plotBottom - plotTop + 1
    const laneHeight = plotHeight / 2
    const bassCenter = plotTop + Math.floor(laneHeight * 0.5)
    const trebleCenter = plotTop + Math.floor(laneHeight * 1.5)
    const glyph = activeRamp[Math.floor(activeRamp.length * 0.75)]
    for (let x = 0; x < plotWidth; x++) {
        const t = x / Math.max(1, plotWidth - 1)
        const bassBin = Math.floor(t * 24)
        const bassLevel = (spectrum[bassBin] / 255 - 0.5) * 2
        const bassY = Math.round(bassCenter + bassLevel * laneHeight * 0.45 * (0.5 + reactivity * 0.6) * Math.sin(t * Math.PI * 6 + seconds * 2))
        const trebleBin = 96 + Math.floor(t * 64)
        const trebleLevel = (spectrum[trebleBin] / 255 - 0.5) * 2
        const trebleY = Math.round(trebleCenter + trebleLevel * laneHeight * 0.45 * (0.5 + reactivity * 0.6) * Math.sin(t * Math.PI * 10 - seconds * 3))
        if (bassY >= plotTop && bassY <= plotBottom) {art[bassY][x + 2] = glyph}
        if (trebleY >= plotTop && trebleY <= plotBottom) {art[trebleY][x + 2] = glyph}
    }
    const dashRow = plotTop + Math.floor(laneHeight)
    for (let x = 0; x < plotWidth; x += 2) {
        if (art[dashRow][x + 2] === " ") {art[dashRow][x + 2] = "-"}
    }
}

// Classic hardware-style segmented bars with slow-decaying peak-hold markers.
const drawVuMeters = (art: string[][], activeRamp: string, spectrum: Uint8Array, plotTop: number, plotBottom: number,
                       plotWidth: number, reactivity: number, peaks: Float32Array, dt: number): void => {
    const barCount = Math.min(VU_BARS, Math.max(6, Math.floor(plotWidth / 3)))
    const barWidth = Math.max(1, Math.floor(plotWidth / barCount) - 1)
    for (let i = 0; i < barCount; i++) {
        const bin = Math.floor(Math.pow(i / Math.max(1, barCount - 1), 1.4) * 200)
        const level = Math.min(1, (spectrum[bin] / 255) * (0.6 + 0.8 * reactivity))
        peaks[i] = Math.max(level, peaks[i] - dt * 0.6)
        const segments = Math.round(level * VU_SEGMENTS)
        const peakSegment = Math.round(peaks[i] * VU_SEGMENTS)
        const x0 = 2 + i * (barWidth + 1)
        for (let s = 0; s < VU_SEGMENTS; s++) {
            const y = plotBottom - s
            if (y < plotTop) {continue}
            let glyph = " "
            if (s < segments) {
                const intensity = s / VU_SEGMENTS
                glyph = activeRamp[Math.min(activeRamp.length - 1, Math.floor((0.4 + intensity * 0.6) * (activeRamp.length - 1)))]
            } else if (s === peakSegment) {
                glyph = activeRamp[activeRamp.length - 1]
            }
            for (let w = 0; w < barWidth; w++) {
                if (x0 + w < plotWidth + 2) {art[y][x0 + w] = glyph}
            }
        }
    }
}

const draw = (screen: HTMLPreElement, size: SizePreset, spectrum: Uint8Array, player: Player,
              time: number, audio: AudioState, peaks: Float32Array, controls: Controls): void => {
    const columns = Math.max(48, Math.min(160, Math.floor(screen.clientWidth / size.cellWidth)))
    const rows = Math.max(18, Math.min(60, Math.floor(screen.clientHeight / (size.fontSizeRem * 16 * 1.13))))
    const art = Array.from({length: rows}, () => Array(columns).fill(" ") as string[])
    const write = (row: number, column: number, text: string): void => {
        if (row < 0 || row >= rows || column >= columns) {return}
        for (let index = 0; index < text.length && column + index < columns; index++) {
            art[row][column + index] = text[index]
        }
    }
    drawFrame(write, columns, rows)

    const dtRaw = Math.min(0.1, Math.max(0, (time - audio.lastTime) / 1000))
    const {bass, treble} = sampleBands(spectrum, time, audio)

    const reactivity = controls.reactivity.getValue()
    const speedBase = controls.speed.getValue()
    const modeId = controls.mode.getValue()
    const themeId = controls.theme.getValue()
    const activeRamp = themeId === "matrix" ? matrixChars : ramp
    const seconds = time * 0.001 * speedBase

    const status = player.currentStatus
    const position = isDefined(status) ? status.pos.toString().padStart(2, "0") : "--"
    const pattern = isDefined(status) ? status.pattern.toString().padStart(2, "0") : "--"
    const row = isDefined(status) ? status.row.toString().padStart(2, "0") : "--"
    const state = player.playing.getValue() ? "PLAYING" : "STANDBY"
    const modeLabel = MODE_OPTIONS.find(option => option.id === modeId)?.label ?? "Spectrum"
    write(1, 2, ` PROTRACKER+ 4.2B  /  PAULA ASCII ${modeLabel.toUpperCase()} `)
    write(2, 2, ` ${state}  POS ${position}  PAT ${pattern}  ROW ${row} `)
    write(3, 0, `+${"-".repeat(columns - 2)}+`)

    const plotTop = 4
    const plotBottom = rows - 4
    const plotWidth = columns - 4

    if (themeId === "matrix" && modeId !== "vumeter") {
        drawMatrixRain(art, columns, plotTop, plotBottom, seconds, speedBase)
    }

    if (modeId === "spectrum") {
        drawSpectrum(art, activeRamp, spectrum, plotTop, plotBottom, plotWidth, seconds, speedBase, reactivity, bass)
    } else if (modeId === "oscilloscope") {
        drawOscilloscope(art, activeRamp, spectrum, plotTop, plotBottom, plotWidth, seconds, reactivity)
    } else {
        drawVuMeters(art, activeRamp, spectrum, plotTop, plotBottom, plotWidth, reactivity, peaks, dtRaw)
    }

    write(rows - 3, 2, " FREQ  0HZ  ------------------------ 24KHZ ")
    write(rows - 2, 2, bass + treble > 0.015
        ? " PAULA / LIVE MIX / SIGNAL LOCKED "
        : " LOAD A MODULE AND PRESS PLAY ")
    screen.textContent = art.map(line => line.join("")).join("\n")
}

export const Visualizer = ({lifecycle, player}: Construct) => {
    const screen: HTMLPreElement = <pre role="img" aria-label="Music-reactive ASCII spectrum"/>
    const speed = lifecycle.own(new DefaultObservableValue(1))
    const reactivity = lifecycle.own(new DefaultObservableValue(1))
    const mode = lifecycle.own(new DefaultObservableValue<ModeId>("spectrum"))
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
    const modeSelect: HTMLSelectElement = (
        <select onchange={() => mode.setValue(modeSelect.value as ModeId)}>
            {MODE_OPTIONS.map(option => <option value={option.id}>{option.label}</option>)}
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
            <label>Mode {modeSelect}</label>
            <label>Theme {themeSelect}</label>
            <label>Size {sizeSelect}</label>
        </div>
    )
    const element: HTMLDivElement = <div className={`${className} theme-classic`}>{controlsBar}{screen}</div>
    const spectrum = new Uint8Array(256)
    const audio: AudioState = {lastTime: performance.now(), bassEnvelope: 0, punch: 0}
    const peaks = new Float32Array(VU_BARS)
    lifecycle.own(AnimationFrame.add(() => {
        if (element.closest("[hidden]") !== null || element.clientWidth === 0) {return}
        player.getSpectrum(spectrum)
        draw(screen, sizePreset, spectrum, player, performance.now(), audio, peaks, {speed, reactivity, mode, theme})
    }))
    return element
}
