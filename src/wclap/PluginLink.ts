import {Arrays, DefaultObservableValue, MutableObservableOption, Nullable, Terminable, Terminator, tryCatch} from "@opendaw/lib-std"
import {AnimationFrame, Events} from "@opendaw/lib-dom"
import {Cell, encodeCell, encodeSampleHeader, Module, SampleHeader} from "@/Module"
import {Replayer} from "@/Replayer"
import type {Status} from "@/Status"

// the plugin's param ids (wclap/protracker.c)
export namespace PluginParams {
    export const Pan = 0
    export const Volume = 4
    export const Mute = 8
    export const Separation = 12
    export const Filter = 13
    export const Declick = 14
    export const Count = 15
    // Paula's hard L R R L, full volume, nothing muted, full separation, A500 filter on, declick off
    export const Defaults: ReadonlyArray<number> = [-1, 1, 1, -1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 0]
}

// message types, see webview_receive in wclap/protracker.c
const PAGE_POLL = 1, PAGE_MODULE_REQUEST = 2, PAGE_LOAD = 3, PAGE_PARAM_BEGIN = 4, PAGE_PARAM_SET = 5, PAGE_PARAM_END = 6,
    PAGE_SET_PATTERN = 7, PAGE_INSERT_PATTERN = 8, PAGE_SET_CELL = 9, PAGE_SET_SAMPLE_HEADER = 10, PAGE_SET_SAMPLE = 11
const PLUGIN_STATUS = 1, PLUGIN_MODULE = 2

/** The page's end of the plugin: polls the replayer every frame, fetches the module when it changed, sends edits. */
export class PluginLink implements Replayer, Terminable {
    readonly module = new MutableObservableOption<Module>()
    readonly playing = new DefaultObservableValue(false)
    readonly error = new DefaultObservableValue("")
    readonly params: ReadonlyArray<DefaultObservableValue<number>>

    readonly #terminator = new Terminator()
    readonly #editing = new Set<number>()
    #status: Nullable<Status> = null
    #serial = -1
    #requested = -1

    constructor() {
        this.params = Arrays.create(() => this.#terminator.own(new DefaultObservableValue(0)), PluginParams.Count)
        this.#terminator.ownAll(
            Events.subscribe(window, "message", (event: MessageEvent) => {
                if (event.data instanceof ArrayBuffer) {this.#receive(event.data)}
            }),
            AnimationFrame.add(() => this.#post(new Uint8Array([PAGE_POLL]))))
    }

    get currentStatus(): Nullable<Status> {return this.#status}

    /** Any ProTracker or 15 instrument SoundTracker file, padded like ProTracker's loader does. */
    load(bytes: Uint8Array): void {
        const result = tryCatch(() => Module.parse(bytes))
        if (result.status === "failure") {
            this.error.setValue(String(result.error))
            return
        }
        this.error.setValue("")
        const message = new Uint8Array(4 + result.value.data.length)
        message[0] = PAGE_LOAD
        message.set(result.value.data, 4)
        this.#post(message)
    }

    /** Plays `pattern` at `position`, a pattern past the last one is created empty. */
    setPattern(position: number, pattern: number): void {this.#post(new Uint8Array([PAGE_SET_PATTERN, position, pattern]))}

    /** Inserts a new empty pattern into the song at `position`. */
    insertPattern(position: number): void {this.#post(new Uint8Array([PAGE_INSERT_PATTERN, position]))}

    /** Writes one step of a pattern. */
    setCell(pattern: number, row: number, channel: number, cell: Cell): void {
        const message = new Uint8Array(8)
        message.set([PAGE_SET_CELL, pattern, row, channel])
        message.set(encodeCell(cell), 4)
        this.#post(message)
    }

    /** Name, finetune, volume and loop of a sample slot (0..30), its length stays. */
    setSampleHeader(slot: number, header: SampleHeader): void {
        const message = new Uint8Array(34)
        message.set([PAGE_SET_SAMPLE_HEADER, slot])
        message.set(encodeSampleHeader(header), 4)
        this.#post(message)
    }

    /** New data for a sample slot (0..30) with its header, empty clears the slot. */
    setSample(slot: number, header: SampleHeader, data: Int8Array): void {
        const message = new Uint8Array(34 + data.length)
        message.set([PAGE_SET_SAMPLE, slot])
        message.set(encodeSampleHeader({...header, length: data.length}), 4)
        message.set(new Uint8Array(data.buffer, data.byteOffset, data.length), 34)
        this.#post(message)
    }

    beginParam(id: number): void {
        this.#editing.add(id)
        this.#postParam(PAGE_PARAM_BEGIN, id)
    }

    setParam(id: number, value: number): void {
        this.params[id].setValue(value)
        this.#postParam(PAGE_PARAM_SET, id, value)
    }

    endParam(id: number): void {
        this.#editing.delete(id)
        this.#postParam(PAGE_PARAM_END, id)
    }

    /** One edit from start to end, for buttons. */
    changeParam(id: number, value: number): void {
        this.beginParam(id)
        this.setParam(id, value)
        this.endParam(id)
    }

    terminate(): void {this.#terminator.terminate()}

    #postParam(type: number, id: number, value: number = 0): void {
        const message = new DataView(new ArrayBuffer(type === PAGE_PARAM_SET ? 16 : 8))
        message.setUint8(0, type)
        message.setUint32(4, id, true)
        if (type === PAGE_PARAM_SET) {message.setFloat64(8, value, true)}
        this.#post(new Uint8Array(message.buffer))
    }

    #post(message: Uint8Array): void {window.parent.postMessage(message.buffer, "*")}

    #receive(buffer: ArrayBuffer): void {
        const view = new DataView(buffer)
        if (buffer.byteLength < 1) {return}
        const type = view.getUint8(0)
        if (type === PLUGIN_STATUS && buffer.byteLength >= 32 + PluginParams.Count * 8) {
            this.#status = {
                pos: view.getUint8(2), pattern: view.getUint8(3), row: view.getUint8(4), speed: view.getUint8(5),
                tempo: 0, tickHz: 0,
                channels: Arrays.create(index => ({
                    period: view.getUint16(12 + index * 4, true),
                    volume: view.getUint8(12 + index * 4 + 2),
                    dma: view.getUint8(12 + index * 4 + 3) !== 0,
                    level: view.getUint8(28 + index) / 255
                }), 4)
            }
            this.playing.setValue(view.getUint8(1) !== 0)
            this.params.forEach((param, id) => {
                if (!this.#editing.has(id)) {param.setValue(view.getFloat64(32 + id * 8, true))}
            })
            const serial = view.getUint32(8, true)
            if (serial !== this.#serial && serial !== this.#requested) {
                this.#requested = serial
                this.#post(new Uint8Array([PAGE_MODULE_REQUEST]))
            }
        } else if (type === PLUGIN_MODULE && buffer.byteLength > 8) {
            const result = tryCatch(() => Module.parse(new Uint8Array(buffer, 8)))
            this.#serial = view.getUint32(4, true)
            if (result.status === "success") {this.module.wrap(result.value)} else {this.error.setValue(String(result.error))}
        }
    }
}
