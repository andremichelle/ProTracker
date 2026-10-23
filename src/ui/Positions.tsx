import css from "./Positions.sass?inline"
import flyoutCss from "./PositionFlyout.sass?inline"
import {DefaultObservableValue, int, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, replaceChildren} from "@opendaw/lib-jsx"
import {AnimationFrame, Events, Html} from "@opendaw/lib-dom"
import {Replayer} from "@/Replayer"
import {ModuleEdit} from "@/ModuleEdit"
import {Button} from "@/ui/components/Button"

const className = Html.adoptStyleSheet(css, "Positions")
const flyoutClassName = Html.adoptStyleSheet(flyoutCss, "PositionFlyout")

/** Applies edits of the position list, the module comes back changed. */
export interface PositionEditor {
    setPattern(position: int, pattern: int): void
    insertPattern(position: int): void
}

type Construct = {
    lifecycle: Lifecycle
    player: Replayer
    edit?: PositionEditor
}

/** The song's position list: which pattern plays at which position. With `edit`, a click on a position edits it. */
export const Positions = ({lifecycle, player, edit}: Construct) => {
    const list: HTMLDivElement = <div className="list"/>
    let items: ReadonlyArray<HTMLElement> = []
    let shown: int = -1
    let editing: int = -1
    const canInsert = new DefaultObservableValue(true)
    const label: HTMLSpanElement = <span className="label"/>
    const input: HTMLInputElement = <input type="number" min="0" data-keep-focus=""/>
    const flyout: HTMLDivElement = (
        <div className={flyoutClassName}>
            {label}
            {input}
            <Button lifecycle={lifecycle} label="Insert before" enabled={canInsert}
                    onClick={() => edit?.insertPattern(editing)}/>
            <Button lifecycle={lifecycle} label="Insert after" enabled={canInsert}
                    onClick={() => {
                        edit?.insertPattern(editing + 1)
                        editing++
                    }}/>
        </div>
    )
    flyout.hidden = true
    const close = (): void => {
        if (editing < 0) {return}
        items[editing]?.classList.remove("editing")
        editing = -1
        flyout.hidden = true
        input.blur()
    }
    const open = (index: int): void => {
        const module = player.module.unwrapOrNull()
        const item = items[index]
        if (!isDefined(module) || !isDefined(item)) {return close()}
        items[editing]?.classList.remove("editing")
        editing = index
        item.classList.add("editing")
        label.textContent = `pos ${index.toString().padStart(3, "0")}`
        input.max = String(ModuleEdit.maxPatterns(module.data) - 1)
        input.value = String(module.positions[index])
        canInsert.setValue(ModuleEdit.canInsert(module.data))
        const rect = item.getBoundingClientRect()
        flyout.style.left = `${rect.right + 4}px`
        flyout.style.top = `${rect.top}px`
        flyout.hidden = false
        if (document.activeElement !== input) {
            input.focus()
            input.select()
        }
    }
    if (isDefined(edit)) {
        document.body.appendChild(flyout)
        lifecycle.ownAll(
            {terminate: () => flyout.remove()},
            Events.subscribe(input, "change", () => {
                const pattern = Number.parseInt(input.value, 10)
                const module = player.module.unwrapOrNull()
                if (!isDefined(module) || !Number.isInteger(pattern)) {return}
                if (pattern >= 0 && pattern < ModuleEdit.maxPatterns(module.data)) {edit?.setPattern(editing, pattern)}
            }),
            Events.subscribe(input, "keydown", event => {if (event.key === "Escape") {close()}}),
            Events.subscribe(document, "pointerdown", event => {
                const target = event.target
                if (target instanceof Node && !flyout.contains(target) && !list.contains(target)) {close()}
            }))
    }
    lifecycle.own(player.module.catchupAndSubscribe(option => {
        items = option.mapOr(module => module.positions.map((pattern, index) => (
            <div className={Html.buildClassList("item", isDefined(edit) && "editable")}
                 onclick={() => {
                     if (!isDefined(edit)) {return}
                     if (editing === index) {close()} else {open(index)}
                 }}>
                <span>{index.toString().padStart(3, "0")}</span>
                <span>{pattern.toString().padStart(3, "0")}</span>
            </div>
        )), [])
        replaceChildren(list, ...items)
        shown = -1
        if (editing >= 0) {open(Math.min(editing, items.length - 1))}
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
