import {int} from "@opendaw/lib-std"

export interface Cell {
    readonly period: int
    readonly sample: int
    readonly effect: int
    readonly arg: int
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

const hex = (value: int, digits: int) => value.toString(16).toUpperCase().padStart(digits, "0")
export const cellText = (cell: Cell): string =>
    `${noteName(cell.period)} ${cell.sample === 0 ? ".." : hex(cell.sample, 2)} ${cell.effect === 0 && cell.arg === 0 ? "..." : hex(cell.effect, 1) + hex(cell.arg, 2)}`

/** A 31 instrument ProTracker module as the replayer sees it. */
export class Module {
    static readonly TAGS = ["M.K.", "M!K!", "FLT4", "4CHN"]
    // Tags used by >4-channel formats (6CHN, 8CHN, 10CH..32CH, OCTA, CD81, TDZ[1-4], FA0[4-8]).
    // Paula only has 4 DMA channels, and the real PT-CIAPlay.s routine this app emulates has no
    // code path for more - without this check, an unrecognized tag falls through to pad15to31(),
    // which assumes a 15-sample layout and would silently misinterpret the real pattern/sample
    // data as garbage instead of rejecting it.
    static readonly MULTI_CHANNEL_TAGS = /^(?:[0-9]{1,2}CHN?|OCTA|CD81|TDZ[1-4]|FA0[4-8])$/

    // Entirely different tracker formats (not MOD variants at all, so they carry none of the
    // TAGS/MULTI_CHANNEL_TAGS markers at offset 1080) that would otherwise silently fall through
    // to pad15to31(), which unconditionally stamps "M.K." onto anything >= 600 bytes it doesn't
    // already recognize - misinterpreting their real headers/patterns as garbage 15-sample MOD
    // data instead of rejecting them. Checked by magic bytes at each format's own fixed offset.
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

    static foreignFormatOf(d: Uint8Array): string | null {
        for (const sig of Module.FOREIGN_SIGNATURES) {
            if (d.length < sig.offset + sig.bytes.length) {continue}
            let matches = true
            for (let i = 0; i < sig.bytes.length; i++) {
                if (d[sig.offset + i] !== sig.bytes.charCodeAt(i)) {matches = false; break}
            }
            if (matches) {return sig.name}
        }
        return null
    }

    /** Accepts M.K. files and old 15 instrument SoundTracker files (padded to 31, as ProTracker does). */
    static parse(input: Uint8Array): Module {
        const foreign = Module.foreignFormatOf(input)
        if (foreign !== null) {throw new Error(`${foreign} module: not a ProTracker-compatible format`)}
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
        return new Module(d, title, positions, patterns)
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
                        readonly patterns: ReadonlyArray<Pattern>) {}
}
