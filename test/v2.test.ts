import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { Context } from "@opencode/plugin/tui/context"
import { createMeterController } from "../src/controller.ts"
import { wireV2 } from "../src/v2.ts"

type Handler = (event: unknown) => void

function harness(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  let status: "idle" | "running" = "running"

  const ctx = {
    options,
    data: {
      on(type: string, handler: Handler) {
        handlers.set(type, handler)
        return () => {
          handlers.delete(type)
        }
      },
      session: { status: () => status },
    },
  } as unknown as Context

  return {
    ctx,
    handlers,
    emit: (type: string, event: unknown) => handlers.get(type)?.(event),
    setStatus: (next: "idle" | "running") => {
      status = next
    },
  }
}

const stepStarted = (sessionID: string, messageID: string, started: number) => ({
  data: { sessionID, assistantMessageID: messageID, agent: "a", model: { providerID: "p", modelID: "m" }, started },
})

const textDelta = (sessionID: string, delta: string, messageID = "m1") => ({
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
})

const reasoningDelta = (sessionID: string, delta: string, messageID = "m1") => ({
  data: { sessionID, assistantMessageID: messageID, ordinal: 0, delta },
})

const toolCalled = (sessionID: string) => ({
  data: { sessionID, assistantMessageID: "m1", id: "t1", input: {}, executed: true },
})

const stepEnded = (sessionID: string, output: number, reasoning: number) => ({
  data: {
    sessionID,
    assistantMessageID: "m1",
    finish: "tool-calls",
    cost: 0,
    tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } },
  },
})

const stepEndedWithCache = (
  sessionID: string,
  output: number,
  reasoning: number,
  input: number,
  read: number,
  write: number,
) => ({
  data: {
    sessionID,
    assistantMessageID: "m1",
    finish: "tool-calls",
    cost: 0,
    tokens: { input, output, reasoning, cache: { read, write } },
  },
})

const executionSucceeded = (sessionID: string) => ({ data: { sessionID } })

const compactionStarted = (sessionID: string, inputID = "m0") => ({
  data: { sessionID, reason: "auto", recent: "…", inputID },
})

const compactionDelta = (sessionID: string, text: string) => ({ data: { sessionID, text } })

const compactionEnded = (sessionID: string, output: number, reasoning: number) => ({
  data: { sessionID, reason: "auto", text: "summary", recent: "…", tokens: { input: 0, output, reasoning, cache: { read: 0, write: 0 } } },
})

const CONFIG = { rollingWindowMs: 5000, idleTimeoutMs: 1500, minSpanMs: 300 }

describe("wireV2", () => {
  it("records text deltas for running sessions", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })

    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    assert.equal(updates, 1)
  })

  it("counts reasoning deltas too", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.reasoning.delta", reasoningDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("ignores deltas while the session is idle", () => {
    const h = harness()
    h.setStatus("idle")
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("starts a turn on step start to measure TTFT", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.step.started", stepStarted("s1", "m1", Date.now() - 500))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    const ttft = controller.store.snapshot("s1", Date.now(), 4)?.ttftMs
    assert.ok(ttft !== undefined)
    assert.ok((ttft ?? 0) > 0)
  })

  it("starts a new segment when a tool is called", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.tool.called", toolCalled("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.tokens, 2)
    assert.equal(snapshot?.rate, -1)
    assert.ok(updates >= 2)
  })

  it("keeps one graph when a tool loop starts a new assistant message", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    const started = Date.now() - 1000
    h.emit("session.step.started", stepStarted("s1", "m1", started))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh", "m1"))
    h.emit("session.tool.called", toolCalled("s1"))
    h.emit("session.step.started", stepStarted("s1", "m2", Date.now()))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh", "m2"))

    const live = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(live?.tokens, 4)
    assert.ok((live?.ttftMs ?? 0) >= 500)

    h.emit("session.step.ended", stepEnded("s1", 100, 0))
    h.emit("session.step.ended", stepEnded("s1", 50, 0))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 150)
  })

  it("opens a fresh turn after the previous execution settles", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.step.started", stepStarted("s1", "m1", Date.now() - 1000))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))

    h.emit("session.step.started", stepStarted("s1", "m2", Date.now()))
    h.emit("session.text.delta", textDelta("s1", "abcd", "m2"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, false)
    assert.equal(snapshot?.tokens, 1)
  })

  it("settles with the summed step tokens when the execution ends", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.step.ended", stepEnded("s1", 30, 0))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 150)
  })

  it("settles on the estimate when no exact tokens were reported", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 2)
  })

  it("sums cache usage across steps and reports the hit rate", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    // Step 1: 1000 read, 200 written, 0 new-in; step 2: 300 read, 0 written, 0 new-in.
    // Prompt total = 1500, of which 1300 came from cache => 87% (rounded).
    h.emit("session.step.ended", stepEndedWithCache("s1", 10, 0, 0, 1000, 200))
    h.emit("session.step.ended", stepEndedWithCache("s1", 10, 0, 0, 300, 0))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const cache = controller.store.snapshot("s1", Date.now(), 4)?.cache
    assert.ok(cache !== undefined)
    assert.equal(cache?.read, 1300)
    assert.equal(cache?.write, 200)
    assert.equal(cache?.hit, 1300 / 1500)
  })

  it("leaves the cache figure unset when the provider reported none", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.cache, undefined)
  })

  it("reports cache usage for a compaction", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.compaction.ended", { data: { sessionID: "s1", reason: "auto", text: "summary", recent: "…", tokens: { input: 0, output: 400, reasoning: 50, cache: { read: 900, write: 100 } } } })
    const cache = controller.store.snapshot("s1", Date.now(), 4)?.cache
    assert.ok(cache !== undefined)
    assert.equal(cache?.read, 900)
    assert.equal(cache?.hit, 0.9)
  })

  it("forgets a session when it is deleted", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.size, 1)
    h.emit("session.deleted", { data: { sessionID: "s1" } })
    assert.equal(controller.store.size, 0)
    assert.equal(controller.store.snapshot("s1", Date.now(), 4), undefined)
  })

  it("counts compaction as its own generation", () => {
    const h = harness()
    let updates = 0
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {
      updates += 1
    })

    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)

    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 450)
    assert.ok(updates >= 3)
  })

  it("measures compaction TTFT from the event arrival", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    const ttft = controller.store.snapshot("s1", Date.now(), 4)?.ttftMs
    assert.ok(ttft !== undefined)
    assert.ok((ttft ?? 0) >= 0)
  })

  it("settles a failed compaction on the estimate", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.compaction.failed", { data: { sessionID: "s1", reason: "auto", error: { type: "e", message: "m" } } })
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    assert.equal(snapshot?.settled, true)
    assert.equal(snapshot?.tokens, 2)
  })

  it("lets an execution settle once its compaction has finished", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 120)
  })

  it("does not carry a compacted execution's tokens into the next settle", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.step.started", stepStarted("s1", "m1", Date.now() - 1000))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    h.emit("session.step.ended", stepEnded("s1", 100, 20))
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 450)

    h.emit("session.step.started", stepStarted("s1", "m2", Date.now()))
    h.emit("session.text.delta", textDelta("s1", "abcdefgh", "m2"))
    h.emit("session.step.ended", stepEnded("s1", 10, 0))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 10)
  })

  it("ignores an execution that lands mid-compaction", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.compaction.started", compactionStarted("s1"))
    h.emit("session.compaction.delta", compactionDelta("s1", "abcdefgh"))
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.settled, false)

    h.emit("session.compaction.ended", compactionEnded("s1", 400, 50))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 450)
  })

  it("unsubscribes on dispose", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {})
    assert.equal(h.handlers.size, 15)
    dispose()
    assert.equal(h.handlers.size, 0)
  })
})

const localStepStarted = (sessionID: string, messageID: string, started: number) => ({
  data: { sessionID, assistantMessageID: messageID, agent: "a", model: { providerID: "llamaswap", id: "local-model" }, started },
})

const toolInput = (sessionID: string) => ({ data: { sessionID, assistantMessageID: "m1", id: "t1", name: "write" } })

/** A fake llama-swap whose slot decodes `step` more tokens on each /slots read. */
function fakeSwap(step: number) {
  let decoded = 0
  const urls: string[] = []
  const fetch = (async (url: string) => {
    urls.push(url)
    decoded += step
    return new Response(JSON.stringify([{ id: 0, is_processing: true, id_task: 7, next_token: [{ n_decoded: decoded }] }]))
  }) as unknown as typeof globalThis.fetch
  return { fetch, urls }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("wireV2 tool input and llama-swap", () => {
  it("counts streamed tool-call arguments", () => {
    const h = harness()
    const controller = createMeterController(CONFIG)
    wireV2(h.ctx, controller, () => {})
    h.emit("session.tool.input.delta", { data: { sessionID: "s1", assistantMessageID: "m1", id: "t1", delta: "abcdefgh" } })
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
  })

  it("polls llama-swap slots for a local model's whole execution", async () => {
    const h = harness({ llamaSwapPollMs: 20, llamaSwapProviders: ["llamaswap"] })
    const swap = fakeSwap(10)
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch: swap.fetch, now: () => Date.now() })
    h.emit("session.step.started", localStepStarted("s1", "m1", Date.now()))
    await sleep(150)
    const reads = swap.urls.length
    const snapshot = controller.store.snapshot("s1", Date.now(), 4)
    // The first read is the baseline; every later read adds exactly 10 tokens.
    assert.ok(reads >= 3, `expected several polls, got ${reads}`)
    assert.ok((snapshot?.tokens ?? 0) >= (reads - 2) * 10 && (snapshot?.tokens ?? 0) <= reads * 10)
    assert.ok((snapshot?.rate ?? -1) > 0)
    assert.equal(swap.urls[0], "http://127.0.0.1:8080/upstream/local-model/slots")
    h.emit("session.execution.succeeded", executionSucceeded("s1"))
    const stopped = swap.urls.length
    await sleep(60)
    assert.equal(swap.urls.length, stopped, "polling stops when the execution ends")
    dispose()
  })

  it("prefers the slot counter over event deltas while llama-swap answers", async () => {
    const h = harness({ llamaSwapPollMs: 20, llamaSwapProviders: ["llamaswap"] })
    const swap = fakeSwap(0)
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch: swap.fetch, now: () => Date.now() })
    h.emit("session.step.started", localStepStarted("s1", "m1", Date.now()))
    await sleep(50)
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens ?? 0, 0)
    dispose()
  })

  it("counts a new request on the slot from zero", async () => {
    const h = harness({ llamaSwapPollMs: 20, llamaSwapProviders: ["llamaswap"] })
    const replies = [
      { id_task: 1, n_decoded: 500 },
      { id_task: 1, n_decoded: 520 },
      { id_task: 2, n_decoded: 15 },
    ]
    let i = 0
    const fetch = (async () => {
      const reply = replies[Math.min(i++, replies.length - 1)]!
      return new Response(JSON.stringify([{ is_processing: true, id_task: reply.id_task, next_token: [{ n_decoded: reply.n_decoded }] }]))
    }) as unknown as typeof globalThis.fetch
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch, now: () => Date.now() })
    h.emit("session.step.started", localStepStarted("s1", "m1", Date.now()))
    await sleep(55)
    dispose()
    // 500 is the baseline, +20 on the same task, then +15 for the new task.
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 35)
  })

  it("does not poll unless llama-swap providers are configured", async () => {
    const h = harness({ llamaSwapPollMs: 20 })
    const swap = fakeSwap(10)
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch: swap.fetch, now: () => Date.now() })
    h.emit("session.step.started", localStepStarted("s1", "m1", Date.now()))
    await sleep(60)
    assert.equal(swap.urls.length, 0)
    dispose()
  })

  it("does not poll for remote providers", async () => {
    const h = harness({ llamaSwapPollMs: 20, llamaSwapProviders: ["llamaswap"] })
    const swap = fakeSwap(10)
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch: swap.fetch, now: () => Date.now() })
    h.emit("session.step.started", stepStarted("s1", "m1", Date.now()))
    await sleep(60)
    assert.equal(swap.urls.length, 0)
    dispose()
  })

  it("falls back to event deltas when llama-swap is down, and stops polling on dispose", async () => {
    const h = harness({ llamaSwapPollMs: 20, llamaSwapProviders: ["llamaswap"] })
    let calls = 0
    const fetch = (async () => {
      calls += 1
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof globalThis.fetch
    const controller = createMeterController(CONFIG)
    const dispose = wireV2(h.ctx, controller, () => {}, { fetch, now: () => Date.now() })
    h.emit("session.step.started", localStepStarted("s1", "m1", Date.now()))
    await sleep(60)
    h.emit("session.text.delta", textDelta("s1", "abcdefgh"))
    assert.equal(controller.store.snapshot("s1", Date.now(), 4)?.tokens, 2)
    dispose()
    const after = calls
    await sleep(60)
    assert.ok(after > 0)
    assert.equal(calls, after)
  })
})
