import {describe, expect, it} from "vitest"
import {encodeCell, encodeSampleHeader, Module, noteName, periodOf} from "@/Module"

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

describe("periodOf", () => {
    it("reads note names in ProTracker's three octaves", () => {
        expect(periodOf("C-1")).toBe(856)
        expect(periodOf("c#2")).toBe(404)
        expect(periodOf("A2")).toBe(254)
        expect(periodOf("B-3")).toBe(113)
    })

    it("reads an empty note as 0", () => {
        expect(periodOf("---")).toBe(0)
        expect(periodOf("")).toBe(0)
    })

    it("refuses what is no note", () => {
        expect(periodOf("H-2")).toBeNull()
        expect(periodOf("E#2")).toBeNull()
        expect(periodOf("C-4")).toBeNull()
        expect(periodOf("C-0")).toBeNull()
    })

    it("names every period it returns the same", () => {
        for (const name of ["C-1", "D#1", "F#2", "G-2", "B-3"]) {expect(noteName(periodOf(name) ?? -1)).toBe(name)}
    })
})

describe("encodeCell", () => {
    it("stores note, sample, effect and argument as the module does", () => {
        const data = buildMinimalProTracker("cells", 1)
        const cell = {period: 0x1AC, sample: 0x13, effect: 0xC, arg: 0x20}
        data.set(encodeCell(cell), 1084 + 5 * 16 + 2 * 4)
        expect(Module.parse(data).patterns[0][5][2]).toStrictEqual(cell)
        expect(Array.from(encodeCell(cell))).toStrictEqual([0x11, 0xAC, 0x3C, 0x20])
    })
})

describe("samples", () => {
    // one pattern, sample 1 with 6 bytes and a loop over the last 4, sample 3 with 4 bytes, the rest empty
    const example = (): Uint8Array => {
        const data = buildMinimalProTracker("samples", 1, new Uint8Array(0))
        const module = new Uint8Array(data.length + 10)
        module.set(data)
        module.set(encodeSampleHeader({name: "one", length: 6, finetune: 2, volume: 40, loopStart: 2, loopLength: 4}), 20)
        module.set(encodeSampleHeader({name: "three", length: 4, finetune: -8, volume: 64, loopStart: 0, loopLength: 2}), 80)
        module.set([1, 2, 3, 4, 5, 6, -1 & 0xff, -2 & 0xff, -3 & 0xff, -4 & 0xff], data.length)
        return module
    }

    it("reads all 31 slots, their data ends where the file ends", () => {
        const data = example()
        const {samples} = Module.parse(data)
        expect(samples).toHaveLength(31)
        expect(samples[0]).toMatchObject({name: "one", length: 6, finetune: 2, volume: 40, loopStart: 2, loopLength: 4})
        expect(Array.from(samples[0].data)).toStrictEqual([1, 2, 3, 4, 5, 6])
        expect(samples[1].length).toBe(0)
        expect(samples[2]).toMatchObject({name: "three", length: 4, finetune: -8})
        expect(Array.from(samples[2].data)).toStrictEqual([-1, -2, -3, -4])
        expect(samples[2].data.byteOffset + samples[2].data.length).toBe(data.length)
    })

    it("encodes a header back to the bytes it was read from", () => {
        const data = example()
        Module.parse(data).samples.forEach((sample, index) => {
            const header = data.subarray(20 + 30 * index, 20 + 30 * index + 30)
            expect(Array.from(encodeSampleHeader(sample))).toStrictEqual(Array.from(header).map((byte, at) =>
                at === 29 && sample.length === 0 && byte === 0 ? 1 : byte))
        })
    })

    it("reads finetune as -8..7 and writes it back as a nibble", () => {
        const data = buildMinimalProTracker("ft", 1)
        data.set(encodeSampleHeader({name: "x", length: 4, finetune: -1, volume: 64, loopStart: 0, loopLength: 2}), 20)
        expect(data[20 + 24]).toBe(15)
        expect(Module.parse(data).samples[0].finetune).toBe(-1)
    })

    it("cuts names to 22 characters and keeps a missing loop at one word", () => {
        const header = encodeSampleHeader({name: "a".repeat(30), length: 100, finetune: 0, volume: 70, loopStart: 0, loopLength: 0})
        expect(header.subarray(0, 22).every(byte => byte === 97)).toBe(true)
        expect(header[25]).toBe(64)
        expect((header[28] << 8) | header[29]).toBe(1)
    })
})
