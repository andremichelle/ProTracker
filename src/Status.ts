/** Where the replayer is, what the song views draw from. */
export interface Status {
    readonly pos: number
    readonly pattern: number
    readonly row: number
    readonly speed: number
    readonly tempo: number
    readonly tickHz: number
    // level: the channel's peak since the last status (0..1), only where the host measures it
    readonly channels: ReadonlyArray<{period: number, volume: number, dma: boolean, level?: number}>
}
