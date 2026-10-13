import {describe, expect, it} from "vitest"
import {AudioState, sampleBands} from "@/ui/audioReactive"

const newState = (): AudioState => ({lastTime: 0, bassEnvelope: 0, punch: 0})

const silentSpectrum = (): Uint8Array => new Uint8Array(256)

const constantSpectrum = (value: number): Uint8Array => new Uint8Array(256).fill(value)

describe("sampleBands", () => {
    it("reports zero bands for a silent spectrum", () => {
        const bands = sampleBands(silentSpectrum(), 0, newState())
        expect(bands.bass).toBe(0)
        expect(bands.mid).toBe(0)
        expect(bands.treble).toBe(0)
    })

    it("reports ~1 for a fully saturated spectrum", () => {
        const bands = sampleBands(constantSpectrum(255), 0, newState())
        expect(bands.bass).toBeCloseTo(1, 5)
        expect(bands.mid).toBeCloseTo(1, 5)
        expect(bands.treble).toBeCloseTo(1, 5)
    })

    it("only averages its own frequency bins, not the whole spectrum", () => {
        const spectrum = silentSpectrum()
        spectrum[200] = 255 // outside bass (0-15), mid (32-111), and treble (96-159) ranges
        const bands = sampleBands(spectrum, 0, newState())
        expect(bands.bass).toBe(0)
        expect(bands.mid).toBe(0)
        expect(bands.treble).toBe(0)
    })

    it("advances lastTime so a second call's dt is bounded", () => {
        const audio = newState()
        sampleBands(silentSpectrum(), 1000, audio)
        expect(audio.lastTime).toBe(1000)
    })

    it("builds up bassEnvelope toward sustained bass rather than jumping instantly", () => {
        const audio = newState()
        const loud = constantSpectrum(255)
        const first = sampleBands(loud, 0, audio)
        const second = sampleBands(loud, 16, audio) // 16ms later
        // envelope should be rising toward 1 but not already there after only two ticks
        expect(second.bassEnvelope).toBeGreaterThan(first.bassEnvelope)
        expect(second.bassEnvelope).toBeLessThanOrEqual(1)
    })

    it("fires a punch on a sudden transient after a quiet baseline", () => {
        const audio = newState()
        // establish a quiet baseline over several ticks so bassEnvelope settles low
        const quiet = constantSpectrum(20)
        let time = 0
        for (let i = 0; i < 30; i++) {
            time += 16
            sampleBands(quiet, time, audio)
        }
        const quietPunch = audio.punch
        // sudden loud bass hit
        const loud = constantSpectrum(255)
        const result = sampleBands(loud, time + 16, audio)
        expect(result.punch).toBeGreaterThan(quietPunch)
        expect(result.punch).toBeGreaterThan(0)
    })

    it("decays punch back down over time once the transient passes", () => {
        const audio = newState()
        let time = 0
        for (let i = 0; i < 30; i++) {
            time += 16
            sampleBands(constantSpectrum(20), time, audio)
        }
        time += 16
        sampleBands(constantSpectrum(255), time, audio) // transient
        const peak = audio.punch
        time += 500 // let it decay
        const after = sampleBands(constantSpectrum(20), time, audio)
        expect(after.punch).toBeLessThan(peak)
    })
})
