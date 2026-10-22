import "@/styles.sass"
// 15px at the 960 x 640 design size, the window zoom scales everything with it
import "./page.sass"
import {initializeColors} from "@opendaw/studio-enums"
import {Terminator} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {PluginLink} from "@/wclap/PluginLink"
import {PluginPage} from "@/wclap/PluginPage"

initializeColors(document.documentElement)

const lifecycle = new Terminator()
const link = lifecycle.own(new PluginLink())
document.body.appendChild(PluginPage({lifecycle, link}))
// keys belong to the host: whatever takes the focus gives it back
document.addEventListener("focusin", event => {if (event.target instanceof HTMLElement) {event.target.blur()}})
AnimationFrame.start(window)
