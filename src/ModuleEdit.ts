import {int} from "@opendaw/lib-std"
import {Module} from "@/Module"

/** What the position list editor may do with a module, the plugin applies the edits. */
export namespace ModuleEdit {
    /** M!K! modules hold up to 100 patterns, all others 64. */
    export const maxPatterns = (data: Uint8Array): int => Module.tagOf(data) === "M!K!" ? 100 : 64

    /** ProTracker counts every one of the 128 table entries, also those past the song length. */
    export const patternCount = (data: Uint8Array): int => Math.max(...data.subarray(952, 952 + 128)) + 1

    export const canInsert = (data: Uint8Array): boolean => data[950] < 128 && patternCount(data) < maxPatterns(data)
}
