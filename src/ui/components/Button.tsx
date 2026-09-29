import css from "./Button.sass?inline"
import {Exec, Lifecycle, ObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Button")

type Construct = {
    lifecycle: Lifecycle
    label: string
    onClick: Exec
    primary?: boolean
    enabled?: ObservableValue<boolean>
}

export const Button = ({lifecycle, label, onClick, primary, enabled}: Construct) => {
    const element: HTMLButtonElement = (
        <button className={Html.buildClassList(className, primary && "primary")} onclick={onClick}>{label}</button>
    )
    if (enabled !== undefined) {
        lifecycle.own(enabled.catchupAndSubscribe(owner => element.disabled = !owner.getValue()))
    }
    return element
}
