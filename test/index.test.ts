import assert from "node:assert/strict"
import test from "node:test"

import { createReporter, encodeReport, reportStartup } from "../src/index.ts"

const ESC = "\u001b"

test("encodes a complete OSC 7501 report", () => {
  assert.equal(
    encodeReport({ state: "working", id: "ses_123", app: "opencode", message: "Working" }),
    `${ESC}]7501;state=working:id=ses_123:app=opencode:msg=V29ya2luZw==${ESC}\\`,
  )
})

test("rejects invalid OSC identifiers and removes control characters from messages", () => {
  assert.equal(encodeReport({ state: "working", id: "bad:id" }), undefined)
  assert.equal(encodeReport({ state: "unknown" as "working", id: "ses_123" }), undefined)
  const report = encodeReport({ state: "error", id: "ses_123", message: "broken\nmessage" })
  assert.match(report ?? "", /msg=YnJva2VuIG1lc3NhZ2U=/)
})

test("maps status, permission, error, and deletion events per session", async () => {
  const writes: string[] = []
  const reporter = createReporter(async (sequence) => writes.push(sequence))

  await reporter.handle({ type: "session.created", properties: { info: { id: "ses_one" } } })
  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } })
  await reporter.handle({ type: "permission.asked", properties: { sessionID: "ses_one" } })
  await reporter.handle({ type: "permission.replied", properties: { sessionID: "ses_one" } })
  await reporter.handle({ type: "session.error", properties: { sessionID: "ses_one", error: { data: { message: "No model" } } } })
  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "idle" } } })
  await reporter.handle({ type: "session.deleted", properties: { info: { id: "ses_one" } } })

  assert.deepEqual(
    writes,
    [
      `${ESC}]7501;state=idle:id=ses_one:app=opencode${ESC}\\`,
      `${ESC}]7501;state=working:id=ses_one:app=opencode${ESC}\\`,
      `${ESC}]7501;state=blocked:id=ses_one:kind=permission:app=opencode${ESC}\\`,
      `${ESC}]7501;state=working:id=ses_one:app=opencode${ESC}\\`,
      `${ESC}]7501;state=error:id=ses_one:app=opencode:msg=Tm8gbW9kZWw=${ESC}\\`,
      `${ESC}]7501;state=error:id=ses_one:app=opencode${ESC}\\`,
      `${ESC}]7501;state=clear:id=ses_one${ESC}\\`,
    ],
  )
})

test("keeps concurrent session records independent and suppresses duplicate reports", async () => {
  const writes: string[] = []
  const reporter = createReporter(async (sequence) => writes.push(sequence))

  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } })
  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_two", status: { type: "busy" } } })
  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } })

  assert.equal(writes.length, 2)
  assert.match(writes[0], /id=ses_one/)
  assert.match(writes[1], /id=ses_two/)
})

test("reports user questions as blocked and keeps that state through busy updates", async () => {
  const writes: string[] = []
  const reporter = createReporter(async (sequence) => writes.push(sequence))

  await reporter.handle({ type: "question.asked", properties: { sessionID: "ses_one" } })
  await reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } })
  await reporter.handle({ type: "question.replied", properties: { sessionID: "ses_one" } })

  assert.deepEqual(writes, [
    `${ESC}]7501;state=blocked:id=ses_one:kind=question:app=opencode${ESC}\\`,
    `${ESC}]7501;state=working:id=ses_one:app=opencode${ESC}\\`,
  ])
})

test("does not propagate terminal writer failures", async () => {
  const reporter = createReporter(async () => {
    throw new Error("no controlling terminal")
  })

  await assert.doesNotReject(() =>
    reporter.handle({ type: "session.status", properties: { sessionID: "ses_one", status: { type: "busy" } } }),
  )
})

test("reports an idle application state at startup", async () => {
  const writes: string[] = []

  await reportStartup(async (sequence) => writes.push(sequence))

  assert.deepEqual(writes, [`${ESC}]7501;state=idle:id=opencode:app=opencode${ESC}\\`])
})
