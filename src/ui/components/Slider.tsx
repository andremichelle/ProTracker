import css from "./Slider.sass?inline"
import {Lifecycle, MutableObservableValue} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"

const className = Html.adoptStyleSheet(css, "Slider")

type Construct = {
    lifecycle: Lifecycle
    model: MutableObservableValue<number>
    label: string
    min: number
    max: number
    step: number
    format?: (value: number) => string
}

export const Slider = ({lifecycle, model, label, min, max, step, format}: Construct) => {
    const display = Inject.value("")
    const input: HTMLInputElement = (
        <input type="range" min={String(min)} max={String(max)} step={String(step)}
               oninput={() => model.setValue(parseFloat(input.value))}/>
    )
    lifecycle.own(model.catchupAndSubscribe(owner => {
        const value = owner.getValue()
        input.value = String(value)
        display.value = format?.(value) ?? `${value.toFixed(2)}x`
    }))
    return (
        <label className={className}>
            <span>{label}</span>
            {input}
            <span>{display}</span>
        </label>
    )
}
