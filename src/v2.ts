/**
 * OpenCode V2 event adapter. Translates `session.*` events from
 * `ctx.data.on(...)` into the platform-agnostic `MeterEvent`s consumed by
 * `controller.ts`.
 *
 * Mapping (V2 has no single "message completed" event, so a turn is bracketed
 * by the step/execution lifecycle):
 *   session.step.started        -> turn    (first step of an execution only; later steps keep the graph)
 *   session.text/reasoning.delta-> delta   (streamed output)
 *   session.tool.input.delta    -> delta   (streamed tool arguments, e.g. a file body)
 *   (llama-swap models)         -> delta   (polled /slots decode counter, step start to execution end)
 *   session.tool.called         -> segment (tool pause; the graph stays continuous)
 *   session.step.ended/failed   ->         (accumulate exact provider tokens)
 *   session.execution.*         -> done    (finish the turn with the summed tokens)
 *   session.compaction.started  -> turn    (compaction is its own generation)
 *   session.compaction.delta    -> delta   (streamed summary)
 *   session.compaction.ended    -> done    (finish with the reported tokens)
 *   session.compaction.failed   -> done    (finish on the estimate)
 *   session.deleted             -> drop    (forget the session)
 */
import type { Context } from "@opencode/plugin/tui/context"
import type { MeterController, MeterEvent } from "./controller.ts"
import { cacheHitRate } from "./meter.ts"

/** The slice of a step's provider-reported usage the meter consumes. */
type StepTokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** Running provider-reported usage for one session's execution. */
type Usage = { output: number; input: number; cacheRead: number; cacheWrite: number }

/** Shape of one entry of llama-server's `/slots` response (only the fields used). */
type SlotInfo = { is_processing?: boolean; id_task?: number; next_token?: Array<{ n_decoded?: number }> }

/** Injectable side effects, so tests can fake llama-swap. */
export type WireV2Deps = { fetch: typeof fetch; now: () => number }

/**
 * Wire V2 session events into the controller. Returns an unsubscribe function
 * that `setup` hands back to OpenCode for disposal.
 */

export function wireV2(
  ctx: Context,
  controller: MeterController,
  onChange: () => void,
  deps: WireV2Deps = { fetch: (...args) => fetch(...args), now: () => Date.now() },
): () => void {
  const exact = new Map<string, Usage>()
  const compacting = new Set<string>()
  // Sessions whose current execution already opened a meter turn. A tool loop
  // emits a new assistant message per step; opening again would wipe the graph.
  const opened = new Set<string>()
  const offs: Array<() => void> = []
  const models = new Map<string, { providerID: string; id: string }>()
  // llama-server holds a tool call back until it is complete, so OpenCode
  // emits no events at all while a local model writes e.g. a file body. For
  // llama-swap models the meter therefore reads llama-server's live per-slot
  // decode counter (proxied at /upstream/<model>/slots) for the whole
  // execution and uses it instead of the event deltas while it answers.
  const opts = (ctx.options ?? {}) as { llamaSwapUrl?: string; llamaSwapProviders?: string[]; llamaSwapPollMs?: number }
  const swapUrl = (opts.llamaSwapUrl ?? "http://127.0.0.1:8080").replace(/\/$/, "")
  const swapProviders = opts.llamaSwapProviders ?? []
  const pollMs = opts.llamaSwapPollMs ?? 250
  type Poll = { modelID: string; timer?: ReturnType<typeof setTimeout>; task?: number; decoded?: number; okAt?: number }
  const polls = new Map<string, Poll>()

  const stopPoll = (sessionID: string) => {
    const poll = polls.get(sessionID)
    if (!poll) return
    clearTimeout(poll.timer)
    polls.delete(sessionID)
  }

  /**
   * The slot counter can only be attributed to a session when exactly one
   * session polls that model and exactly one slot is decoding. Otherwise (a
   * subagent on the same model, parallel slots) it would be counted twice or
   * credited to the wrong session, so the event deltas take over.
   */
  const ambiguous = (poll: Poll, processing: number) => {
    if (processing > 1) return true
    let sharing = 0
    for (const other of polls.values()) if (other.modelID === poll.modelID) sharing += 1
    return sharing > 1
  }

  const pollOnce = async (sessionID: string, poll: Poll) => {
    try {
      const res = await deps.fetch(`${swapUrl}/upstream/${encodeURIComponent(poll.modelID)}/slots`, {
        signal: AbortSignal.timeout(Math.max(200, pollMs * 2)),
      })
      if (!res.ok || polls.get(sessionID) !== poll) return
      const slots = (await res.json()) as SlotInfo[]
      if (polls.get(sessionID) !== poll) return
      const busy = Array.isArray(slots) ? slots.filter((x) => x.is_processing) : []
      if (ambiguous(poll, busy.length)) {
        // Hand back to event deltas and re-baseline once the counter is usable again.
        poll.okAt = undefined
        poll.task = undefined
        poll.decoded = undefined
        return
      }
      poll.okAt = deps.now()
      const slot = busy[0]
      const decoded = slot?.next_token?.[0]?.n_decoded
      if (!slot || typeof decoded !== "number") return
      // The first reading only sets the baseline (the request may be under way);
      // a later request on the slot (the next step of a tool loop) starts at zero.
      if (poll.task === undefined || poll.decoded === undefined) {
        poll.task = slot.id_task
        poll.decoded = decoded
        return
      }
      if (poll.task !== slot.id_task) {
        poll.task = slot.id_task
        poll.decoded = 0
      } else if (decoded < poll.decoded) {
        // Same request but a lower count: never count it again from zero.
        poll.decoded = decoded
        return
      }
      const tokens = decoded - poll.decoded
      poll.decoded = decoded
      // The meter estimates tokens as UTF-8 bytes / 4, so 4 bytes per token records the exact count.
      if (tokens > 0) emit({ kind: "delta", sessionID, text: "xxxx".repeat(tokens), at: deps.now() })
    } catch {
      // llama-swap down or the model swapped out: event deltas take over.
    }
  }

  /** Poll in a chain, never overlapping, so replies are always applied in order. */
  const loop = (sessionID: string, poll: Poll) => {
    void pollOnce(sessionID, poll).finally(() => {
      if (polls.get(sessionID) === poll) poll.timer = setTimeout(() => loop(sessionID, poll), pollMs)
    })
  }

  const startPoll = (sessionID: string) => {
    const model = models.get(sessionID)
    if (!model || !swapProviders.includes(model.providerID) || polls.has(sessionID)) return
    const poll: Poll = { modelID: model.id }
    polls.set(sessionID, poll)
    loop(sessionID, poll)
  }

  /** Whether llama-swap answered recently, so its counter replaces event deltas. */
  const polled = (sessionID: string) => {
    const okAt = polls.get(sessionID)?.okAt
    return okAt !== undefined && deps.now() - okAt < 1000
  }

  const emit = (event: MeterEvent) => {
    if (controller.handle(event)) onChange()
  }

  // A step's provider-reported usage; several steps can share one execution,
  // so totals are summed and settled when the execution ends.
  const addUsage = (sessionID: string, tokens: StepTokens | undefined) => {
    if (!tokens) return
    const usage = exact.get(sessionID) ?? { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 }
    usage.output += tokens.output + tokens.reasoning
    usage.input += tokens.input
    usage.cacheRead += tokens.cache.read
    usage.cacheWrite += tokens.cache.write
    exact.set(sessionID, usage)
  }

  /** Turn accumulated usage into a settle payload, or an empty one. */
  const settleWith = (sessionID: string, usage: Usage | undefined): MeterEvent => {
    if (!usage) return { kind: "done", sessionID, at: Date.now() }
    return {
      kind: "done",
      sessionID,
      at: Date.now(),
      exactTokens: usage.output > 0 ? usage.output : undefined,
      cache: cacheHitRate(usage.input, usage.cacheRead, usage.cacheWrite),
    }
  }

  const finish = (sessionID: string) => {
    stopPoll(sessionID)
    opened.delete(sessionID)
    // A compaction in flight owns the session's meter. Settling here would
    // rescale the graph twice, but this execution's totals must not be added
    // onto the next turn.
    if (compacting.has(sessionID)) {
      exact.delete(sessionID)
      return
    }
    const usage = exact.get(sessionID)
    exact.delete(sessionID)
    emit(settleWith(sessionID, usage))
  }

  offs.push(
    ctx.data.on("session.step.started", (event) => {
      const sessionID = event.data.sessionID
      models.set(sessionID, { providerID: event.data.model.providerID, id: event.data.model.id })
      startPoll(sessionID)
      if (opened.has(sessionID)) return
      opened.add(sessionID)
      emit({
        kind: "turn",
        sessionID,
        messageID: event.data.assistantMessageID,
        at: event.data.started,
      })
    }),
  )

  const onDelta = (sessionID: string, delta: string) => {
    if (!delta) return
    if (ctx.data.session.status(sessionID) === "idle") return
    if (polled(sessionID)) return
    emit({ kind: "delta", sessionID, text: delta, at: Date.now() })
  }
  offs.push(ctx.data.on("session.text.delta", (event) => onDelta(event.data.sessionID, event.data.delta)))
  offs.push(ctx.data.on("session.reasoning.delta", (event) => onDelta(event.data.sessionID, event.data.delta)))
  // Tool-call arguments (e.g. a file body for write/edit) stream as their own
  // deltas; without them the meter drops to "-" during most of an agent run.
  offs.push(ctx.data.on("session.tool.input.delta", (event) => onDelta(event.data.sessionID, event.data.delta)))

  offs.push(
    ctx.data.on("session.tool.called", (event) => {
      emit({ kind: "segment", sessionID: event.data.sessionID })
    }),
  )

  offs.push(ctx.data.on("session.step.ended", (event) => addUsage(event.data.sessionID, event.data.tokens)))
  offs.push(ctx.data.on("session.step.failed", (event) => addUsage(event.data.sessionID, event.data.tokens)))

  offs.push(
    ctx.data.on("session.execution.succeeded", (event) => finish(event.data.sessionID)),
  )
  offs.push(ctx.data.on("session.execution.failed", (event) => finish(event.data.sessionID)))
  offs.push(ctx.data.on("session.execution.interrupted", (event) => finish(event.data.sessionID)))

  // Compaction is a generation of its own: it streams a summary and reports its
  // own token usage, but never emits the step/execution events above.
  offs.push(
    ctx.data.on("session.compaction.started", (event) => {
      const sessionID = event.data.sessionID
      compacting.add(sessionID)
      opened.delete(sessionID)
      exact.delete(sessionID)
      emit({
        kind: "turn",
        sessionID,
        // The event carries no timestamp, so the arrival time starts the TTFT window.
        messageID: event.data.inputID ?? `compaction:${sessionID}`,
        at: Date.now(),
      })
    }),
  )

  const onCompactionDelta = (sessionID: string, text: string) => {
    if (!text) return
    emit({ kind: "delta", sessionID, text, at: Date.now() })
  }
  offs.push(ctx.data.on("session.compaction.delta", (event) => onCompactionDelta(event.data.sessionID, event.data.text)))

  const finishCompaction = (sessionID: string, tokens: StepTokens | undefined) => {
    compacting.delete(sessionID)
    opened.delete(sessionID)
    exact.delete(sessionID)
    emit(
      settleWith(
        sessionID,
        tokens
          ? { output: tokens.output + tokens.reasoning, input: tokens.input, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write }
          : undefined,
      ),
    )
  }
  offs.push(ctx.data.on("session.compaction.ended", (event) => finishCompaction(event.data.sessionID, event.data.tokens)))
  offs.push(ctx.data.on("session.compaction.failed", (event) => finishCompaction(event.data.sessionID, event.data.tokens)))

  offs.push(
    ctx.data.on("session.deleted", (event) => {
      stopPoll(event.data.sessionID)
      exact.delete(event.data.sessionID)
      compacting.delete(event.data.sessionID)
      opened.delete(event.data.sessionID)
      emit({ kind: "drop", sessionID: event.data.sessionID })
    }),
  )

  return () => {
    for (const sessionID of [...polls.keys()]) stopPoll(sessionID)
    for (const off of offs) off()
  }
}
