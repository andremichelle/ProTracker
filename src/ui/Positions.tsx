import css from "./Positions.sass?inline"
import {int, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"

const className = Html.adoptStyleSheet(css, "Positions")

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

/** The song's position list: which pattern plays at which position. */
export const Positions = ({lifecycle, player}: Construct) => {
    const list: HTMLDivElement = <div className="list"/>
    let items: ReadonlyArray<HTMLElement> = []
    let shown: int = -1
    lifecycle.own(player.module.catchupAndSubscribe(option => {
        items = option.mapOr(module => module.positions.map((pattern, index) => (
            <div className="item">
                <span>{index.toString().padStart(3, "0")}</span>
                <span>{pattern.toString().padStart(3, "0")}</span>
            </div>
        )), [])
        replaceChildren(list, ...items)
        shown = -1
    }))
    lifecycle.own(AnimationFrame.add(() => {
        const status = player.currentStatus
        const pos = isDefined(status) ? status.pos : 0
        if (pos === shown) {return}
        items[shown]?.classList.remove("current")
        items[pos]?.classList.add("current")
        items[pos]?.scrollIntoView({block: "nearest"})
        shown = pos
    }))
    return (
        <div className={className}>
            <div className="head">pos pat</div>
            {list}
        </div>
    )
}
