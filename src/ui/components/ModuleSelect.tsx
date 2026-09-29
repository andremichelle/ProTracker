import css from "./ModuleSelect.sass?inline"
import {Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"

const className = Html.adoptStyleSheet(css, "ModuleSelect")

type Construct = {
    lifecycle: Lifecycle
    player: Player
    initial: string
}

/** Dropdown over the modules in assets/mods. */
export const ModuleSelect = ({player, initial}: Construct) => {
    const element: HTMLSelectElement = (
        <select className={className} title="Modules from the 8bitboy collection"
                onchange={() => {
                    if (element.value !== "") {player.loadUrl(`mods/${element.value}`).then()}
                }}/>
    )
    player.listModules().then(names => {
        names.forEach(name => {
            const option: HTMLOptionElement = <option value={name}>{name.replace(/\.mod$/i, "")}</option>
            element.appendChild(option)
        })
        element.value = initial
    }, reason => player.error.setValue(String(reason)))
    return element
}
