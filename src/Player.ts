import {DefaultObservableValue, MutableObservableOption, Nullable, Option, tryCatch} from "@opendaw/lib-std"
import {Module} from "@/Module"
import type {Request, Response, Status} from "@/worklet/processor"
import processorUrl from "@/worklet/processor?worker&url"

/** Owns the AudioContext, the worklet running the emulator, and the current module. */
export class Player {
    readonly module = new MutableObservableOption<Module>()
    readonly playing = new DefaultObservableValue(false)
    readonly error = new DefaultObservableValue("")
    readonly filter = new DefaultObservableValue(true)
    readonly led = new DefaultObservableValue(false)
    readonly declick = new DefaultObservableValue(true)

    private context: Option<AudioContext> = Option.None
    private node: Option<AudioWorkletNode> = Option.None
    private analyser: AnalyserNode | null = null
    private status: Nullable<Status> = null
    // Wall-clock elapsed playback time (DOS-tracker-style "time played" readout), independent
    // of the worklet's own position/pattern state - just accumulated since Play was pressed.
    private playStartMs: Nullable<number> = null
    private accumulatedMs = 0

    constructor(private readonly baseUrl: string) {
        this.filter.subscribe(owner => this.send({type: "filter", value: owner.getValue()}))
        this.led.subscribe(owner => this.send({type: "led", value: owner.getValue()}))
        this.declick.subscribe(owner => this.send({type: "declick", value: owner.getValue()}))
    }

    get currentStatus(): Nullable<Status> {return this.status}

    get elapsedMs(): number {
        return this.accumulatedMs + (this.playStartMs === null ? 0 : performance.now() - this.playStartMs)
    }

    getSpectrum(target: Uint8Array<ArrayBuffer>): boolean {
        if (this.analyser === null) {
            target.fill(0)
            return false
        }
        this.analyser.getByteFrequencyData(target)
        return true
    }

    async listModules(): Promise<ReadonlyArray<string>> {
        return (await fetch(`${this.baseUrl}mods/index.json`)).json()
    }

    async loadUrl(path: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}${path}`)
        if (!response.ok) {
            this.error.setValue(`${path}: ${response.status}`)
            return
        }
        this.load(new Uint8Array(await response.arrayBuffer()))
    }

    /** Fetches an arbitrary, absolute URL (as opposed to loadUrl, which is for the app's own bundled assets). */
    async loadFromUrl(url: string): Promise<void> {
        let response: globalThis.Response
        try {
            response = await fetch(url)
        } catch (reason) {
            this.error.setValue(`${url}: ${String(reason)}`)
            return
        }
        if (!response.ok) {
            this.error.setValue(`${url}: ${response.status}`)
            return
        }
        this.load(new Uint8Array(await response.arrayBuffer()))
    }

    load(bytes: Uint8Array): void {
        const result = tryCatch(() => Module.parse(bytes))
        if (result.status === "failure") {
            this.error.setValue(String(result.error))
            return
        }
        this.status = null
        this.error.setValue("")
        this.accumulatedMs = 0
        this.playStartMs = null
        this.module.wrap(result.value)
        this.send({type: "module", module: result.value.data})
    }

    /** Must be called from a user gesture the first time. */
    async play(): Promise<void> {
        await this.ensureNode()
        await this.context.unwrap().resume()
        this.send({type: "play"})
        this.playing.setValue(true)
        this.playStartMs = performance.now()
    }

    stop(): void {
        this.send({type: "stop"})
        this.playing.setValue(false)
        if (this.playStartMs !== null) {
            this.accumulatedMs += performance.now() - this.playStartMs
            this.playStartMs = null
        }
    }

    private send(request: Request): void {this.node.ifSome(node => node.port.postMessage(request))}

    private async ensureNode(): Promise<void> {
        if (this.node.nonEmpty()) {return}
        const context = new AudioContext({sampleRate: 48000})
        this.context = Option.wrap(context)
        const [wasm, program] = await Promise.all([
            fetch(`${this.baseUrl}ust.wasm`).then(response => response.arrayBuffer()),
            fetch(`${this.baseUrl}ptplay`).then(response => response.arrayBuffer())
        ])
        await context.audioWorklet.addModule(processorUrl)
        const node = new AudioWorkletNode(context, "pt-processor", {outputChannelCount: [2]})
        const analyser = context.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.78
        node.port.onmessage = (event: MessageEvent<Response>) => this.onResponse(event.data)
        node.connect(analyser)
        analyser.connect(context.destination)
        this.node = Option.wrap(node)
        this.analyser = analyser
        this.send({
            type: "init",
            wasm: new Uint8Array(wasm),
            program: new Uint8Array(program),
            module: this.module.unwrap("no module loaded").data
        })
        this.send({type: "filter", value: this.filter.getValue()})
        this.send({type: "led", value: this.led.getValue()})
        this.send({type: "declick", value: this.declick.getValue()})
    }

    private onResponse(response: Response): void {
        switch (response.type) {
            case "status": this.status = response.status; break
            case "error": this.error.setValue(response.message); break
            case "loaded": if (this.playing.getValue()) {this.send({type: "play"})}; break
        }
    }
}
