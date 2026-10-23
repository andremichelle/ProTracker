import css from "./Channels.sass?inline"
import {Arrays, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Replayer} from "@/Replayer"
import {noteName} from "@/Module"

const className = Html.adoptStyleSheet(css, "Channels")

type Construct = {
    lifecycle: Lifecycle
    player: Replayer
}

/** Paula's four channels: period as a note, the level as a bar falling back slowly, or the volume register where
 * the host does not measure levels. */
export const Channels = ({lifecycle, player}: Construct) => {
    const notes = Arrays.create(() => Inject.value("---"), 4)
    const bars: ReadonlyArray<HTMLElement> = Arrays.create(() => <i/>, 4)
    const shown = Arrays.create(() => 0, 4)
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        for (let index = 0; index < 4; index++) {
            const channel = isDefined(status) ? status.channels[index] : undefined
            const active = isDefined(channel) && channel.dma
            notes[index].value = active ? noteName(channel.period) : "---"
            const level = isDefined(channel) && isDefined(channel.level)
                ? Math.max(channel.level, shown[index] * 0.85)
                : active ? channel.volume / 64 : 0
            shown[index] = level
            bars[index].style.width = `${level * 100}%`
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
