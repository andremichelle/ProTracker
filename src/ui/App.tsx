import css from "./App.sass?inline"
import {DefaultObservableValue, isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {Player} from "@/Player"
import {Transport, ViewMode} from "@/ui/Transport"
import {PatternView} from "@/ui/PatternView"
import {Positions} from "@/ui/Positions"
import {Channels} from "@/ui/Channels"
import {Visualizer} from "@/ui/Visualizer"

const className = Html.adoptStyleSheet(css, "App")

type Construct = {
    lifecycle: Lifecycle
    player: Player
    initialModule: string
}

export const App = ({lifecycle, player, initialModule}: Construct) => {
    const viewMode = lifecycle.own(new DefaultObservableValue<ViewMode>("tracker"))
    const trackerView: HTMLDivElement = (
        <div className="tracker-view">
            <main>
                <Positions lifecycle={lifecycle} player={player}/>
                <PatternView lifecycle={lifecycle} player={player}/>
            </main>
            <Channels lifecycle={lifecycle} player={player}/>
        </div>
    )
    const visualizerView: HTMLDivElement = <Visualizer lifecycle={lifecycle} player={player}/>
    lifecycle.own(viewMode.catchupAndSubscribe(owner => {
        const visualizer = owner.getValue() === "visualizer"
        trackerView.hidden = visualizer
        visualizerView.hidden = !visualizer
    }))
    const element: HTMLElement = (
        <div className={className}>
            <Transport lifecycle={lifecycle} player={player} initialModule={initialModule} viewMode={viewMode}/>
            <div className="views">
                {trackerView}
                {visualizerView}
            </div>
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
