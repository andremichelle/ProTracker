// Shared bass/mid/treble band extraction and beat/transient detection,
// used by both ASCII visualizers so their audio response stays consistent.

export type AudioState = {
    lastTime: number
    bassEnvelope: number
    punch: number
}

export type AudioBands = {
    bass: number
    mid: number
    treble: number
    bassEnvelope: number
    punch: number
}

export const sampleBands = (spectrum: Uint8Array, time: number, audio: AudioState): AudioBands => {
    const dt = Math.min(0.1, Math.max(0, (time - audio.lastTime) / 1000))
    audio.lastTime = time

    let bass = 0
    for (let index = 0; index < 16; index++) {bass += spectrum[index] / 255}
    bass /= 16
    let mid = 0
    for (let index = 32; index < 112; index++) {mid += spectrum[index] / 255}
    mid /= 80
    let treble = 0
    for (let index = 96; index < 160; index++) {treble += spectrum[index] / 255}
    treble /= 64

    // Fast-attack/slow-decay envelope chases bass; a sudden excess above it
    // fires a "punch" that decays over time - a simple beat/transient detector.
    const attack = 1 - Math.pow(0.001, dt)
    const decay = 1 - Math.pow(0.35, dt)
    audio.bassEnvelope += (bass - audio.bassEnvelope) * (bass > audio.bassEnvelope ? attack : decay)
    const excess = Math.max(0, bass - audio.bassEnvelope * 1.08)
    audio.punch = Math.max(excess * 2.2, audio.punch * Math.pow(0.08, dt))

    return {bass, mid, treble, bassEnvelope: audio.bassEnvelope, punch: audio.punch}
}
