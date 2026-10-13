import css from "./Visualizer.sass?inline"
import {isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"

const className = Html.adoptStyleSheet(css, "Visualizer")
const ramp = " .:-=+*#%@"

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

const draw = (screen: HTMLPreElement, spectrum: Uint8Array, player: Player, time: number): void => {
    const columns = Math.max(48, Math.min(100, Math.floor(screen.clientWidth / 7)))
    const rows = Math.max(18, Math.min(36, Math.floor(screen.clientHeight / 10)))
    const art = Array.from({length: rows}, () => Array(columns).fill(" ") as string[])
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
    write(rows - 1, 0, horizontal)

    const status = player.currentStatus
    const position = isDefined(status) ? status.pos.toString().padStart(2, "0") : "--"
    const pattern = isDefined(status) ? status.pattern.toString().padStart(2, "0") : "--"
    const row = isDefined(status) ? status.row.toString().padStart(2, "0") : "--"
    const state = player.playing.getValue() ? "PLAYING" : "STANDBY"
    write(1, 2, " PROTRACKER 2.3A  /  PAULA ASCII SPECTRUM ")
    write(2, 2, ` ${state}  POS ${position}  PAT ${pattern}  ROW ${row} `)
    write(3, 0, `+${"-".repeat(columns - 2)}+`)

    const plotTop = 4
    const plotBottom = rows - 4
    const plotHeight = plotBottom - plotTop + 1
    const center = plotTop + Math.floor(plotHeight * 0.42)
    const barRows = plotBottom - center
    const plotWidth = columns - 4
    let energy = 0
    for (let index = 0; index < 64; index++) {energy += spectrum[index] / 255}
    energy /= 64
    const phase = time * (0.00045 + energy * 0.002)
    for (let x = 0; x < plotWidth; x++) {
        const position = x / Math.max(1, plotWidth - 1)
        const bin = Math.floor(Math.pow(position, 1.65) * 180)
        const level = spectrum[bin] / 255
        const amplitude = level * Math.max(1, center - plotTop - 1)
        const wave = center + Math.sin(x * 0.19 + phase) * amplitude
        const waveRow = Math.round(wave)
        const glyph = ramp[Math.min(ramp.length - 1, Math.floor(level * (ramp.length - 1)))]
        if (level > 0.04) {art[waveRow][x + 2] = glyph}
        const barHeight = Math.round(level * barRows)
        for (let y = 0; y < barHeight; y++) {
            const glyphIndex = Math.min(ramp.length - 1, Math.floor((y + 1) / barRows * (ramp.length - 1)))
            art[plotBottom - y][x + 2] = ramp[glyphIndex]
        }
    }
    for (let index = 0; index < Math.floor(plotWidth / 6); index++) {
        const x = 2 + (index * 17 + Math.floor(time / 180)) % plotWidth
        const y = plotTop + (index * 11 + Math.floor(time / 320)) % Math.max(1, plotHeight - 1)
        if (art[y][x] === " ") {art[y][x] = "."}
    }

    write(rows - 3, 2, " FREQ  0HZ  ------------------------ 24KHZ ")
    write(rows - 2, 2, energy > 0.015
        ? " PAULA / LIVE MIX / SIGNAL LOCKED "
        : " LOAD A MODULE AND PRESS PLAY ")
    screen.textContent = art.map(line => line.join("")).join("\n")
}

export const Visualizer = ({lifecycle, player}: Construct) => {
    const screen: HTMLPreElement = <pre role="img" aria-label="Music-reactive ASCII spectrum"/>
    const element: HTMLDivElement = <div className={className}>{screen}</div>
    const spectrum = new Uint8Array(256)
    lifecycle.own(AnimationFrame.add(() => {
        if (element.closest("[hidden]") !== null || element.clientWidth === 0) {return}
        player.getSpectrum(spectrum)
        draw(screen, spectrum, player, performance.now())
    }))
    return element
}
