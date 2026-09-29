/* AudioWorklet processor hosting the emulator (ust.wasm). Bundled by Vite via "?worker&url". */

declare const sampleRate: number
declare class AudioWorkletProcessor {
    readonly port: MessagePort
    constructor()
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void

interface Exports {
    memory: WebAssembly.Memory
    _initialize?: () => void
    ust_init(rate: number): void
    ust_scratch(): number
    ust_scratch_size(): number
    ust_out_l(): number
    ust_out_r(): number
    ust_load_program(ptr: number, len: number): number
    ust_load_module(ptr: number, len: number): number
    ust_play(): number
    ust_stop(): void
    ust_render(frames: number): number
    ust_set_filter(on: number): void
    ust_set_led(on: number): void
    ust_set_declick(on: number): void
    ust_song_pos(): number
    ust_row(): number
    ust_speed(): number
    ust_tempo(): number
    ust_tick_hz(): number
    ust_pattern(): number
    ust_chan_period(c: number): number
    ust_chan_volume(c: number): number
    ust_chan_dma(c: number): number
}

export type Request =
    | {type: "init", wasm: Uint8Array, program: Uint8Array, module: Uint8Array}
    | {type: "module", module: Uint8Array}
    | {type: "play"} | {type: "stop"}
    | {type: "filter", value: boolean} | {type: "led", value: boolean} | {type: "declick", value: boolean}

export interface Status {
    readonly pos: number
    readonly pattern: number
    readonly row: number
    readonly speed: number
    readonly tempo: number
    readonly tickHz: number
    readonly channels: ReadonlyArray<{period: number, volume: number, dma: boolean}>
}

export type Response =
    | {type: "loaded"}
    | {type: "error", message: string}
    | {type: "status", status: Status}

class Processor extends AudioWorkletProcessor {
    private ex: Exports | null = null
    private ready = false
    private frameCounter = 0

    constructor() {
        super()
        this.port.onmessage = (event: MessageEvent<Request>) => this.onMessage(event.data)
    }

    private instantiate(bytes: Uint8Array): Exports {
        const module = new WebAssembly.Module(new Uint8Array(bytes))   // a posted WebAssembly.Module does not reach a worklet in Chrome
        const ex = new WebAssembly.Instance(module, {}).exports as unknown as Exports
        ex._initialize?.()
        ex.ust_init(sampleRate)
        return ex
    }

    private upload(ex: Exports, bytes: Uint8Array): number {
        const size = ex.ust_scratch_size()
        if (bytes.length > size) {throw new Error(`file too large (${bytes.length} > ${size})`)}
        new Uint8Array(ex.memory.buffer, ex.ust_scratch(), bytes.length).set(bytes)
        return ex.ust_scratch()
    }

    private post(response: Response): void {this.port.postMessage(response)}

    private onMessage(msg: Request): void {
        try {
            switch (msg.type) {
                case "init": {
                    const ex = this.ex = this.instantiate(msg.wasm)
                    const r = ex.ust_load_program(this.upload(ex, msg.program), msg.program.length)
                    if (r !== 0) {throw new Error(`load_program failed: ${r}`)}
                    this.loadModule(ex, msg.module)
                    break
                }
                case "module": this.loadModule(this.exports(), msg.module); break
                case "play": this.exports().ust_play(); break
                case "stop": this.exports().ust_stop(); break
                case "filter": this.exports().ust_set_filter(msg.value ? 1 : 0); break
                case "led": this.exports().ust_set_led(msg.value ? 1 : 0); break
                case "declick": this.exports().ust_set_declick(msg.value ? 1 : 0); break
            }
        } catch (error) {
            this.post({type: "error", message: String(error)})
        }
    }

    private exports(): Exports {
        if (this.ex === null) {throw new Error("not initialized")}
        return this.ex
    }

    private loadModule(ex: Exports, module: Uint8Array): void {
        this.ready = false
        const r = ex.ust_load_module(this.upload(ex, module), module.length)
        if (r !== 0) {throw new Error(`load_module failed: ${r}`)}
        this.ready = true
        this.post({type: "loaded"})
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const out = outputs[0]
        const ex = this.ex
        if (!this.ready || ex === null || out.length === 0) {return true}
        const frames = out[0].length
        ex.ust_render(frames)
        out[0].set(new Float32Array(ex.memory.buffer, ex.ust_out_l(), frames))
        if (out.length > 1) {out[1].set(new Float32Array(ex.memory.buffer, ex.ust_out_r(), frames))}
        if ((this.frameCounter += frames) >= sampleRate / 100) {
            this.frameCounter = 0
            this.post({
                type: "status",
                status: {
                    pos: ex.ust_song_pos(),
                    pattern: ex.ust_pattern(),
                    row: ex.ust_row(),
                    speed: ex.ust_speed(),
                    tempo: ex.ust_tempo(),
                    tickHz: ex.ust_tick_hz(),
                    channels: [0, 1, 2, 3].map(c => ({
                        period: ex.ust_chan_period(c),
                        volume: ex.ust_chan_volume(c),
                        dma: ex.ust_chan_dma(c) !== 0
                    }))
                }
            })
        }
        return true
    }
}

registerProcessor("pt-processor", Processor)
