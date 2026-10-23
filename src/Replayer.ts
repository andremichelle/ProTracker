import {Nullable, ObservableOption} from "@opendaw/lib-std"
import {Module} from "@/Module"
import type {Status} from "@/Status"

/** What the song views read: the module and where the replayer is. The web player and the WebCLAP page provide it. */
export interface Replayer {
    readonly module: ObservableOption<Module>
    readonly currentStatus: Nullable<Status>
}
