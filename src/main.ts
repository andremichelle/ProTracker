import "./styles.sass"
import {initializeColors} from "@opendaw/studio-enums"
import {Terminator} from "@opendaw/lib-std"
import {AnimationFrame} from "@opendaw/lib-dom"
import {App} from "@/ui/App"
import {Player} from "@/Player"

const INITIAL_MODULE = "000.delicate.mod"

initializeColors(document.documentElement)

const lifecycle = new Terminator()
const player = new Player(import.meta.env.BASE_URL)
document.body.appendChild(App({lifecycle, player, initialModule: INITIAL_MODULE}))
player.loadUrl(`mods/${INITIAL_MODULE}`).then()
AnimationFrame.start(window)
