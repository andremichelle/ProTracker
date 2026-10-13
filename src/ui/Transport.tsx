import css from "./Transport.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {ModuleSelect} from "@/ui/components/ModuleSelect"

const className = Html.adoptStyleSheet(css, "Transport")

export type ViewMode = "tracker" | "visualizer" | "ascii3d" | "webgl"

const VIEW_MODES: ReadonlyArray<{mode: ViewMode, label: string}> = [
    {mode: "tracker", label: "Tracker"},
    {mode: "visualizer", label: "ASCII view"},
    {mode: "ascii3d", label: "3D ASCII"},
    {mode: "webgl", label: "WebGL"}
]

/** mm:ss, capped at 99 minutes. */
export const formatElapsed = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000)
    const minutes = Math.min(99, Math.floor(totalSeconds / 60))
    return `${minutes.toString().padStart(2, "0")}:${(totalSeconds % 60).toString().padStart(2, "0")}`
}

const isTypingTarget = (target: Nullable<EventTarget>): boolean =>
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
    const loadFromUrl = () => {
        const url = urlInput.value.trim()
        if (url !== "") {player.loadFromUrl(url).then()}
    }
    const urlInput: HTMLInputElement = (
        <input type="url" className="url" placeholder="https://.../module.mod" size={22}
               onkeydown={(event: KeyboardEvent) => {if (event.key === "Enter") {loadFromUrl()}}}/>
    )
    const modeButtons = VIEW_MODES.map(({mode, label}) => {
        const button: HTMLButtonElement = (
            <button className="mode" type="button" onclick={() => viewMode.setValue(mode)}>{label}</button>
        )
        lifecycle.own(viewMode.catchupAndSubscribe(owner => {
            const active = owner.getValue() === mode
            button.disabled = active
            button.setAttribute("aria-pressed", String(active))
        }))
        return button
    })
    lifecycle.own(player.error.catchupAndSubscribe(owner => error.value = owner.getValue()))
    lifecycle.own(player.module.catchupAndSubscribe(option => title.value = option.mapOr(module => module.title || "(untitled)", "")))
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        speed.value = isDefined(status) ? `${status.speed} / ${status.tempo}` : ""
        timer.value = isDefined(status) ? `${status.tickHz.toFixed(2)} Hz` : ""
        elapsed.value = formatElapsed(player.elapsedMs)
    }))
    lifecycle.own(Events.subscribe(window, "keydown", event => {
        if (isTypingTarget(event.target)) {return}
        if (event.key === " ") {
            event.preventDefault()
            if (player.playing.getValue()) {
                player.stop()
            } else {
                player.play().catch(reason => player.error.setValue(String(reason)))
            }
        } else if (event.key >= "1" && event.key <= "4") {
            viewMode.setValue(VIEW_MODES[Number(event.key) - 1].mode)
        }
    }))
    return (
        <div className={className}>
            <div className="line">
                <span className="brand">ProTracker 2.3A</span>
                {modeButtons}
                <Button lifecycle={lifecycle} label="Play" primary enabled={stopped}
                        onClick={() => player.play().catch(reason => player.error.setValue(String(reason)))}/>
                <Button lifecycle={lifecycle} label="Stop" enabled={player.playing} onClick={() => player.stop()}/>
                <Button lifecycle={lifecycle} label="Open…" onClick={() => fileInput.click()}/>
                {fileInput}
                <ModuleSelect lifecycle={lifecycle} player={player} initial={initialModule}/>
                {urlInput}
                <Button lifecycle={lifecycle} label="Load URL" onClick={loadFromUrl}/>
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
