import css from "./PluginPage.sass?inline"
import {isDefined, Lifecycle} from "@opendaw/lib-std"
import {createElement, Inject} from "@opendaw/lib-jsx"
import {Events, Html} from "@opendaw/lib-dom"
import {PatternView} from "@/ui/PatternView"
import {Positions} from "@/ui/Positions"
import {Channels} from "@/ui/Channels"
import {Mixer} from "@/wclap/Mixer"
import {PluginLink} from "@/wclap/PluginLink"

const className = Html.adoptStyleSheet(css, "PluginPage")

// the example modules shipped in the bundle next to the page
const EXAMPLES = "./mods/"

type Construct = {
    lifecycle: Lifecycle
    link: PluginLink
}

/** The plugin window: the song as the replayer plays it, a module picker and the mixer. Nothing takes the focus, so
 * every key reaches the host. */
export const PluginPage = ({lifecycle, link}: Construct) => {
    const title = Inject.value("")
    const error = Inject.value("")
    const playing = Inject.value("")
    const loadFile = async (file: File) => link.load(new Uint8Array(await file.arrayBuffer()))
    const fileInput: HTMLInputElement = (
        <input type="file" accept=".mod,.MOD" onchange={() => {
            const file = fileInput.files?.[0]
            if (isDefined(file)) {loadFile(file).then()}
            fileInput.value = ""
        }}/>
    )
    fileInput.hidden = true
    const loadExample = async (name: string) => {
        menu.hidden = true
        const response = await fetch(`${EXAMPLES}${encodeURIComponent(name)}`).catch(reason => reason)
        if (response instanceof Response && response.ok) {
            link.load(new Uint8Array(await response.arrayBuffer()))
        } else {
            link.error.setValue(`${name} could not be loaded`)
        }
    }
    const menu: HTMLElement = <div className="menu"/>
    menu.hidden = true
    const examples: HTMLButtonElement = (
        <button type="button" title="Example modules" onclick={() => menu.hidden = !menu.hidden}>Examples</button>
    )
    const loadButton: HTMLButtonElement = <button type="button" onclick={() => fileInput.click()}>Load file...</button>
    examples.tabIndex = -1
    loadButton.tabIndex = -1
    examples.disabled = true
    fetch(`${EXAMPLES}index.json`).then(response => response.json()).then((names: ReadonlyArray<string>) => {
        menu.append(...names.map(name =>
            <div className="item" onclick={() => loadExample(name)}>{name.replace(/\.mod$/i, "")}</div>))
        examples.disabled = false
    }, () => link.error.setValue("The examples are missing"))
    lifecycle.ownAll(
        link.module.catchupAndSubscribe(option => title.value = option.mapOr(module => module.title || "(untitled)", "")),
        link.error.catchupAndSubscribe(owner => error.value = owner.getValue()),
        link.playing.catchupAndSubscribe(owner => playing.value = owner.getValue() ? "playing" : "stopped"))
    const element: HTMLElement = (
        <div className={className}>
            <header>
                <span className="title">{title}</span>
                <span className="state">{playing}</span>
                <span className="error">{error}</span>
                <div className="examples">{examples}{menu}</div>
                {loadButton}
                {fileInput}
            </header>
            <main>
                <Positions lifecycle={lifecycle} player={link} edit={link}/>
                <PatternView lifecycle={lifecycle} player={link} edit={link}/>
            </main>
            <div className="channels"><Channels lifecycle={lifecycle} player={link}/></div>
            <Mixer lifecycle={lifecycle} link={link}/>
        </div>
    )
    lifecycle.ownAll(
        Events.subscribe(element, "mousedown", event => event.preventDefault()),
        Events.subscribe(document, "pointerdown", event => {
            const target = event.target
            if (!menu.hidden && target instanceof Node && !examples.contains(target) && !menu.contains(target)) {menu.hidden = true}
        }),
        Events.subscribe(element, "dragover", event => event.preventDefault()),
        Events.subscribe(element, "drop", event => {
            event.preventDefault()
            const file = event.dataTransfer?.files[0]
            if (isDefined(file)) {loadFile(file).then()}
        }))
    return element
}
