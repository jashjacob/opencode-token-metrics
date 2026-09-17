import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { createMeterController, type MeterApi } from "../src/controller.ts"

type Handler = (event: unknown) => void

function harness() {
  const handlers = new Map<string, Handler>()
  const disposers: Array<() => void> = []
  let status: { type: string } | undefined = { type: "busy" }

  const api = {
    event: {
      on(type: string, handler: Handler) {
        handlers.set(type, handler)
        return () => {
          handlers.delete(type)
        }
      },
    },
    state: {
      session: {
        status: () => status,
      },
    },
    lifecycle: {
      onDispose(fn: () => void) {
        disposers.push(fn)
        return () => {}
      },
    },
  } as unknown as MeterApi

  return {
    api,
    handlers,
    disposers,
    emit: (type: string, event: unknown) => handlers.get(type)?.(event),
    setStatus: (next: { type: string } | undefined) => {
      status = next
    },
  }
}

const delta = (sessionID: string, field: string, text: string, messageID = "m1") => ({
  properties: { sessionID, messageID, partID: "p1", field, delta: text },
})

const created = (sessionID: string, created: number) => ({
  properties: { sessionID, info: { id: "m1", role: "assistant", sessionID, time: { created } } },
})

const completed = (sessionID: string, output: number, reasoning: number) => ({
  properties: {
    sessionID,
    info: { id: "m1", role: "assistant", sessionID, time: { created: 0, completed: 1 }, tokens: { output, reasoning } },
  },
})

const toolPart = (sessionID: string) => ({
  properties: { sessionID, part: { type: "tool" }, time: 1 },
})

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 }

describe("createMeterController", () => {
  it("records text deltas for busy sessions", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })

    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    assert.equal(updates, 1)
  })

  it("counts reasoning deltas too", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("message.part.delta", delta("s1", "reasoning", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("ignores non-generation fields", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("message.part.delta", delta("s1", "title", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
    assert.equal(updates, 0)
  })

  it("ignores deltas while the session is idle", () => {
    const h = harness()
    h.setStatus({ type: "idle" })
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("settles on completed assistant messages with exact token counts", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    h.emit("message.updated", completed("s1", 120, 8))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snap?.settled, true)
    assert.equal(snap?.tokens, 128)
    assert.ok(updates >= 2)
  })

  it("starts a turn on assistant message creation to measure TTFT", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("message.updated", created("s1", Date.now() - 500))
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.ok(snap?.ttftMs !== undefined)
    assert.ok((snap?.ttftMs ?? 0) > 0)
  })

  it("ignores user messages on update", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    h.emit("message.updated", { properties: { sessionID: "s1", info: { role: "user", sessionID: "s1" } } })
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, false)
  })

  it("starts a new segment when a tool part runs", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(h.api, CONFIG, () => {
      updates += 1
    })
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    h.emit("message.part.updated", toolPart("s1"))
    const snap = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(controller.store.size, 1)
    assert.equal(snap?.tokens, 2)
    assert.equal(snap?.rate, -1)
    assert.ok(updates >= 2)
  })

  it("forgets a session when it is deleted", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    h.emit("message.part.delta", delta("s1", "text", "abcdefgh"))
    assert.equal(controller.store.size, 1)
    h.emit("session.deleted", { properties: { sessionID: "s1" } })
    assert.equal(controller.store.size, 0)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("registers and runs a lifecycle disposer", () => {
    const h = harness()
    const controller = createMeterController(h.api, CONFIG, () => {})
    assert.equal(h.disposers.length, 1)
    controller.dispose()
    assert.equal(h.handlers.size, 0)
  })
})
