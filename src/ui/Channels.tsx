import css from "./Channels.sass?inline"
import {Arrays, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {noteName} from "@/Module"

const className = Html.adoptStyleSheet(css, "Channels")

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

/** Paula's four channels: period as a note, volume as a bar. */
export const Channels = ({lifecycle, player}: Construct) => {
    const notes = Arrays.create(() => Inject.value("---"), 4)
    const bars: ReadonlyArray<HTMLElement> = Arrays.create(() => <i/>, 4)
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        for (let index = 0; index < 4; index++) {
            const channel = isDefined(status) ? status.channels[index] : undefined
            const active = isDefined(channel) && channel.dma
            notes[index].value = active ? noteName(channel.period) : "---"
            bars[index].style.width = `${active ? channel.volume / 64 * 100 : 0}%`
        }
    }))
    return (
        <div className={className}>
            {Arrays.create(index => (
                <div className="channel">
                    <span className="label">ch {index + 1}</span>
                    <span className="note">{notes[index]}</span>
                    <span className="meter">{bars[index]}</span>
                </div>
            ), 4)}
        </div>
    )
}
