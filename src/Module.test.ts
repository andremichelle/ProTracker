import {describe, expect, it} from "vitest"
import {Module, noteName} from "@/Module"

const setTag = (d: Uint8Array, tag: string): void => {
    for (let i = 0; i < 4; i++) {d[1080 + i] = tag.charCodeAt(i)}
}

const buildMinimalProTracker = (title: string, songLength: number, patternData: Uint8Array = new Uint8Array(0)): Uint8Array => {
    const numPatterns = Math.max(1, songLength)
    const data = new Uint8Array(1084 + numPatterns * 1024)
    for (let i = 0; i < title.length; i++) {data[i] = title.charCodeAt(i)}
    data[950] = songLength
    data[951] = 127
    for (let i = 0; i < songLength; i++) {data[952 + i] = i} // position i -> pattern i
    setTag(data, "M.K.")
    data.set(patternData.subarray(0, Math.min(patternData.length, numPatterns * 1024)), 1084)
    return data
}

const buildMinimal15Sample = (title: string, songLength: number): Uint8Array => {
    // title(20) + 15*30 sample headers + songlen(1) + restart(1) + order table(128) + 1 pattern, untagged
    const size = 20 + 15 * 30 + 1 + 1 + 128 + Math.max(1, songLength) * 1024
    const data = new Uint8Array(size)
    for (let i = 0; i < title.length; i++) {data[i] = title.charCodeAt(i)}
    data[470] = songLength
    data[471] = 0
    for (let i = 0; i < songLength; i++) {data[472 + i] = i}
    // leave tag region (there isn't one yet - untagged) as zero
    return data
}

describe("Module.tagOf / isProTracker", () => {
    it("reads the 4-byte tag at offset 1080", () => {
        const data = buildMinimalProTracker("test", 1)
        expect(Module.tagOf(data)).toBe("M.K.")
        expect(Module.isProTracker(data)).toBe(true)
    })

    it("returns empty string for buffers shorter than the tag offset", () => {
        expect(Module.tagOf(new Uint8Array(10))).toBe("")
    })

    it("recognizes all four known 4-channel tags", () => {
        for (const tag of Module.TAGS) {
            const data = buildMinimalProTracker("x", 1)
            setTag(data, tag)
            expect(Module.isProTracker(data)).toBe(true)
        }
    })
})

describe("Module.parse", () => {
    it("parses a tagged 31-sample module directly", () => {
        const data = buildMinimalProTracker("delicate", 2)
        const module = Module.parse(data)
        expect(module.title).toBe("delicate")
        expect(module.positions).toEqual([0, 1])
        expect(module.patterns.length).toBe(2)
        expect(module.patterns[0].length).toBe(64) // rows per pattern
        expect(module.patterns[0][0].length).toBe(4) // channels per row
    })

    it("pads an untagged 15-sample module to 31 and parses it", () => {
        const data = buildMinimal15Sample("old school", 3)
        const module = Module.parse(data)
        expect(module.title).toBe("old school")
        expect(module.positions).toEqual([0, 1, 2])
        expect(Module.isProTracker(module.data)).toBe(true)
    })

    it("rejects a 6-channel module with a clear error instead of corrupting it", () => {
        const data = buildMinimal15Sample("six chan", 1)
        setTag(data, "6CHN")
        expect(() => Module.parse(data)).toThrow(/6CHN.*4 channels/)
    })

    it("rejects an 8-channel module the same way", () => {
        const data = buildMinimal15Sample("eight chan", 1)
        setTag(data, "8CHN")
        expect(() => Module.parse(data)).toThrow(/8CHN/)
    })

    it("rejects a 16-channel module tag", () => {
        const data = buildMinimal15Sample("sixteen chan", 1)
        setTag(data, "16CH")
        expect(() => Module.parse(data)).toThrow(/16CH/)
    })

    it("still throws a generic error for genuinely malformed input", () => {
        expect(() => Module.parse(new Uint8Array(10))).toThrow()
    })

    it("rejects a FastTracker II XM module instead of silently garbage-parsing it", () => {
        // Without this check, pad15to31() would stamp "M.K." onto this (it's >= 600 bytes and
        // carries none of the TAGS/MULTI_CHANNEL_TAGS markers at offset 1080) and Module.parse
        // would "succeed" with a Module built from misread XM header/pattern data.
        const data = new Uint8Array(2000)
        const signature = "Extended Module: "
        for (let i = 0; i < signature.length; i++) {data[i] = signature.charCodeAt(i)}
        expect(() => Module.parse(data)).toThrow(/XM.*not a ProTracker-compatible format/)
    })

    it("rejects an Impulse Tracker IT module", () => {
        const data = new Uint8Array(2000)
        const signature = "IMPM"
        for (let i = 0; i < signature.length; i++) {data[i] = signature.charCodeAt(i)}
        expect(() => Module.parse(data)).toThrow(/Impulse Tracker/)
    })

    it("rejects a Scream Tracker 3 S3M module (signature at offset 44)", () => {
        const data = new Uint8Array(2000)
        const signature = "SCRM"
        for (let i = 0; i < signature.length; i++) {data[44 + i] = signature.charCodeAt(i)}
        expect(() => Module.parse(data)).toThrow(/S3M/)
    })
})

describe("Module.pad15to31", () => {
    it("normalizes a zero-length sample loop to offset 0 / length 1", () => {
        const data = buildMinimal15Sample("loop test", 1)
        // sample 0 header starts at offset 20; set repeat length to 0 (bytes, word-encoded)
        const h = 20
        data[h + 26] = 0x00; data[h + 27] = 0x05 // repeat offset: 5 words (should be zeroed since length <= 1)
        data[h + 28] = 0x00; data[h + 29] = 0x00 // repeat length: 0
        const out = Module.pad15to31(data)
        expect(out[h + 26]).toBe(0)
        expect(out[h + 27]).toBe(0)
        expect(out[h + 28]).toBe(0)
        expect(out[h + 29]).toBe(1)
    })

    it("converts a non-trivial repeat offset/length from bytes to words", () => {
        const data = buildMinimal15Sample("loop test 2", 1)
        const h = 20
        data[h + 26] = 0x00; data[h + 27] = 0x08 // repeat offset: 8 bytes -> 4 words
        data[h + 28] = 0x00; data[h + 29] = 0x10 // repeat length: 16 (kept as-is, > 1)
        const out = Module.pad15to31(data)
        expect((out[h + 26] << 8) | out[h + 27]).toBe(4)
        expect((out[h + 28] << 8) | out[h + 29]).toBe(16)
    })

    it("writes the M.K. tag and leaves pattern/sample data untouched", () => {
        const data = buildMinimal15Sample("tag test", 1)
        const marker = 0xAB
        data[600] = marker // first byte of pattern data
        const out = Module.pad15to31(data)
        expect(Module.tagOf(out)).toBe("M.K.")
        expect(out[1084]).toBe(marker)
    })
})

describe("noteName", () => {
    it("maps period 0 to a rest", () => {
        expect(noteName(0)).toBe("---")
    })

    it("maps the standard PT period table to the expected note names", () => {
        expect(noteName(856)).toBe("C-1") // lowest period, C-1 in PT octave numbering
        expect(noteName(428)).toBe("C-2")
        expect(noteName(113)).toBe("B-3") // highest period
    })

    it("snaps a slightly off period to the nearest known note", () => {
        expect(noteName(430)).toBe("C-2")
    })
})
