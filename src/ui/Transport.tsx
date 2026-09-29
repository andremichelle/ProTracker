import css from "./Transport.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {Button} from "@/ui/components/Button"
import {Checkbox} from "@/ui/components/Checkbox"
import {ModuleSelect} from "@/ui/components/ModuleSelect"

const className = Html.adoptStyleSheet(css, "Transport")

type Construct = {
    lifecycle: Lifecycle
    player: Player
    initialModule: string
}

export const Transport = ({lifecycle, player, initialModule}: Construct) => {
    const title = Inject.value("")
    const speed = Inject.value("")
    const timer = Inject.value("")
    const error = Inject.value("")
    const stopped = lifecycle.own(new DefaultObservableValue(true))
    lifecycle.own(player.playing.catchupAndSubscribe(owner => stopped.setValue(!owner.getValue())))
    const fileInput: HTMLInputElement = (
        <input type="file" accept=".mod,.MOD" hidden
               onchange={async () => {
                   const file = fileInput.files?.[0]
                   if (isDefined(file)) {player.load(new Uint8Array(await file.arrayBuffer()))}
               }}/>
    )
    lifecycle.own(player.error.catchupAndSubscribe(owner => error.value = owner.getValue()))
    lifecycle.own(player.module.catchupAndSubscribe(option => title.value = option.mapOr(module => module.title || "(untitled)", "")))
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        speed.value = isDefined(status) ? `${status.speed} / ${status.tempo}` : ""
        timer.value = isDefined(status) ? `${status.tickHz.toFixed(2)} Hz` : ""
    }))
    return (
        <div className={className}>
            <div className="line">
                <span className="brand">ProTracker 2.3A</span>
                <Button lifecycle={lifecycle} label="Play" primary enabled={stopped}
                        onClick={() => player.play().catch(reason => player.error.setValue(String(reason)))}/>
                <Button lifecycle={lifecycle} label="Stop" enabled={player.playing} onClick={() => player.stop()}/>
                <Button lifecycle={lifecycle} label="Open…" onClick={() => fileInput.click()}/>
                {fileInput}
                <ModuleSelect lifecycle={lifecycle} player={player} initial={initialModule}/>
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
                </span>
            </div>
            <div className="error">{error}</div>
        </div>
    )
}
