import css from "./SampleEditor.sass?inline"
import {int, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {MAX_SAMPLE_BYTES, Module, Sample, SampleHeader} from "@/Module"
import {Button} from "@/ui/components/Button"
import {PluginLink} from "@/wclap/PluginLink"

const className = Html.adoptStyleSheet(css, "SampleEditor")

// the rate a loaded sound is resampled to, so it plays at its own pitch on this note (PAL clock / period / 2 bytes)
const PITCHES: ReadonlyArray<{ name: string, rate: int }> = [
    {name: "C-1", rate: 4144}, {name: "C-2", rate: 8287}, {name: "C-3", rate: 16574}
]

type Construct = {
    lifecycle: Lifecycle
    link: PluginLink
}

const field = (className: string): HTMLInputElement => {
    const input: HTMLInputElement = <input className={className} data-keep-focus=""/>
    input.spellcheck = false
    input.autocomplete = "off"
    return input
}

// the rate C-2 plays a sample at (PAL colour clock / period 428), finetune moves it in eighths of a semitone
const C2_RATE = 8287

const even = (value: number): int => Math.max(0, Math.round(value / 2) * 2)

/** The 31 sample slots: name, volume, finetune and loop, edited in place, the loop also by its markers on the waveform.
 * Load puts any sound the browser decodes into a slot, Clear empties it. */
export const SampleEditor = ({lifecycle, link}: Construct) => {
    let selected: int = 0
    let shown: Nullable<Sample> = null
    let loop: { start: int, end: int } = {start: 0, end: 0}
    let dragging: Nullable<"start" | "end"> = null
    const list: HTMLDivElement = <div className="list"/>
    const name = field("name")
    name.maxLength = 22
    const volume = field("number")
    const finetune = field("number")
    const loopStart = field("number")
    const loopLength = field("number")
    const info: HTMLSpanElement = <span className="info"/>
    const canvas: HTMLCanvasElement = <canvas/>
    const pitch: HTMLSelectElement = (
        <select data-keep-focus="">{PITCHES.map(({name}) => <option value={name}>{name}</option>)}</select>
    )
    pitch.value = "C-2"
    const fileInput: HTMLInputElement = <input type="file" accept="audio/*,.wav,.aif,.aiff,.mp3,.ogg,.flac"/>
    fileInput.hidden = true
    const sampleOf = (module: Module): Sample => module.samples[selected]
    const hasLoop = (): boolean => loop.end - loop.start > 2
    let audio: Nullable<AudioContext> = null
    let voice: Nullable<{ source: AudioBufferSourceNode, rate: number }> = null
    const previewButton = <Button lifecycle={lifecycle} label="Preview" onClick={() => preview()}/>
    const stopPreview = (): void => {
        voice?.source.stop()
        voice = null
        previewButton.textContent = "Preview"
    }
    const loopVoice = (): void => {
        if (!isDefined(voice)) {return}
        voice.source.loop = hasLoop()
        voice.source.loopStart = loop.start / voice.rate
        voice.source.loopEnd = loop.end / voice.rate
    }
    // the sample at C-2 with its finetune and volume, through the page's own audio, looping until stopped if it loops
    const preview = (): void => {
        if (isDefined(voice)) {
            stopPreview()
            return
        }
        if (!isDefined(shown) || shown.data.length === 0) {return}
        const context = audio ?? new AudioContext()
        audio = context
        context.resume().then()
        const fine = Number(finetune.value)
        const vol = Number(volume.value)
        const rate = C2_RATE * 2 ** ((Number.isInteger(fine) ? Math.max(-8, Math.min(7, fine)) : shown.finetune) / 96)
        const gain = (Number.isFinite(vol) ? Math.max(0, Math.min(64, vol)) : shown.volume) / 64
        const buffer = context.createBuffer(1, shown.data.length, rate)
        const channel = buffer.getChannelData(0)
        shown.data.forEach((value, index) => channel[index] = value / 128 * gain)
        const source = context.createBufferSource()
        source.buffer = buffer
        source.connect(context.destination)
        source.onended = () => {if (voice?.source === source) {stopPreview()}}
        voice = {source, rate}
        loopVoice()
        source.start()
        previewButton.textContent = "Stop"
    }
    const draw = (): void => {
        const context = canvas.getContext("2d")
        if (!isDefined(context)) {return}
        const ratio = window.devicePixelRatio
        const width = Math.max(1, Math.round(canvas.clientWidth * ratio))
        const height = Math.max(1, Math.round(canvas.clientHeight * ratio))
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width
            canvas.height = height
        }
        const style = getComputedStyle(canvas)
        context.clearRect(0, 0, width, height)
        if (!isDefined(shown) || shown.length === 0) {return}
        const {data, length} = shown
        const x = (bytes: number) => bytes / length * width
        if (hasLoop()) {
            context.fillStyle = style.getPropertyValue("--loop")
            context.fillRect(x(loop.start), 0, x(loop.end) - x(loop.start), height)
        }
        context.fillStyle = style.getPropertyValue("--wave")
        const middle = height / 2
        for (let column = 0; column < width; column++) {
            const from = Math.floor(column / width * data.length)
            const to = Math.max(from + 1, Math.floor((column + 1) / width * data.length))
            let low = 0, high = 0
            for (let index = from; index < to && index < data.length; index++) {
                if (data[index] < low) {low = data[index]}
                if (data[index] > high) {high = data[index]}
            }
            context.fillRect(column, middle - high / 128 * middle, 1, Math.max(1, (high - low) / 128 * middle))
        }
        if (hasLoop()) {
            context.fillStyle = style.getPropertyValue("--marker")
            context.fillRect(Math.min(width - ratio, x(loop.start)), 0, ratio, height)
            context.fillRect(Math.max(0, x(loop.end) - ratio), 0, ratio, height)
        }
    }
    const fill = (): void => {
        if (!isDefined(shown)) {return}
        if (document.activeElement !== name) {name.value = shown.name}
        volume.value = String(shown.volume)
        finetune.value = String(shown.finetune)
        loop = shown.loopLength > 2
            ? {start: shown.loopStart, end: Math.min(shown.length, shown.loopStart + shown.loopLength)}
            : {start: 0, end: 0}
        loopStart.value = String(loop.start)
        loopLength.value = String(hasLoop() ? loop.end - loop.start : 0)
        info.textContent = shown.length === 0 ? "empty"
            : `${shown.length} bytes, ${(shown.length / 8287).toFixed(2)} s at C-2`
        for (const input of [name, volume, finetune, loopStart, loopLength]) {input.classList.remove("invalid")}
        draw()
    }
    const render = (): void => {
        const module = link.module.unwrapOrNull()
        if (!isDefined(module)) {return}
        replaceChildren(list, ...module.samples.map((sample, slot) => (
            <div className={Html.buildClassList("slot", slot === selected && "selected", sample.length === 0 && "empty")}
                 onclick={() => {
                     if (selected !== slot) {stopPreview()}
                     selected = slot
                     render()
                 }}>
                <span className="number">{(slot + 1).toString(16).toUpperCase().padStart(2, "0")}</span>
                <span className="title">{sample.name}</span>
                <span className="length">{sample.length === 0 ? "" : sample.length.toString(16).toUpperCase()}</span>
            </div>
        )))
        shown = sampleOf(module)
        if (dragging === null) {fill()}
    }
    // the header the fields and markers describe, null where a field is no valid value
    const read = (): Nullable<SampleHeader> => {
        if (!isDefined(shown)) {return null}
        const number = (input: HTMLInputElement, min: int, max: int): Nullable<int> => {
            const value = Number(input.value.trim())
            const valid = input.value.trim() !== "" && Number.isInteger(value) && value >= min && value <= max
            input.classList.toggle("invalid", !valid)
            return valid ? value : null
        }
        const vol = number(volume, 0, 64)
        const fine = number(finetune, -8, 7)
        if (!isDefined(vol) || !isDefined(fine)) {return null}
        return {
            name: name.value, length: shown.length, finetune: fine, volume: vol,
            loopStart: hasLoop() ? loop.start : 0, loopLength: hasLoop() ? loop.end - loop.start : 2
        }
    }
    const apply = (): void => {
        const header = read()
        if (isDefined(header)) {link.setSampleHeader(selected, header)}
    }
    // the loop fields typed in: start and length in bytes, both even, inside the sample, length 0 is no loop
    const applyLoopFields = (): void => {
        if (!isDefined(shown)) {return}
        const start = even(Number(loopStart.value))
        const length = even(Number(loopLength.value))
        const valid = Number.isFinite(start) && Number.isFinite(length) && start + length <= shown.length
        loopStart.classList.toggle("invalid", !valid)
        loopLength.classList.toggle("invalid", !valid)
        if (!valid) {return}
        loop = length > 2 ? {start, end: start + length} : {start: 0, end: 0}
        loopVoice()
        apply()
        draw()
    }
    const bytesAt = (event: PointerEvent): int => {
        const rect = canvas.getBoundingClientRect()
        return even(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * (shown?.length ?? 0))
    }
    const load = async (file: File): Promise<void> => {
        const rate = PITCHES.find(({name}) => name === pitch.value)?.rate ?? 8287
        const decoded = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await file.arrayBuffer())
            .catch(() => null)
        if (!isDefined(decoded)) {
            link.error.setValue(`${file.name} is no sound the browser can read`)
            return
        }
        const frames = Math.min(decoded.length, MAX_SAMPLE_BYTES) & ~1
        const mono = new Float32Array(frames)
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
            const samples = decoded.getChannelData(channel)
            for (let index = 0; index < frames; index++) {mono[index] += samples[index] / decoded.numberOfChannels}
        }
        const peak = mono.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
        const data = new Int8Array(frames)
        for (let index = 0; index < frames; index++) {
            data[index] = Math.max(-128, Math.min(127, Math.round(peak > 0 ? mono[index] / peak * 127 : 0)))
        }
        const title = file.name.replace(/\.[^.]*$/, "").slice(0, 22)
        link.setSample(selected, {name: title, length: frames, finetune: 0, volume: 64, loopStart: 0, loopLength: 2}, data)
        link.error.setValue(decoded.length > frames + 1 ? `${file.name} was cut to ${frames} bytes` : "")
    }
    const element: HTMLDivElement = (
        <div className={className}>
            {list}
            <div className="detail">
                <div className="fields">
                    <label>name {name}</label>
                    <label>vol {volume}</label>
                    <label>fine {finetune}</label>
                    <label>loop {loopStart}</label>
                    <label>len {loopLength}</label>
                </div>
                <div className="wave">{canvas}</div>
                <div className="actions">
                    {info}
                    {previewButton}
                    <label>load at {pitch}</label>
                    <Button lifecycle={lifecycle} label="Load..." onClick={() => fileInput.click()}/>
                    <Button lifecycle={lifecycle} label="Clear" onClick={() => {
                        if (!isDefined(shown) || shown.length === 0) {return}
                        link.setSample(selected, {name: "", length: 0, finetune: 0, volume: 0, loopStart: 0, loopLength: 2}, new Int8Array(0))
                    }}/>
                    {fileInput}
                </div>
                <div className="hint">drag the loop markers on the waveform, drop a sound to load it, Enter applies a field</div>
            </div>
        </div>
    )
    lifecycle.ownAll(
        {terminate: () => {
            stopPreview()
            audio?.close().then()
        }},
        link.module.catchupAndSubscribe(() => render()),
        Html.watchResize(canvas, draw),
        Events.subscribe(fileInput, "change", () => {
            const file = fileInput.files?.[0]
            if (isDefined(file)) {load(file).then()}
            fileInput.value = ""
        }),
        ...[name, volume, finetune].flatMap(input => [
            Events.subscribe(input, "change", apply),
            Events.subscribe(input, "keydown", (event: KeyboardEvent) => {if (event.key === "Enter") {apply()}})
        ]),
        ...[loopStart, loopLength].flatMap(input => [
            Events.subscribe(input, "change", applyLoopFields),
            Events.subscribe(input, "keydown", (event: KeyboardEvent) => {if (event.key === "Enter") {applyLoopFields()}})
        ]),
        Events.subscribe(element, "dragover", event => {
            event.preventDefault()
            event.stopPropagation()
        }),
        Events.subscribe(element, "drop", (event: DragEvent) => {
            event.preventDefault()
            event.stopPropagation()
            const file = event.dataTransfer?.files[0]
            if (isDefined(file)) {load(file).then()}
        }),
        Events.subscribe(canvas, "pointerdown", (event: PointerEvent) => {
            const sample = shown
            if (!isDefined(sample) || sample.length === 0) {return}
            const at = bytesAt(event)
            const near = (bytes: int) => Math.abs(bytes - at) / sample.length * canvas.clientWidth < 8
            if (!hasLoop()) {
                loop = {start: at, end: Math.min(sample.length, at + 2)}
                dragging = "end"
            } else if (near(loop.start) && !near(loop.end)) {
                dragging = "start"
            } else if (near(loop.end)) {
                dragging = "end"
            } else {
                return
            }
            canvas.setPointerCapture(event.pointerId)
            draw()
        }),
        Events.subscribe(canvas, "pointermove", (event: PointerEvent) => {
            if (dragging === null || !isDefined(shown)) {
                canvas.style.cursor = isDefined(shown) && shown.length > 0 ? "ew-resize" : ""
                return
            }
            const at = bytesAt(event)
            if (dragging === "start") {
                loop = {start: Math.min(at, loop.end - 2), end: loop.end}
            } else {
                loop = {start: loop.start, end: Math.max(at, loop.start + 2)}
            }
            loopStart.value = String(loop.start)
            loopLength.value = String(loop.end - loop.start)
            loopVoice()
            draw()
        }),
        Events.subscribe(canvas, "pointerup", () => {
            if (dragging === null) {return}
            dragging = null
            apply()
        }))
    return element
}
