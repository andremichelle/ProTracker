import css from "./Select.sass?inline"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Select")

type Construct<T extends string> = {
    lifecycle: Lifecycle
    model: MutableObservableValue<T>
    label: string
    options: ReadonlyArray<{id: T, label: string}>
}

export const Select = <T extends string>({lifecycle, model, label, options}: Construct<T>) => {
    const select: HTMLSelectElement = (
        <select onchange={() => model.setValue(select.value as T)}>
            {options.map(option => <option value={option.id}>{option.label}</option>)}
        </select>
    )
    lifecycle.own(model.catchupAndSubscribe(owner => select.value = owner.getValue()))
    return (
        <label className={className}>
            <span>{label}</span>
            {select}
        </label>
    )
}
