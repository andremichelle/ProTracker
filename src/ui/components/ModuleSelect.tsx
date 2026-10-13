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

/**
 * Dropdown over the modules in assets/mods. All modules currently served here are
 * Amiga ProTracker-format .mod files, grouped under a single "Amiga" optgroup -
 * structured so a future non-Amiga platform (e.g. Atari ST) can get its own group
 * without reworking this component.
 */
export const ModuleSelect = ({player, initial}: Construct) => {
    const amigaGroup: HTMLOptGroupElement = <optgroup label="Amiga (ProTracker)"/>
    const element: HTMLSelectElement = (
        <select className={className} title="Modules from the 8bitboy collection"
                onchange={() => {
                    if (element.value !== "") {player.loadUrl(`mods/${element.value}`).then()}
                }}>
            {amigaGroup}
        </select>
    )
    player.listModules().then(names => {
        names.forEach(name => {
            const option: HTMLOptionElement = <option value={name}>{name.replace(/\.mod$/i, "")}</option>
            amigaGroup.appendChild(option)
        })
        element.value = initial
    }, reason => player.error.setValue(String(reason)))
    return element
}
