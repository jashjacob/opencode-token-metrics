/**
 * Translates OpenCode TUI events into calls on the `MeterStore`. Kept free of
 * JSX so it can be exercised with a fake event bus in tests; the rendering layer
 * only reads `store.snapshot()`.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { MeterStore, type RateConfig } from "./meter.ts"

export type MeterApi = Pick<TuiPluginApi, "event" | "state" | "lifecycle">

export type MeterController = {
  store: MeterStore
  tick: (now?: number) => void
  dispose: () => void
}

/** Delta fields that represent generated output. Everything else is ignored. */
const COUNTED_FIELDS = new Set(["text", "reasoning"])

export function createMeterController(
  api: MeterApi,
  config: RateConfig,
  onChange: () => void,
): MeterController {
  const store = new MeterStore(config)

  const offDelta = api.event.on("message.part.delta", (event) => {
    const { sessionID, messageID, field, delta } = event.properties
    if (!sessionID || !delta) return
    if (!COUNTED_FIELDS.has(field)) return
    if (api.state.session.status(sessionID)?.type === "idle") return
    store.record(sessionID, delta, Date.now(), messageID)
    onChange()
  })

  const offUpdated = api.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (info.time.completed) {
      const exact = info.tokens.output + info.tokens.reasoning
      if (store.settle(info.sessionID, exact, Date.now())) onChange()
      return
    }
    store.beginTurn(info.sessionID, info.id, info.time.created)
    onChange()
  })

  const offPart = api.event.on("message.part.updated", (event) => {
    if (event.properties.part.type !== "tool") return
    if (store.newSegment(event.properties.sessionID)) onChange()
  })

  const offDeleted = api.event.on("session.deleted", (event) => {
    if (store.drop(event.properties.sessionID)) onChange()
  })

  const dispose = () => {
    offDelta()
    offUpdated()
    offPart()
    offDeleted()
  }

  api.lifecycle.onDispose(dispose)

  return {
    store,
    dispose,
    tick: (now: number = Date.now()) => {
      store.prune(now)
      onChange()
    },
  }
}
