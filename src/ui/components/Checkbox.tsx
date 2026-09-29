import css from "./Checkbox.sass?inline"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Checkbox")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<boolean>
    label: string
    tooltip?: string
}

export const Checkbox = ({lifecycle, model, label, tooltip}: Construct) => {
    const input: HTMLInputElement = <input type="checkbox" onchange={() => model.setValue(input.checked)}/>
    lifecycle.own(model.catchupAndSubscribe(owner => input.checked = owner.getValue()))
    return (
        <label className={className} title={tooltip}>
            {input}
            <span>{label}</span>
        </label>
    )
}
