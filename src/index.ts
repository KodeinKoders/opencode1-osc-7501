import type { Plugin } from "@opencode-ai/plugin"

const ESC = "\u001b"
const ST = `${ESC}\\`
const MAX_SEQUENCE_BYTES = 4096
const MAX_MESSAGE_BYTES = 2048
const MAX_APP_BYTES = 32
const VALUE_PATTERN = /^[A-Za-z0-9_.,+/=-]*$/
const TOKEN_PATTERN = /^[A-Za-z0-9_.+-]+$/
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/
const VALID_STATES = new Set(["idle", "working", "done", "blocked", "error", "clear"])
const VALID_KINDS = new Set(["permission", "question", "auth"])

export type ProgramState = "idle" | "working" | "done" | "blocked" | "error" | "clear"

export type OscReport = {
  state: ProgramState
  id?: string
  kind?: "permission" | "question" | "auth"
  app?: string
  message?: string
}

export type OpenCodeEvent = {
  type: string
  properties?: Record<string, unknown>
  data?: Record<string, unknown>
}

export type SequenceWriter = (sequence: string) => Promise<void>

const STARTUP_RECORD_ID = "opencode"

const encoder = new TextEncoder()

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function validToken(value: string, maxBytes: number): boolean {
  return TOKEN_PATTERN.test(value) && byteLength(value) <= maxBytes
}

function sanitizeText(value: string): string {
  const withoutControls = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()
  let result = ""

  for (const character of withoutControls) {
    if (byteLength(result) + byteLength(character) > MAX_MESSAGE_BYTES) break
    result += character
  }

  return result
}

function encodeBase64(value: string): string {
  const bytes = encoder.encode(value)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Build a standards-compliant OSC 7501 report, or return undefined for invalid input. */
export function encodeReport(report: OscReport): string | undefined {
  if (!VALID_STATES.has(report.state)) return undefined
  if (report.id && !SESSION_ID_PATTERN.test(report.id)) return undefined
  if (report.app && !validToken(report.app, MAX_APP_BYTES)) return undefined
  if (report.kind && !VALID_KINDS.has(report.kind)) return undefined

  const pairs = [`state=${report.state}`]
  if (report.id) pairs.push(`id=${report.id}`)
  if (report.kind) pairs.push(`kind=${report.kind}`)
  if (report.app) pairs.push(`app=${report.app}`)

  const message = report.message ? sanitizeText(report.message) : ""
  if (message) {
    const encoded = encodeBase64(message)
    if (byteLength(encoded) <= 2732 && VALUE_PATTERN.test(encoded)) pairs.push(`msg=${encoded}`)
  }

  let sequence = `${ESC}]7501;${pairs.join(":")}${ST}`
  if (byteLength(sequence) <= MAX_SEQUENCE_BYTES) return sequence

  // Messages are optional. Dropping one preserves a valid state report.
  const withoutMessage = pairs.filter((pair) => !pair.startsWith("msg="))
  sequence = `${ESC}]7501;${withoutMessage.join(":")}${ST}`
  return byteLength(sequence) <= MAX_SEQUENCE_BYTES ? sequence : undefined
}

function propertiesOf(event: OpenCodeEvent): Record<string, unknown> {
  return event.properties ?? event.data ?? {}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function sessionID(event: OpenCodeEvent): string | undefined {
  const properties = propertiesOf(event)
  if (typeof properties.sessionID === "string") return properties.sessionID
  const info = asRecord(properties.info)
  return typeof info?.id === "string" ? info.id : undefined
}

function errorText(value: unknown): string {
  const error = asRecord(value)
  if (!error) return "OpenCode session error"
  if (typeof error.message === "string") return error.message
  const data = asRecord(error.data)
  if (typeof data?.message === "string") return data.message
  if (typeof error.name === "string") return error.name
  return "OpenCode session error"
}

/** Preserve ordinary OpenCode IDs and safely map any future incompatible ID format. */
function recordID(sessionID: string): string {
  if (SESSION_ID_PATTERN.test(sessionID)) return sessionID

  let hash = 0x811c9dc5
  for (const character of sessionID) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return `oc-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function createReporter(write: SequenceWriter) {
  const lastSequence = new Map<string, string>()
  const pendingPermissions = new Map<string, number>()
  const pendingQuestions = new Map<string, number>()
  const failedSessions = new Set<string>()

  async function emit(report: OscReport): Promise<void> {
    const sequence = encodeReport(report)
    if (!sequence) return
    const recordID = report.id ?? ""
    if (lastSequence.get(recordID) === sequence) return

    try {
      await write(sequence)
      if (report.state === "clear") lastSequence.delete(recordID)
      else lastSequence.set(recordID, sequence)
    } catch {
      // Terminal status is auxiliary; it must never interrupt OpenCode.
    }
  }

  function statusReport(id: string, state: ProgramState, message?: string, kind?: OscReport["kind"]): Promise<void> {
    return emit({ state, id: recordID(id), app: state === "clear" ? undefined : "opencode", message, kind })
  }

  function pendingKind(id: string): OscReport["kind"] | undefined {
    if ((pendingQuestions.get(id) ?? 0) > 0) return "question"
    if ((pendingPermissions.get(id) ?? 0) > 0) return "permission"
    return undefined
  }

  function reportCurrentState(id: string, fallback: ProgramState = "working"): Promise<void> {
    const kind = pendingKind(id)
    if (kind) return statusReport(id, "blocked", undefined, kind)
    return statusReport(id, failedSessions.has(id) ? "error" : fallback)
  }

  return {
    async handle(event: OpenCodeEvent): Promise<void> {
      const id = sessionID(event)

      switch (event.type) {
        case "session.created":
          if (!id) return
          failedSessions.delete(id)
          pendingPermissions.delete(id)
          pendingQuestions.delete(id)
          await statusReport(id, "idle")
          return

        case "session.status": {
          if (!id) return
          const status = asRecord(propertiesOf(event).status)
          if (!status || typeof status.type !== "string") return

          if (status.type === "busy") {
            failedSessions.delete(id)
            await reportCurrentState(id)
          } else if (status.type === "retry") {
            failedSessions.delete(id)
            const message = typeof status.message === "string" ? `Retrying: ${status.message}` : "Retrying"
            const kind = pendingKind(id)
            await (kind ? statusReport(id, "blocked", undefined, kind) : statusReport(id, "working", message))
          } else if (status.type === "idle") {
            await reportCurrentState(id, "done")
          }
          return
        }

        case "session.idle":
          if (id) await reportCurrentState(id, "done")
          return

        case "permission.asked":
          if (!id) return
          pendingPermissions.set(id, (pendingPermissions.get(id) ?? 0) + 1)
          await statusReport(id, "blocked", undefined, "permission")
          return

        case "permission.replied":
          if (!id) return
          const remaining = Math.max(0, (pendingPermissions.get(id) ?? 1) - 1)
          if (remaining === 0) {
            pendingPermissions.delete(id)
            failedSessions.delete(id)
            await reportCurrentState(id)
          } else {
            pendingPermissions.set(id, remaining)
          }
          return

        case "question.asked":
        case "question.v2.asked":
          if (!id) return
          pendingQuestions.set(id, (pendingQuestions.get(id) ?? 0) + 1)
          await statusReport(id, "blocked", undefined, "question")
          return

        case "question.replied":
        case "question.rejected":
        case "question.v2.replied":
        case "question.v2.rejected": {
          if (!id) return
          const remaining = Math.max(0, (pendingQuestions.get(id) ?? 1) - 1)
          if (remaining === 0) {
            pendingQuestions.delete(id)
            failedSessions.delete(id)
            await reportCurrentState(id)
          } else {
            pendingQuestions.set(id, remaining)
          }
          return
        }

        case "session.error":
          if (!id) return
          failedSessions.add(id)
          await statusReport(id, "error", errorText(propertiesOf(event).error))
          return

        case "session.deleted":
          if (!id) return
          failedSessions.delete(id)
          pendingPermissions.delete(id)
          pendingQuestions.delete(id)
          await statusReport(id, "clear")
      }
    },
  }
}

/** Write an OSC sequence to the terminal that owns the OpenCode process. */
export const writeToControllingTerminal: SequenceWriter = async (sequence) => {
  try {
    await Bun.write("/dev/tty", sequence)
  } catch {
    // Headless processes and platforms without /dev/tty simply do not report status.
  }
}

/** Announce that the OpenCode process is ready before it creates a session. */
export async function reportStartup(write: SequenceWriter = writeToControllingTerminal): Promise<void> {
  const sequence = encodeReport({ state: "idle", id: STARTUP_RECORD_ID, app: "opencode" })
  if (!sequence) return

  try {
    await write(sequence)
  } catch {
    // Terminal status is auxiliary; it must never interrupt OpenCode startup.
  }
}

export const OpenCodeOsc7501: Plugin = async () => {
  await reportStartup()
  const reporter = createReporter(writeToControllingTerminal)
  return {
    event: async ({ event }) => reporter.handle(event as OpenCodeEvent),
  }
}

export default OpenCodeOsc7501
