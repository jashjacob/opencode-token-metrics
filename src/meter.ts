/**
 * Pure measurement logic for the TPS meter. No TUI or plugin imports, so it can
 * be unit tested directly.
 *
 * Model:
 *   - A "turn" is one assistant message, opened by `beginTurn` and closed by `settle`.
 *   - `samples` drive the live rate over a trailing window.
 *   - `buckets` count tokens per wall-clock second and drive the VU graph.
 *   - On settle the computed frame is frozen so the last result stays on screen
 *     until the next turn produces tokens.
 */

/** One streamed chunk and when it arrived. */
export type Sample = { at: number; tokens: number }

/** Tunables shared by the rate estimator. */
export type RateConfig = {
  rollingWindowMs: number
  idleTimeoutMs: number
  minSpanMs: number
}

/** Direction of the rate over the last two complete seconds. */
export type Trend = "up" | "down" | "flat" | "none"

/** How VU columns map to height. */
export type VuScale = "auto" | "fixed"

/** A fully computed view of one meter at a point in time. */
export type Snapshot = {
  rate: number
  avg: number
  live: boolean
  settled: boolean
  tokens: number
  elapsed: number
  peak: number
  trend: Trend
  trendPct: number
  ttftMs: number | undefined
  vu: number[]
}

/** Coarse speed band used for color. */
export type Tier = "idle" | "slow" | "medium" | "fast"

const encoder = new TextEncoder()

/** Eight vertical levels plus empty, low to high. */
const VU_GLYPHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]

/** Generous column count for the frozen frame; views slice it to their width. */
const FROZEN_COLUMNS = 240

/** Estimate tokens from UTF-8 byte length. Not exact, but stable while streaming. */
export function approxTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(encoder.encode(text).length / 4))
}

/**
 * Tokens per second over the trailing window, or -1 when there is nothing to
 * measure (no samples, or the newest sample has gone idle).
 */
export function measureRate(samples: Sample[], now: number, config: RateConfig): number {
  if (samples.length === 0) return -1
  const newest = samples[samples.length - 1]
  if (!newest) return -1
  if (now - newest.at > config.idleTimeoutMs) return -1

  const floor = now - config.rollingWindowMs
  let index = samples.length - 1
  let tokens = 0
  while (index >= 0) {
    const sample = samples[index]
    if (!sample || sample.at < floor) break
    tokens += sample.tokens
    index -= 1
  }

  const oldest = samples[index + 1]
  if (!oldest) return -1
  const span = Math.max(config.minSpanMs, now - oldest.at)
  return (tokens / span) * 1000
}

/** `-` when idle, one decimal below 100, whole numbers above. */
export function formatRate(rate: number): string {
  if (rate < 0) return "-"
  return rate >= 100 ? Math.round(rate).toString() : rate.toFixed(1)
}

/** Compact token counts: 999, 1.5k, 2.5m. */
export function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return count.toString()
}

/** Seconds below a minute, then `1m5s`. */
export function formatClock(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  return `${Math.floor(seconds / 60)}m${Math.floor(seconds % 60)}s`
}

/** Denominator for VU heights: the largest value in view, or a fixed target. */
export function vuFullScale(values: number[], mode: VuScale, fixedTps: number): number {
  if (mode === "fixed") return Math.max(1, fixedTps)
  let max = 0
  for (const value of values) {
    if (value > max) max = value
  }
  return Math.max(1, max)
}

/** Render the newest `maxCells` values as glyphs; short histories stay short. */
export function renderVu(values: number[], maxCells: number, fullTps: number): string {
  const cap = Math.max(0, Math.floor(maxCells))
  if (cap === 0) return ""
  const scale = fullTps <= 0 ? 1 : fullTps
  return values
    .slice(-cap)
    .map((value) => {
      const level = Math.max(0, Math.min(VU_GLYPHS.length - 1, Math.round((value / scale) * (VU_GLYPHS.length - 1))))
      return VU_GLYPHS[level]
    })
    .join("")
}

/** Band a rate into a color tier. */
export function rateTier(rate: number, slowTps: number, fastTps: number): Tier {
  if (rate < 0) return "idle"
  if (rate < slowTps) return "slow"
  if (rate < fastTps) return "medium"
  return "fast"
}

/** Tracks generation speed for a single session across turns. */
export class TpsMeter {
  private readonly samples: Sample[] = []
  private readonly buckets = new Map<number, number>()
  private readonly config: RateConfig
  private readonly peakConfig: RateConfig
  private readonly clock: () => number
  readonly startedAt: number
  private tokens = 0
  private settled = false
  private settledRate = 0
  private peakRate = 0
  private messageID: string | undefined
  private turnStart: number | undefined
  private firstTokenAt: number | undefined
  private lastTokenAt: number | undefined
  private graphStartAt: number | undefined
  private turnStarted = false
  private frozen: Snapshot | undefined

  constructor(config: RateConfig, clock: () => number = Date.now, startedAt: number = clock()) {
    this.config = config
    this.clock = clock
    this.startedAt = startedAt
    // Peak is sampled over a one-second window so it is a rate, comparable to
    // the average, rather than a whole-second bucket that under-reports.
    this.peakConfig = { rollingWindowMs: 1000, idleTimeoutMs: Number.MAX_SAFE_INTEGER, minSpanMs: config.minSpanMs }
  }

  /**
   * Note that a new assistant message exists. Keeps the earliest start time for
   * the same message, and does not clear the frozen frame yet: the reset is
   * deferred until the first token so the previous result stays visible.
   */
  beginTurn(messageID: string, at: number = this.clock()): void {
    if (this.messageID === messageID) {
      if (this.turnStart === undefined || at < this.turnStart) this.turnStart = at
      return
    }
    this.messageID = messageID
    this.turnStart = at
    this.turnStarted = false
  }

  /** Drop the current turn's data. Called by `record` on the first token. */
  private startTurn(): void {
    this.tokens = 0
    this.samples.splice(0)
    this.buckets.clear()
    this.peakRate = 0
    this.settled = false
    this.settledRate = 0
    this.firstTokenAt = undefined
    this.lastTokenAt = undefined
    this.graphStartAt = undefined
    this.frozen = undefined
    this.turnStarted = true
  }

  /**
   * Restart the live rate for a new burst (e.g. after a tool call) while
   * keeping the graph and turn totals, so the graph stays continuous.
   */
  newSegment(): void {
    this.samples.splice(0)
  }

  /** Record a streamed chunk and return the tokens attributed to it. */
  record(text: string, at: number = this.clock(), messageID?: string): number {
    const tokens = approxTokens(text)
    if (tokens === 0) return 0
    if (messageID !== undefined) this.beginTurn(messageID, at)
    if (!this.turnStarted) this.startTurn()
    this.samples.push({ at, tokens })
    this.tokens += tokens
    if (this.firstTokenAt === undefined) this.firstTokenAt = at
    if (this.graphStartAt === undefined) this.graphStartAt = at
    this.lastTokenAt = at
    const second = Math.floor(at / 1000)
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + tokens)
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) this.peakRate = instant
    this.settled = false
    this.frozen = undefined
    return tokens
  }

  /** Close the turn, prefer exact provider tokens, and freeze the final frame. */
  settle(at: number = this.clock(), exactTokens?: number): void {
    if (exactTokens !== undefined && exactTokens > 0) this.tokens = exactTokens
    const measured = measureRate(this.samples, at, this.config)
    // With no fresh samples (e.g. the turn ended right after a tool call), fall
    // back to the average instead of freezing a misleading 0.
    this.settledRate = measured >= 0 ? measured : this.average()
    const instant = measureRate(this.samples, at, this.peakConfig)
    if (instant > this.peakRate) this.peakRate = instant
    this.settled = true
    this.frozen = this.compute(at, FROZEN_COLUMNS)
  }

  /**
   * Drop samples older than the rolling window. Buckets are kept for the whole
   * turn so the graph survives pauses and the held frame stays complete.
   */
  prune(at: number = this.clock()): void {
    const floor = at - this.config.rollingWindowMs
    const first = this.samples[0]
    if (first && first.at < floor) {
      this.samples.splice(0, this.samples.length, ...this.samples.filter((s) => s.at >= floor))
    }
  }

  /** Current view: the frozen frame once settled, otherwise a live computation. */
  snapshot(at: number = this.clock(), columns = 12): Snapshot {
    const frozen = this.frozen
    if (this.settled && frozen) {
      const vu = frozen.vu.slice(-Math.max(0, columns))
      return vu.length === frozen.vu.length ? frozen : { ...frozen, vu }
    }
    return this.compute(at, columns)
  }

  /** Average tokens per second over the turn's token span. */
  private average(): number {
    if (this.tokens === 0) return 0
    const span =
      this.firstTokenAt !== undefined && this.lastTokenAt !== undefined
        ? Math.max(this.config.minSpanMs, this.lastTokenAt - this.firstTokenAt)
        : this.config.minSpanMs
    return (this.tokens / span) * 1000
  }

  private compute(at: number, columns: number): Snapshot {
    const measured = measureRate(this.samples, at, this.config)
    const current = Math.floor(at / 1000)
    const cap = Math.max(0, Math.floor(columns))

    // One column per second since this segment's first token, capped to the
    // requested width. Leading empty seconds are dropped so the graph starts
    // at real data instead of leaving a gap after the label.
    const vu: number[] = []
    if (cap > 0 && this.graphStartAt !== undefined) {
      const start = Math.max(Math.floor(this.graphStartAt / 1000), current - cap + 1)
      for (let second = start; second <= current; second += 1) vu.push(this.buckets.get(second) ?? 0)
      while (vu.length > 0 && vu[0] === 0) vu.shift()
      while (vu.length > 0 && vu[vu.length - 1] === 0) vu.pop()
    }

    // Trend compares the last two complete seconds, skipping the partial current one.
    const prev1 = this.buckets.get(current - 1) ?? 0
    const prev2 = this.buckets.get(current - 2) ?? 0
    let trend: Trend = "none"
    let trendPct = 0
    if (prev1 !== 0 || prev2 !== 0) {
      if (prev1 > prev2) {
        trend = "up"
        trendPct = prev2 > 0 ? ((prev1 - prev2) / prev2) * 100 : 100
      } else if (prev1 < prev2) {
        trend = "down"
        trendPct = prev2 > 0 ? ((prev2 - prev1) / prev2) * 100 : 100
      } else {
        trend = "flat"
      }
    }

    const ttftMs =
      this.turnStart === undefined || this.firstTokenAt === undefined
        ? undefined
        : Math.max(0, this.firstTokenAt - this.turnStart)

    return {
      rate: this.settled ? this.settledRate : measured,
      avg: this.average(),
      live: !this.settled && measured >= 0,
      settled: this.settled,
      tokens: this.tokens,
      elapsed: at - (this.turnStart ?? this.startedAt),
      peak: Math.max(this.peakRate, this.average()),
      trend,
      trendPct,
      ttftMs,
      vu,
    }
  }
}

/** Keeps one `TpsMeter` per session. */
export class MeterStore {
  private readonly meters = new Map<string, TpsMeter>()
  private readonly config: RateConfig
  private readonly clock: () => number

  constructor(config: RateConfig, clock: () => number = Date.now) {
    this.config = config
    this.clock = clock
  }

  get size(): number {
    return this.meters.size
  }

  record(sessionID: string, text: string, at?: number, messageID?: string): void {
    this.meter(sessionID).record(text, at, messageID)
  }

  beginTurn(sessionID: string, messageID: string, at?: number): void {
    this.meter(sessionID).beginTurn(messageID, at)
  }

  newSegment(sessionID: string): boolean {
    const meter = this.meters.get(sessionID)
    if (!meter) return false
    meter.newSegment()
    return true
  }

  settle(sessionID: string, exactTokens?: number, at?: number): boolean {
    const meter = this.meters.get(sessionID)
    if (!meter) return false
    meter.settle(at, exactTokens)
    return true
  }

  /** Forget a session's meter, e.g. when the session is deleted. */
  drop(sessionID: string): boolean {
    return this.meters.delete(sessionID)
  }

  snapshot(sessionID: string, at?: number, columns?: number): Snapshot | undefined {
    return this.meters.get(sessionID)?.snapshot(at, columns)
  }

  prune(at?: number): void {
    for (const meter of this.meters.values()) meter.prune(at)
  }

  private meter(sessionID: string): TpsMeter {
    let meter = this.meters.get(sessionID)
    if (!meter) {
      meter = new TpsMeter(this.config, this.clock)
      this.meters.set(sessionID, meter)
    }
    return meter
  }
}
