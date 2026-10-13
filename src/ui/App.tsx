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
import {Visualizer3D} from "@/ui/Visualizer3D"
import {VisualizerWebGL} from "@/ui/VisualizerWebGL"

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
    const ascii3dView: HTMLDivElement = <Visualizer3D lifecycle={lifecycle} player={player}/>
    const webglView: HTMLDivElement = <VisualizerWebGL lifecycle={lifecycle} player={player}/>
    lifecycle.own(viewMode.catchupAndSubscribe(owner => {
        const mode = owner.getValue()
        trackerView.hidden = mode !== "tracker"
        visualizerView.hidden = mode !== "visualizer"
        ascii3dView.hidden = mode !== "ascii3d"
        webglView.hidden = mode !== "webgl"
    }))
    const element: HTMLElement = (
        <div className={className}>
            <Transport lifecycle={lifecycle} player={player} initialModule={initialModule} viewMode={viewMode}/>
            <div className="views">
                {trackerView}
                {visualizerView}
                {ascii3dView}
                {webglView}
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
