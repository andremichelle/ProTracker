import css from "./PatternView.sass?inline"
import {int, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {AnimationFrame, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {cellText, Pattern} from "@/Module"

const className = Html.adoptStyleSheet(css, "PatternView")
const ROW_HEIGHT_EM = 1.5   // keep in sync with --row-height in PatternView.sass

type Construct = {
    lifecycle: Lifecycle
    player: Player
}

/** The step table: the current pattern's 64 rows, scrolled so the playing row stays in view and the table stays full. */
export const PatternView = ({lifecycle, player}: Construct) => {
    const label = Inject.value("")
    const rows: HTMLDivElement = <div className="rows"/>
    const viewport: HTMLDivElement = <div className="viewport">{rows}</div>
    let rowElements: ReadonlyArray<HTMLElement> = []
    let shownPattern: int = -1
    let shownRow: int = -1
    let shownOffset: int = -1
    let rowHeight = 0
    let visibleRows = 1
    const build = (index: int, pattern: Pattern) => {
        rowElements = pattern.map((row, rowIndex) => (
            <div className={Html.buildClassList("row", rowIndex % 4 === 0 && "beat")}>
                <span className="index">{rowIndex.toString(16).toUpperCase().padStart(2, "0")}</span>
                {row.map(cell => {
                    const empty = cell.period === 0 && cell.sample === 0 && cell.effect === 0 && cell.arg === 0
                    return <span className={Html.buildClassList("cell", empty && "empty")}>{cellText(cell)}</span>
                })}
            </div>
        ))
        replaceChildren(rows, ...rowElements)
        label.value = `pattern ${index.toString().padStart(2, "0")}`
        shownPattern = index
        shownRow = -1
        shownOffset = -1
    }
    const measure = () => {
        rowHeight = parseFloat(getComputedStyle(viewport).fontSize) * ROW_HEIGHT_EM
        visibleRows = Math.max(1, Math.floor(viewport.clientHeight / rowHeight))
        shownOffset = -1
    }
    const update = () => {
        const module = player.module.unwrapOrNull()
        if (!isDefined(module)) {return}
        const status = player.currentStatus
        const pattern = isDefined(status) ? status.pattern : module.positions[0] ?? 0
        const row = isDefined(status) ? status.row : 0
        if (pattern !== shownPattern && pattern < module.patterns.length) {build(pattern, module.patterns[pattern])}
        if (row !== shownRow) {
            rowElements[shownRow]?.classList.remove("current")
            rowElements[row]?.classList.add("current")
            shownRow = row
        }
        const offset = Math.max(0, Math.min(row - Math.floor(visibleRows / 2), rowElements.length - visibleRows))
        if (offset !== shownOffset) {
            rows.style.transform = `translateY(${-offset * rowHeight}px)`
            shownOffset = offset
        }
    }
    lifecycle.own(Html.watchResize(viewport, measure))
    lifecycle.own(AnimationFrame.add(update))
    lifecycle.own(player.module.subscribe(() => shownPattern = -1))
    return (
        <div className={className}>
            <div className="head">
                <span className="index">{label}</span>
                <span className="cell">ch 1</span>
                <span className="cell">ch 2</span>
                <span className="cell">ch 3</span>
                <span className="cell">ch 4</span>
            </div>
            {viewport}
        </div>
    )
}
