import {int, isDefined, Nullable} from "@opendaw/lib-std"

export interface Cell {
    readonly period: int
    readonly sample: int
    readonly effect: int
    readonly arg: int
}

/** One of the 31 sample slots. Lengths and loop points are in bytes, always even (the module stores words). */
export interface Sample {
    readonly name: string
    readonly length: int
    readonly finetune: int      // -8..7
    readonly volume: int        // 0..64
    readonly loopStart: int
    readonly loopLength: int    // 2 or less: no loop
    readonly data: Int8Array    // the bytes the file holds, shorter than `length` if it was cut off
}

export type SampleHeader = Omit<Sample, "data">

export const MAX_SAMPLE_BYTES = 0xFFFF * 2

/** The 30 bytes a sample header takes in the module. */
export const encodeSampleHeader = ({name, length, finetune, volume, loopStart, loopLength}: SampleHeader): Uint8Array => {
    const bytes = new Uint8Array(30)
    for (let index = 0; index < Math.min(22, name.length); index++) {bytes[index] = name.charCodeAt(index) & 0xff}
    const words = (value: int, at: int) => {
        const word = Math.max(0, Math.min(0xFFFF, value >> 1))
        bytes[at] = word >> 8
        bytes[at + 1] = word & 0xff
    }
    words(length, 22)
    bytes[24] = finetune & 0x0f
    bytes[25] = Math.max(0, Math.min(64, volume))
    words(loopStart, 26)
    words(Math.max(2, loopLength), 28)
    return bytes
}

const decodeSamples = (d: Uint8Array, numPatterns: int): ReadonlyArray<Sample> => {
    let at = 1084 + numPatterns * 1024
    return Array.from({length: 31}, (_, index) => {
        const h = 20 + 30 * index
        const word = (offset: int) => ((d[h + offset] << 8) | d[h + offset + 1]) * 2
        const length = word(22)
        const start = Math.min(at, d.length)
        const data = new Int8Array(d.buffer, d.byteOffset + start, Math.min(length, d.length - start))
        at += length
        return {
            name: String.fromCharCode(...d.subarray(h, h + 22)).replace(/\0.*$/, "").trimEnd(),
            length, finetune: ((d[h + 24] & 0x0f) ^ 8) - 8, volume: Math.min(64, d[h + 25]),
            loopStart: word(26), loopLength: word(28), data
        }
    })
}

export type Row = ReadonlyArray<Cell>       // 4 channels
export type Pattern = ReadonlyArray<Row>    // 64 rows

const PERIODS = [
    856, 808, 762, 720, 678, 640, 604, 570, 538, 508, 480, 453,
    428, 404, 381, 360, 339, 320, 302, 285, 269, 254, 240, 226,
    214, 202, 190, 180, 170, 160, 151, 143, 135, 127, 120, 113]
const NAMES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"]

export const noteName = (period: int): string => {
    if (period === 0) {return "---"}
    let best = 0
    for (let i = 1; i < PERIODS.length; i++) {
        if (Math.abs(PERIODS[i] - period) < Math.abs(PERIODS[best] - period)) {best = i}
    }
    return `${NAMES[best % 12]}${1 + Math.floor(best / 12)}`
}

/** The period of a note name like "C-1", "F#2" or "a#3" (ProTracker's three octaves, finetune 0), 0 for "---" or "".
 * Null if it is no note. */
export const periodOf = (name: string): Nullable<int> => {
    const text = name.trim().toUpperCase()
    if (text === "" || /^-+$/.test(text)) {return 0}
    const match = /^([A-G])([-#]?)([1-3])$/.exec(text)
    if (!isDefined(match)) {return null}
    const index = NAMES.indexOf(`${match[1]}${match[2] === "#" ? "#" : "-"}`)
    return index < 0 ? null : PERIODS[(Number(match[3]) - 1) * 12 + index]
}

/** The four bytes a cell takes in the module. */
export const encodeCell = ({period, sample, effect, arg}: Cell): Uint8Array => new Uint8Array([
    (sample & 0xf0) | ((period >> 8) & 0x0f), period & 0xff, ((sample & 0x0f) << 4) | (effect & 0x0f), arg & 0xff])

const hex = (value: int, digits: int) => value.toString(16).toUpperCase().padStart(digits, "0")
export const cellText = (cell: Cell): string =>
    `${noteName(cell.period)} ${cell.sample === 0 ? ".." : hex(cell.sample, 2)} ${cell.effect === 0 && cell.arg === 0 ? "..." : hex(cell.effect, 1) + hex(cell.arg, 2)}`

/** A 31 instrument ProTracker module as the replayer sees it. */
export class Module {
    static readonly TAGS = ["M.K.", "M!K!", "FLT4", "4CHN"]
    /** Tags of >4 channel formats. Paula has 4 channels, padding them as 15 instrument files would garble them. */
    static readonly MULTI_CHANNEL_TAGS = /^(?:[0-9]{1,2}CHN?|OCTA|CD81|TDZ[1-4]|FA0[4-8])$/
    /** Magic bytes of other tracker formats, which would otherwise be padded as 15 instrument files. */
    static readonly FOREIGN_SIGNATURES: ReadonlyArray<{name: string, offset: int, bytes: string}> = [
        {name: "FastTracker II XM", offset: 0, bytes: "Extended Module: "},
        {name: "Impulse Tracker IT", offset: 0, bytes: "IMPM"},
        {name: "Scream Tracker 3 S3M", offset: 44, bytes: "SCRM"},
        {name: "MultiTracker MTM", offset: 0, bytes: "MTM"}
    ]

    static tagOf(d: Uint8Array): string {
        return d.length >= 1084 ? String.fromCharCode(d[1080], d[1081], d[1082], d[1083]) : ""
    }

    static isProTracker(d: Uint8Array): boolean {
        return Module.TAGS.includes(Module.tagOf(d))
    }

    static foreignFormatOf(d: Uint8Array): Nullable<string> {
        const signature = Module.FOREIGN_SIGNATURES.find(({offset, bytes}) =>
            d.length >= offset + bytes.length && [...bytes].every((char, index) => d[offset + index] === char.charCodeAt(0)))
        return signature?.name ?? null
    }

    /** Accepts M.K. files and old 15 instrument SoundTracker files (padded to 31, as ProTracker does). */
    static parse(input: Uint8Array): Module {
        const foreign = Module.foreignFormatOf(input)
        if (isDefined(foreign)) {throw new Error(`${foreign} module: not a ProTracker-compatible format`)}
        if (!Module.isProTracker(input) && Module.MULTI_CHANNEL_TAGS.test(Module.tagOf(input))) {
            throw new Error(`${Module.tagOf(input)} module: Paula only has 4 channels, not supported`)
        }
        const d = Module.isProTracker(input) ? input : Module.pad15to31(input)
        if (!Module.isProTracker(d)) {throw new Error("not a 4 channel ProTracker module")}
        const title = String.fromCharCode(...d.subarray(0, 20)).replace(/\0.*$/, "").trimEnd()
        const positions = Array.from(d.subarray(952, 952 + d[950]))
        let numPatterns = 0
        for (let i = 0; i < 128; i++) {numPatterns = Math.max(numPatterns, d[952 + i])}
        numPatterns++
        const patterns: Array<Pattern> = []
        let p = 1084
        for (let n = 0; n < numPatterns; n++) {
            const rows: Array<Row> = []
            for (let r = 0; r < 64; r++) {
                const cells: Array<Cell> = []
                for (let c = 0; c < 4; c++, p += 4) {
                    const b0 = d[p] ?? 0, b1 = d[p + 1] ?? 0, b2 = d[p + 2] ?? 0, b3 = d[p + 3] ?? 0
                    cells.push({period: ((b0 & 0x0f) << 8) | b1, sample: (b0 & 0xf0) | (b2 >> 4), effect: b2 & 0x0f, arg: b3})
                }
                rows.push(cells)
            }
            patterns.push(rows)
        }
        return new Module(d, title, positions, patterns, decodeSamples(d, numPatterns))
    }

    static pad15to31(d: Uint8Array): Uint8Array {
        if (d.length < 600) {return d}
        const rest = d.subarray(600)
        const out = new Uint8Array(1084 + rest.length)
        out.set(d.subarray(0, 20), 0)
        for (let i = 0; i < 15; i++) {
            const h = 20 + 30 * i
            out.set(d.subarray(h, h + 30), h)
            let rs = ((d[h + 26] << 8) | d[h + 27]) >> 1, rl = (d[h + 28] << 8) | d[h + 29]   // repeat: bytes -> words
            if (rl <= 1) {rs = 0; rl = 1}
            out[h + 24] = 0
            out[h + 26] = rs >> 8; out[h + 27] = rs & 255
            out[h + 28] = rl >> 8; out[h + 29] = rl & 255
        }
        for (let i = 15; i < 31; i++) {out[20 + 30 * i + 29] = 1}
        out[950] = d[470]; out[951] = 127
        out.set(d.subarray(472, 600), 952)
        out.set([77, 46, 75, 46], 1080)     // "M.K."
        out.set(rest, 1084)
        return out
    }

    private constructor(readonly data: Uint8Array,
                        readonly title: string,
                        readonly positions: ReadonlyArray<int>,
                        readonly patterns: ReadonlyArray<Pattern>,
                        readonly samples: ReadonlyArray<Sample>) {}
}
