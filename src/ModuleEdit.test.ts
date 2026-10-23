import {describe, expect, it} from "vitest"
import {ModuleEdit} from "@/ModuleEdit"

const build = (positions: ReadonlyArray<number>, tag = "M.K."): Uint8Array => {
    const data = new Uint8Array(1084 + (Math.max(...positions) + 1) * 1024)
    data[950] = positions.length
    data.set(positions, 952)
    for (let i = 0; i < 4; i++) {data[1080 + i] = tag.charCodeAt(i)}
    return data
}

describe("ModuleEdit", () => {
    it("counts the patterns of all 128 entries", () => {
        const data = build([0, 1])
        data[952 + 100] = 7
        expect(ModuleEdit.patternCount(data)).toBe(8)
    })

    it("allows 100 patterns in M!K! modules, 64 in others", () => {
        expect(ModuleEdit.maxPatterns(build([0]))).toBe(64)
        expect(ModuleEdit.maxPatterns(build([0], "M!K!"))).toBe(100)
    })

    it("refuses an insert when the song or the pattern count is full", () => {
        expect(ModuleEdit.canInsert(build([0, 1]))).toBe(true)
        expect(ModuleEdit.canInsert(build(Array.from({length: 128}, () => 0)))).toBe(false)
        expect(ModuleEdit.canInsert(build([63]))).toBe(false)
        expect(ModuleEdit.canInsert(build([63], "M!K!"))).toBe(true)
    })
})
