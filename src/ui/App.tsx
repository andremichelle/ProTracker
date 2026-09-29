import css from "./App.sass?inline"
import {isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {Transport} from "@/ui/Transport"
import {PatternView} from "@/ui/PatternView"
import {Positions} from "@/ui/Positions"
import {Channels} from "@/ui/Channels"

const className = Html.adoptStyleSheet(css, "App")

type Construct = {
    lifecycle: Lifecycle
    player: Player
    initialModule: string
}

export const App = ({lifecycle, player, initialModule}: Construct) => {
    const element: HTMLElement = (
        <div className={className}>
            <Transport lifecycle={lifecycle} player={player} initialModule={initialModule}/>
            <main>
                <Positions lifecycle={lifecycle} player={player}/>
                <PatternView lifecycle={lifecycle} player={player}/>
            </main>
            <Channels lifecycle={lifecycle} player={player}/>
        </div>
    )
    lifecycle.own(Events.subscribe(element, "dragover", event => event.preventDefault()))
    lifecycle.own(Events.subscribe(element, "drop", async event => {
        event.preventDefault()
        const file = event.dataTransfer?.files[0]
        if (isDefined(file)) {player.load(new Uint8Array(await file.arrayBuffer()))}
    }))
    return element
}
