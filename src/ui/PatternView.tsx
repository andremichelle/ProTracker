import css from "./PatternView.sass?inline"
import flyoutCss from "./StepFlyout.sass?inline"
import {int, isDefined, Lifecycle, Nullable} from "@opendaw/lib-std"
import {createElement, Inject, replaceChildren} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Replayer} from "@/Replayer"
import {Cell, cellText, noteName, Pattern, periodOf} from "@/Module"
import {Button} from "@/ui/components/Button"

const className = Html.adoptStyleSheet(css, "PatternView")
const flyoutClassName = Html.adoptStyleSheet(flyoutCss, "StepFlyout")
const ROW_HEIGHT_EM = 1.5   // keep in sync with --row-height in PatternView.sass
const EMPTY: Cell = {period: 0, sample: 0, effect: 0, arg: 0}

/** Applies a step edit, the module comes back changed. */
export interface StepEditor {
    setCell(pattern: int, row: int, channel: int, cell: Cell): void
}

type Construct = {
    lifecycle: Lifecycle
    player: Replayer
    edit?: StepEditor
}

type Step = { pattern: int, row: int, channel: int }

const hex = (value: int, digits: int): string => value.toString(16).toUpperCase().padStart(digits, "0")

// a hex field of up to `digits` digits, empty is 0, null if it is no number up to `max`
const readHex = (text: string, digits: int, max: int): Nullable<int> => {
    const trimmed = text.trim()
    if (trimmed === "") {return 0}
    if (!new RegExp(`^[0-9a-fA-F]{1,${digits}}$`).test(trimmed)) {return null}
    const value = Number.parseInt(trimmed, 16)
    return value <= max ? value : null
}

const textInput = (className: string, length: int): HTMLInputElement => {
    const input: HTMLInputElement = <input type="text" className={className} data-keep-focus=""/>
    input.maxLength = length
    input.spellcheck = false
    input.autocomplete = "off"
    return input
}

/** The step table: the current pattern's 64 rows, scrolled so the playing row stays in view and the table stays full.
 * With `edit`, a click on a step opens its editor, and the table stays on that pattern while it is open. */
export const PatternView = ({lifecycle, player, edit}: Construct) => {
    const label = Inject.value("")
    const rows: HTMLDivElement = <div className="rows"/>
    const viewport: HTMLDivElement = <div className="viewport">{rows}</div>
    let rowElements: ReadonlyArray<HTMLElement> = []
    let cellElements: ReadonlyArray<ReadonlyArray<HTMLElement>> = []
    let shownPattern: int = -1
    let shownRow: int = -1
    let shownOffset: int = -1
    let rowHeight = 0
    let visibleRows = 1
    let step: Nullable<Step> = null
    let shownNote = ""
    const where: HTMLSpanElement = <span className="where"/>
    const noteInput = textInput("note", 3)
    const sampleInput = textInput("sample", 2)
    const effectInput = textInput("effect", 3)
    const cellOf = (at: Step): Nullable<Cell> => player.module.unwrapOrNull()?.patterns[at.pattern]?.[at.row]?.[at.channel] ?? null
    const send = (cell: Cell): void => {
        if (!isDefined(step) || !isDefined(edit)) {return}
        const current = cellOf(step)
        if (isDefined(current) && current.period === cell.period && current.sample === cell.sample
            && current.effect === cell.effect && current.arg === cell.arg) {return}
        edit.setCell(step.pattern, step.row, step.channel, cell)
    }
    const fill = (): void => {
        if (!isDefined(step)) {return}
        const cell = cellOf(step) ?? EMPTY
        shownNote = noteName(cell.period)
        noteInput.value = shownNote
        sampleInput.value = hex(cell.sample, 2)
        effectInput.value = hex(cell.effect, 1) + hex(cell.arg, 2)
        where.textContent = `pat ${step.pattern.toString().padStart(2, "0")} row ${hex(step.row, 2)} ch ${step.channel + 1}`
        for (const input of [noteInput, sampleInput, effectInput]) {input.classList.remove("invalid")}
    }
    const apply = (): void => {
        if (!isDefined(step)) {return}
        const cell = cellOf(step) ?? EMPTY
        const period = noteInput.value.trim().toUpperCase() === shownNote ? cell.period : periodOf(noteInput.value)
        const sample = readHex(sampleInput.value, 2, 31)
        const effect = readHex(effectInput.value, 3, 0xFFF)
        noteInput.classList.toggle("invalid", !isDefined(period))
        sampleInput.classList.toggle("invalid", !isDefined(sample))
        effectInput.classList.toggle("invalid", !isDefined(effect))
        if (!isDefined(period) || !isDefined(sample) || !isDefined(effect)) {return}
        send({period, sample, effect: effect >> 8, arg: effect & 0xFF})
        shownNote = noteName(period)
        noteInput.value = shownNote
        sampleInput.value = hex(sample, 2)
        effectInput.value = hex(effect, 3)
    }
    const flyout: HTMLDivElement = (
        <div className={flyoutClassName}>
            <div className="fields">
                {where}
                <label>note {noteInput}</label>
                <label>smp {sampleInput}</label>
                <label>fx {effectInput}</label>
                <Button lifecycle={lifecycle} label="Clear" onClick={() => {
                    send(EMPTY)
                    if (isDefined(step)) {
                        shownNote = noteName(0)
                        noteInput.value = shownNote
                        sampleInput.value = "00"
                        effectInput.value = "000"
                    }
                }}/>
            </div>
            <div className="hint">↑ ↓ move through the pattern, Enter applies, Esc closes</div>
        </div>
    )
    flyout.hidden = true
    const anchor = (): void => {
        cellElements.forEach(cells => cells.forEach(cell => cell.classList.remove("editing")))
        if (!isDefined(step)) {return}
        const element = cellElements[step.row]?.[step.channel]
        if (!isDefined(element)) {return}
        element.classList.add("editing")
        const rect = element.getBoundingClientRect()
        const height = flyout.offsetHeight
        const below = rect.bottom + 2
        flyout.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - flyout.offsetWidth))}px`
        flyout.style.top = `${below + height > window.innerHeight ? rect.top - height - 2 : below}px`
    }
    const close = (): void => {
        if (!isDefined(step)) {return}
        step = null
        flyout.hidden = true
        anchor()
        for (const input of [noteInput, sampleInput, effectInput]) {input.blur()}
        shownOffset = -1
    }
    const open = (at: Step): void => {
        step = at
        flyout.hidden = false
        fill()
        shownOffset = -1
        update()
        anchor()
        if (!flyout.contains(document.activeElement)) {
            noteInput.focus()
            noteInput.select()
        }
    }
    const move = (delta: int): void => {
        if (!isDefined(step)) {return}
        apply()
        open({...step, row: Math.max(0, Math.min(63, step.row + delta))})
    }
    const build = (index: int, pattern: Pattern) => {
        cellElements = pattern.map((row, rowIndex) => row.map((cell, channel) => {
            const empty = cell.period === 0 && cell.sample === 0 && cell.effect === 0 && cell.arg === 0
            return (
                <span className={Html.buildClassList("cell", empty && "empty", isDefined(edit) && "editable")}
                      onclick={() => {
                          if (!isDefined(edit)) {return}
                          if (step?.pattern === index && step.row === rowIndex && step.channel === channel) {close()} else {
                              open({pattern: index, row: rowIndex, channel})
                          }
                      }}>{cellText(cell)}</span>
            )
        }))
        rowElements = pattern.map((_, rowIndex) => (
            <div className={Html.buildClassList("row", rowIndex % 4 === 0 && "beat")}>
                <span className="index">{rowIndex.toString(16).toUpperCase().padStart(2, "0")}</span>
                {cellElements[rowIndex]}
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
        const playing = isDefined(status) ? status.pattern : module.positions[0] ?? 0
        const pattern = isDefined(step) ? step.pattern : playing
        const playingRow = isDefined(status) ? status.row : 0
        const row = pattern === playing ? playingRow : -1
        if (pattern !== shownPattern && pattern < module.patterns.length) {build(pattern, module.patterns[pattern])}
        if (row !== shownRow) {
            rowElements[shownRow]?.classList.remove("current")
            rowElements[row]?.classList.add("current")
            shownRow = row
        }
        const focus = isDefined(step) ? step.row : playingRow
        const offset = Math.max(0, Math.min(focus - Math.floor(visibleRows / 2), rowElements.length - visibleRows))
        if (offset !== shownOffset) {
            rows.style.transform = `translateY(${-offset * rowHeight}px)`
            shownOffset = offset
            anchor()
        }
    }
    if (isDefined(edit)) {
        document.body.appendChild(flyout)
        const keys = (event: KeyboardEvent): void => {
            if (event.key === "Enter") {
                apply()
            } else if (event.key === "Escape") {
                close()
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                event.preventDefault()
                move(event.key === "ArrowUp" ? -1 : 1)
            }
        }
        lifecycle.ownAll(
            {terminate: () => flyout.remove()},
            ...[noteInput, sampleInput, effectInput].flatMap(input => [
                Events.subscribe(input, "keydown", keys),
                Events.subscribe(input, "change", apply),
                Events.subscribe(input, "focus", () => input.select())
            ]),
            Events.subscribe(document, "pointerdown", event => {
                const target = event.target
                if (target instanceof Node && !flyout.contains(target) && !rows.contains(target)) {close()}
            }))
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
