// Shared look-and-feel for both ASCII visualizers (2D spectrum and 3D scene).

// AAlib-style luminance ramp, same family used by the classic "bb" demo intro.
export const ramp = " .:-=+*#%@"
// Digital-rain glyphs for the Matrix theme (half-width katakana + digits).
export const matrixChars = "ﾊﾐﾋｰｳｼﾅﾁﾄﾓﾆﾗﾖﾓｴﾙﾈ0123456789"

export type ThemeId = "classic" | "matrix" | "amber"
export const THEME_OPTIONS: ReadonlyArray<{ id: ThemeId, label: string }> = [
    {id: "classic", label: "Classic (aalib)"},
    {id: "matrix", label: "Matrix"},
    {id: "amber", label: "Amber CRT"}
]

export type SizeId = "compact" | "normal" | "large"
export type SizePreset = { cellWidth: number, fontSizeRem: number }
export const SIZE_PRESETS: Record<SizeId, SizePreset> = {
    compact: {cellWidth: 5, fontSizeRem: 0.46},
    normal: {cellWidth: 7, fontSizeRem: 0.64},
    large: {cellWidth: 10, fontSizeRem: 0.92}
}
export const SIZE_OPTIONS: ReadonlyArray<{ id: SizeId, label: string }> = [
    {id: "compact", label: "Compact"},
    {id: "normal", label: "Normal"},
    {id: "large", label: "Large"}
]

// Digital-rain background, drawn before the main visual so it shows through any gaps.
export const drawMatrixRain = (art: string[][], columns: number, plotTop: number, plotBottom: number,
                                seconds: number, speedBase: number): void => {
    const plotHeight = plotBottom - plotTop + 1
    for (let x = 1; x < columns - 1; x++) {
        const colSeed = ((x * 2654435761) >>> 0) % 1000 / 1000
        const speedFactor = 0.6 + colSeed * 1.4
        const span = plotHeight + 12
        const head = Math.floor((seconds * 9 * speedBase * speedFactor + colSeed * 1000) % span) - 6
        const length = 6 + Math.floor(colSeed * 10)
        for (let i = 0; i < length; i++) {
            const y = plotTop + head - i
            if (y < plotTop || y > plotBottom) {continue}
            const t = i / length
            art[y][x] = matrixChars[Math.floor((1 - t) * (matrixChars.length - 1))]
        }
    }
}
