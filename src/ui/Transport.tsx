import css from "./Transport.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {ModuleSelect} from "@/ui/components/ModuleSelect"

const className = Html.adoptStyleSheet(css, "Transport")

export type ViewMode = "tracker" | "visualizer" | "ascii3d" | "webgl"
const VIEW_MODES: ReadonlyArray<ViewMode> = ["tracker", "visualizer", "ascii3d", "webgl"]

// DOS-tracker-style elapsed playback clock: mm:ss, rolling over past 99:59 rather than growing wider.
const formatElapsed = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.min(99, Math.floor(totalSeconds / 60))
    const seconds = totalSeconds % 60
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
}

const isTypingTarget = (target: EventTarget | null): boolean =>
    target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement

type Construct = {
    lifecycle: Lifecycle
    player: Player
    initialModule: string
    viewMode: DefaultObservableValue<ViewMode>
}

export const Transport = ({lifecycle, player, initialModule, viewMode}: Construct) => {
    const title = Inject.value("")
    const speed = Inject.value("")
    const timer = Inject.value("")
    const elapsed = Inject.value("00:00")
    const error = Inject.value("")
    const stopped = lifecycle.own(new DefaultObservableValue(true))
    lifecycle.own(player.playing.catchupAndSubscribe(owner => stopped.setValue(!owner.getValue())))
    const fileInput: HTMLInputElement = (
        <input type="file" accept=".mod,.MOD"
               onchange={async () => {
                   const file = fileInput.files?.[0]
                   if (isDefined(file)) {player.load(new Uint8Array(await file.arrayBuffer()))}
               }}/>
    )
    fileInput.hidden = true
    const urlInput: HTMLInputElement = (
        <input type="url" className="url" placeholder="https://.../module.mod" size={22}
               onkeydown={(event: KeyboardEvent) => {
                   if (event.key === "Enter") {loadUrlButton.click()}
               }}/>
    )
    const loadUrlButton: HTMLButtonElement = (
        <button className="mode" type="button"
                onclick={() => {
                    const url = urlInput.value.trim()
                    if (url !== "") {player.loadFromUrl(url).catch(reason => player.error.setValue(String(reason)))}
                }}>Load URL</button>
    )
    const trackerButton: HTMLButtonElement = (
        <button className="mode" type="button" aria-pressed="true"
                onclick={() => viewMode.setValue("tracker")}>Tracker</button>
    )
    const visualizerButton: HTMLButtonElement = (
        <button className="mode" type="button" aria-pressed="false"
                onclick={() => viewMode.setValue("visualizer")}>ASCII view</button>
    )
    const ascii3dButton: HTMLButtonElement = (
        <button className="mode" type="button" aria-pressed="false"
                onclick={() => viewMode.setValue("ascii3d")}>3D ASCII</button>
    )
    const webglButton: HTMLButtonElement = (
        <button className="mode" type="button" aria-pressed="false"
                onclick={() => viewMode.setValue("webgl")}>WebGL</button>
    )
    lifecycle.own(viewMode.catchupAndSubscribe(owner => {
        const mode = owner.getValue()
        trackerButton.disabled = mode === "tracker"
        trackerButton.setAttribute("aria-pressed", String(mode === "tracker"))
        visualizerButton.disabled = mode === "visualizer"
        visualizerButton.setAttribute("aria-pressed", String(mode === "visualizer"))
        ascii3dButton.disabled = mode === "ascii3d"
        ascii3dButton.setAttribute("aria-pressed", String(mode === "ascii3d"))
        webglButton.disabled = mode === "webgl"
        webglButton.setAttribute("aria-pressed", String(mode === "webgl"))
    }))
    lifecycle.own(player.error.catchupAndSubscribe(owner => error.value = owner.getValue()))
    lifecycle.own(player.module.catchupAndSubscribe(option => title.value = option.mapOr(module => module.title || "(untitled)", "")))
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        speed.value = isDefined(status) ? `${status.speed} / ${status.tempo}` : ""
        timer.value = isDefined(status) ? `${status.tickHz.toFixed(2)} Hz` : ""
        elapsed.value = formatElapsed(player.elapsedMs)
    }))
    lifecycle.own(Events.subscribe(window, "keydown", event => {
        const keyboardEvent = event as KeyboardEvent
        if (isTypingTarget(keyboardEvent.target)) {return}
        if (keyboardEvent.key === " ") {
            keyboardEvent.preventDefault()
            if (player.playing.getValue()) {
                player.stop()
            } else {
                player.play().catch(reason => player.error.setValue(String(reason)))
            }
        } else if (keyboardEvent.key >= "1" && keyboardEvent.key <= "4") {
            viewMode.setValue(VIEW_MODES[Number(keyboardEvent.key) - 1])
        }
    }))
    return (
        <div className={className}>
            <div className="line">
                <span className="brand">ProTracker+ Version 4.2B</span>
                {trackerButton}
                {visualizerButton}
                {ascii3dButton}
                {webglButton}
                <Button lifecycle={lifecycle} label="Play" primary enabled={stopped}
                        onClick={() => player.play().catch(reason => player.error.setValue(String(reason)))}/>
                <Button lifecycle={lifecycle} label="Stop" enabled={player.playing} onClick={() => player.stop()}/>
                <Button lifecycle={lifecycle} label="Open…" onClick={() => fileInput.click()}/>
                {fileInput}
                <ModuleSelect lifecycle={lifecycle} player={player} initial={initialModule}/>
                {urlInput}
                {loadUrlButton}
                <Checkbox lifecycle={lifecycle} model={player.filter} label="A500 filter"
                          tooltip="Fixed 6 dB/oct low-pass of the A500 output stage"/>
                <Checkbox lifecycle={lifecycle} model={player.led} label="LED filter"
                          tooltip="The switchable 12 dB/oct filter, E0x in the song overrides it"/>
                <Checkbox lifecycle={lifecycle} model={player.declick} label="declick"
                          tooltip="1 ms ramps on volume changes and note starts, like modern players"/>
                <span className="info">
                    <b>{title}</b>
                    <span>{speed}</span>
                    <span>{timer}</span>
                    <span className="elapsed" title="Elapsed playback time">{elapsed}</span>
                </span>
                <a className="repo" href="https://github.com/andremichelle/ProTracker" target="_blank"
                   rel="noopener" title="Source on GitHub">GitHub</a>
            </div>
            <div className="error">{error}</div>
        </div>
    )
}
