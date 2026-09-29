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
    private status: Nullable<Status> = null

    constructor(private readonly baseUrl: string) {
        this.filter.subscribe(owner => this.send({type: "filter", value: owner.getValue()}))
        this.led.subscribe(owner => this.send({type: "led", value: owner.getValue()}))
        this.declick.subscribe(owner => this.send({type: "declick", value: owner.getValue()}))
    }

    get currentStatus(): Nullable<Status> {return this.status}

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

    load(bytes: Uint8Array): void {
        const result = tryCatch(() => Module.parse(bytes))
        if (result.status === "failure") {
            this.error.setValue(String(result.error))
            return
        }
        this.status = null
        this.error.setValue("")
        this.module.wrap(result.value)
        this.send({type: "module", module: result.value.data})
    }

    /** Must be called from a user gesture the first time. */
    async play(): Promise<void> {
        await this.ensureNode()
        await this.context.unwrap().resume()
        this.send({type: "play"})
        this.playing.setValue(true)
    }

    stop(): void {
        this.send({type: "stop"})
        this.playing.setValue(false)
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
        node.port.onmessage = (event: MessageEvent<Response>) => this.onResponse(event.data)
        node.connect(context.destination)
        this.node = Option.wrap(node)
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
