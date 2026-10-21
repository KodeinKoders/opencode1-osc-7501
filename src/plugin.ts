// OpenCode 1 treats every function export from a local plugin file as a plugin
// initializer. Keep the runtime entrypoint separate from the public helpers in
// index.ts so it exposes exactly one function.
import OpenCodeOsc7501 from "./index.js"

export default OpenCodeOsc7501
