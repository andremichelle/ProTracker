import css from "./Mixer.sass?inline"
import {Arrays, Lifecycle, Terminable} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {PluginLink, PluginParams} from "@/wclap/PluginLink"

const className = Html.adoptStyleSheet(css, "Mixer")

const panText = (value: number): string => {
    const percent = Math.round(value * 100)
    return percent === 0 ? "C" : `${percent < 0 ? "L" : "R"}${Math.abs(percent)}`
}

const percentText = (value: number): string => `${Math.round(value * 100)}%`

type FaderConstruct = {
    lifecycle: Lifecycle
    link: PluginLink
    id: number
    label: string
    min: number
    max: number
    format: (value: number) => string
}

/** A small track and dot, one gesture per drag, double-click resets. Pointer driven, so it never takes the focus. */
const Fader = ({lifecycle, link, id, label, min, max, format}: FaderConstruct) => {
    const display = Inject.value("")
    const dot: HTMLElement = <i/>
    const track: HTMLElement = <div className="track">{dot}</div>
    const gesture = {pointer: -1}
    const valueAt = (clientX: number): number => {
        const {left, width} = track.getBoundingClientRect()
        const ratio = Math.max(0, Math.min(1, (clientX - left) / width))
        return Math.round((min + ratio * (max - min)) * 100) / 100
    }
    const end = (event: PointerEvent) => {
        if (event.pointerId !== gesture.pointer) {return}
        gesture.pointer = -1
        link.endParam(id)
    }
    lifecycle.ownAll(
        Events.subscribe(track, "pointerdown", event => {
            if (gesture.pointer !== -1 || event.button !== 0) {return}
            gesture.pointer = event.pointerId
            track.setPointerCapture(event.pointerId)
            link.beginParam(id)
            link.setParam(id, valueAt(event.clientX))
        }),
        Events.subscribe(track, "pointermove", event => {
            if (event.pointerId === gesture.pointer) {link.setParam(id, valueAt(event.clientX))}
        }),
        Events.subscribe(track, "pointerup", end),
        Events.subscribe(track, "pointercancel", end),
        Events.subscribe(track, "dblclick", () => link.changeParam(id, PluginParams.Defaults[id])),
        link.params[id].catchupAndSubscribe(owner => {
            const value = owner.getValue()
            dot.style.left = `${(value - min) / (max - min) * 100}%`
            display.value = format(value)
        }))
    return (
        <div className="fader">
            <span className="name">{label}</span>
            {track}
            <span className="value">{display}</span>
        </div>
    )
}

type SwitchConstruct = {
    lifecycle: Lifecycle
    label: string
    tooltip: string
    isOn: () => boolean
    watch: ReadonlyArray<number>
    link: PluginLink
    onClick: () => void
}

const Switch = ({lifecycle, label, tooltip, isOn, watch, link, onClick}: SwitchConstruct) => {
    const button: HTMLButtonElement = <button type="button" className="switch" title={tooltip} onclick={onClick}>{label}</button>
    button.tabIndex = -1
    const update = () => button.classList.toggle("on", isOn())
    lifecycle.ownAll(...watch.map((id): Terminable => link.params[id].catchupAndSubscribe(update)))
    return button
}

type Construct = {
    lifecycle: Lifecycle
    link: PluginLink
}

/** Pan, volume, mute and solo per Paula channel, the stereo separation and the output switches. */
export const Mixer = ({lifecycle, link}: Construct) => {
    const value = (id: number): number => link.params[id].getValue()
    const muted = (channel: number): boolean => value(PluginParams.Mute + channel) >= 0.5
    const soloed = (channel: number): boolean =>
        !muted(channel) && Arrays.create(index => index, 4).every(other => other === channel || muted(other))
    const solo = (channel: number) => {
        const release = soloed(channel)
        for (let other = 0; other < 4; other++) {
            const target = release || other === channel ? 0 : 1
            if (value(PluginParams.Mute + other) !== target) {link.changeParam(PluginParams.Mute + other, target)}
        }
    }
    const mutes = Arrays.create(channel => PluginParams.Mute + channel, 4)
    return (
        <div className={className}>
            {Arrays.create(channel => (
                <div className="strip">
                    <div className="head">
                        <span>ch {channel + 1}</span>
                        <Switch lifecycle={lifecycle} link={link} label="M" tooltip="Mute" watch={mutes}
                                isOn={() => muted(channel)}
                                onClick={() => link.changeParam(PluginParams.Mute + channel, muted(channel) ? 0 : 1)}/>
                        <Switch lifecycle={lifecycle} link={link} label="S" tooltip="Solo" watch={mutes}
                                isOn={() => soloed(channel)} onClick={() => solo(channel)}/>
                    </div>
                    <Fader lifecycle={lifecycle} link={link} id={PluginParams.Pan + channel} label="pan"
                           min={-1} max={1} format={panText}/>
                    <Fader lifecycle={lifecycle} link={link} id={PluginParams.Volume + channel} label="vol"
                           min={0} max={1} format={percentText}/>
                </div>
            ), 4)}
            <div className="strip master">
                <div className="head">
                    <span>out</span>
                    <Switch lifecycle={lifecycle} link={link} label="A500" tooltip="A500 output filter"
                            watch={[PluginParams.Filter]} isOn={() => value(PluginParams.Filter) >= 0.5}
                            onClick={() => link.changeParam(PluginParams.Filter, value(PluginParams.Filter) >= 0.5 ? 0 : 1)}/>
                    <Switch lifecycle={lifecycle} link={link} label="Declick" tooltip="Ramp volume changes and note starts"
                            watch={[PluginParams.Declick]} isOn={() => value(PluginParams.Declick) >= 0.5}
                            onClick={() => link.changeParam(PluginParams.Declick, value(PluginParams.Declick) >= 0.5 ? 0 : 1)}/>
                </div>
                <Fader lifecycle={lifecycle} link={link} id={PluginParams.Separation} label="sep"
                       min={0} max={1} format={percentText}/>
            </div>
        </div>
    )
}
