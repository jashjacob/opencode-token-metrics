import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MeterStore,
  TpsMeter,
  approxTokens,
  formatClock,
  formatCount,
  formatRate,
  measureRate,
  rateTier,
  renderVu,
  vuFullScale,
  type Sample,
} from "../src/meter.ts"

const CONFIG = { rollingWindowMs: 1000, idleTimeoutMs: 500, minSpanMs: 200 }
const WIDE = { rollingWindowMs: 60_000, idleTimeoutMs: 60_000, minSpanMs: 200 }

describe("approxTokens", () => {
  it("returns 0 for empty input", () => {
    assert.equal(approxTokens(""), 0)
  })

  it("rounds bytes divided by four", () => {
    assert.equal(approxTokens("abcd"), 1)
    assert.equal(approxTokens("abcdefgh"), 2)
    assert.equal(approxTokens("a".repeat(100)), 25)
  })

  it("counts multi-byte characters", () => {
    assert.ok(approxTokens("日本") >= 1)
  })
})

describe("measureRate", () => {
  it("returns -1 with no samples", () => {
    assert.equal(measureRate([], 1000, CONFIG), -1)
  })

  it("uses the minimum span for a single fresh sample", () => {
    const samples: Sample[] = [{ at: 1000, tokens: 10 }]
    assert.equal(measureRate(samples, 1000, CONFIG), 50)
  })

  it("uses elapsed span once it exceeds the minimum", () => {
    const samples: Sample[] = [{ at: 0, tokens: 10 }]
    assert.equal(measureRate(samples, 400, CONFIG), 25)
  })

  it("returns -1 once the newest sample is idle", () => {
    const samples: Sample[] = [{ at: 0, tokens: 10 }]
    assert.equal(measureRate(samples, 600, CONFIG), -1)
  })

  it("ignores samples outside the rolling window", () => {
    const samples: Sample[] = [
      { at: 0, tokens: 10 },
      { at: 900, tokens: 10 },
    ]
    assert.equal(measureRate(samples, 1010, CONFIG), 50)
  })

  it("scales with token count", () => {
    const low = measureRate([{ at: 900, tokens: 5 }], 1000, CONFIG)
    const high = measureRate([{ at: 900, tokens: 50 }], 1000, CONFIG)
    assert.ok(high > low)
  })
})

describe("formatters", () => {
  it("formatRate", () => {
    assert.equal(formatRate(-1), "-")
    assert.equal(formatRate(12.34), "12.3")
    assert.equal(formatRate(150), "150")
  })

  it("formatCount", () => {
    assert.equal(formatCount(0), "0")
    assert.equal(formatCount(999), "999")
    assert.equal(formatCount(1500), "1.5k")
    assert.equal(formatCount(2_500_000), "2.5m")
  })

  it("formatClock", () => {
    assert.equal(formatClock(0), "0.0s")
    assert.equal(formatClock(500), "0.5s")
    assert.equal(formatClock(59_000), "59.0s")
    assert.equal(formatClock(60_000), "1m0s")
    assert.equal(formatClock(65_000), "1m5s")
    assert.equal(formatClock(-100), "0.0s")
  })

  it("rateTier boundaries", () => {
    assert.equal(rateTier(-1, 10, 30), "idle")
    assert.equal(rateTier(9.99, 10, 30), "slow")
    assert.equal(rateTier(10, 10, 30), "medium")
    assert.equal(rateTier(29.99, 10, 30), "medium")
    assert.equal(rateTier(30, 10, 30), "fast")
    assert.equal(rateTier(500, 10, 30), "fast")
  })
})

describe("renderVu", () => {
  it("renders only the columns that exist", () => {
    assert.equal(renderVu([], 4, 50), "")
    assert.equal(renderVu([50], 4, 50), "█")
    assert.equal(renderVu([10, 20], 12, 50).length, 2)
  })

  it("maps levels proportionally", () => {
    assert.equal(renderVu([0], 1, 50), " ")
    assert.equal(renderVu([6.25], 1, 50), "▁")
    assert.equal(renderVu([25], 1, 50), "▄")
    assert.equal(renderVu([50], 1, 50), "█")
  })

  it("clamps above the full-scale value", () => {
    assert.equal(renderVu([1000], 1, 50), "█")
  })

  it("trims to the most recent columns", () => {
    assert.equal(renderVu([0, 0, 50, 50], 2, 50), "██")
  })

  it("returns empty for zero cells", () => {
    assert.equal(renderVu([50], 0, 50), "")
  })
})

describe("vuFullScale", () => {
  it("scales to the largest value in auto mode", () => {
    assert.equal(vuFullScale([3, 8, 15, 22], "auto", 50), 22)
  })

  it("never returns zero", () => {
    assert.equal(vuFullScale([], "auto", 50), 1)
  })

  it("uses the fixed value in fixed mode", () => {
    assert.equal(vuFullScale([3, 8, 15, 22], "fixed", 50), 50)
    assert.equal(vuFullScale([200], "fixed", 50), 50)
  })
})

describe("TpsMeter", () => {
  it("accumulates tokens and reports elapsed", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 1000)
    assert.equal(meter.record("abcdefgh", 1000), 2)
    const snap = meter.snapshot(1100)
    assert.equal(snap.tokens, 2)
    assert.equal(snap.elapsed, 100)
    assert.equal(snap.settled, false)
    assert.equal(snap.live, true)
    assert.ok(snap.rate > 0)
  })

  it("ignores empty deltas", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    assert.equal(meter.record("", 0), 0)
    assert.equal(meter.snapshot(0).tokens, 0)
  })

  it("settles with exact tokens and freezes the rate", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.record("a".repeat(400), 900)
    meter.settle(1000, 123)
    const snap = meter.snapshot(1200)
    assert.equal(snap.settled, true)
    assert.equal(snap.live, false)
    assert.equal(snap.tokens, 123)
    assert.ok(snap.rate > 0)
  })

  it("settles to zero when no samples were recorded", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.settle(1000, 0)
    const snap = meter.snapshot(1000)
    assert.equal(snap.settled, true)
    assert.equal(snap.rate, 0)
  })

  it("resumes live tracking after a settle", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.settle(100, 10)
    meter.record("abcd", 200)
    assert.equal(meter.snapshot(200).settled, false)
  })

  it("prune keeps in-window samples usable", () => {
    const meter = new TpsMeter(CONFIG, () => 0, 0)
    meter.record("abcdefgh", 5000)
    meter.record("abcdefgh", 5050)
    meter.prune(6000)
    assert.equal(meter.snapshot(6000, 4).tokens, 4)
  })

  it("buckets samples per second and grows the VU meter", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    assert.deepEqual(meter.snapshot(1100, 12).vu, [10])
    meter.record("a".repeat(40), 2100)
    assert.deepEqual(meter.snapshot(2200, 12).vu, [10, 10])
    assert.deepEqual(meter.snapshot(4200, 12).vu, [10, 10])
  })

  it("tracks peak as a rate, never below the average", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(160), 2000)
    meter.record("a".repeat(40), 3000)
    const snap = meter.snapshot(3100, 4)
    assert.equal(snap.peak, 50)
    assert.ok(snap.peak >= snap.avg)
  })

  it("keeps peak at or above average on short fast turns", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(200), 1000)
    meter.record("a".repeat(200), 1100)
    const snap = meter.snapshot(1100, 4)
    assert.equal(snap.avg, 500)
    assert.ok(snap.peak >= snap.avg)
  })

  it("reports an upward trend", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(20), 1000)
    meter.record("a".repeat(80), 2000)
    const snap = meter.snapshot(2100, 4)
    assert.equal(snap.trend, "up")
    assert.equal(snap.trendPct, 100)
  })

  it("reports a downward trend", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(20), 2000)
    meter.record("a".repeat(40), 3000)
    const snap = meter.snapshot(3100, 4)
    assert.equal(snap.trend, "down")
    assert.equal(snap.trendPct, 50)
  })

  it("reports no trend while idle", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    assert.equal(meter.snapshot(5000, 4).trend, "none")
  })

  it("measures time to first token from the turn start", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.beginTurn("m1", 1000)
    meter.record("abcdefgh", 1500, "m1")
    assert.equal(meter.snapshot(1600, 4).ttftMs, 500)
  })

  it("keeps the earliest turn start for the same message", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.beginTurn("m1", 1000)
    meter.record("abcdefgh", 1500, "m1")
    meter.beginTurn("m1", 1200)
    assert.equal(meter.snapshot(1600, 4).ttftMs, 500)
  })

  it("resets a turn when the message changes", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000, "m1")
    meter.record("a".repeat(40), 2000, "m2")
    const snap = meter.snapshot(2100, 4)
    assert.equal(snap.tokens, 10)
    assert.equal(snap.peak, 50)
  })

  it("newSegment resets the live rate but keeps the graph and totals", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.newSegment()
    const snap = meter.snapshot(1500, 4)
    assert.equal(snap.tokens, 10)
    assert.equal(snap.rate, -1)
    assert.deepEqual(snap.vu, [10])
  })

  it("keeps the graph continuous across segments", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    meter.newSegment()
    meter.record("a".repeat(40), 5000)
    assert.deepEqual(meter.snapshot(5100, 12).vu, [10, 10, 0, 0, 10])
  })

  it("keeps the graph in the held frame when the turn ends after a tool", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000, "m1")
    meter.record("a".repeat(80), 2000, "m1")
    meter.newSegment()
    meter.settle(2500, 30)
    const snap = meter.snapshot(90_000, 12)
    assert.equal(snap.settled, true)
    assert.ok(snap.vu.some((value) => value > 0))
    assert.ok(snap.rate > 0)
  })

  it("reports the turn average from tokens over the token span", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    assert.equal(meter.snapshot(2000, 4).avg, 20)
  })

  it("reports the average from exact tokens after settling", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.record("a".repeat(40), 2000)
    meter.settle(2000, 100)
    assert.equal(meter.snapshot(2000, 4).avg, 100)
  })

  it("holds the final frame after the window would have pruned it", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000)
    meter.settle(1200, 10)
    const snap = meter.snapshot(200_000, 4)
    assert.equal(snap.settled, true)
    assert.equal(snap.rate, 50)
    assert.equal(snap.avg, 50)
    assert.equal(snap.peak, 50)
    assert.ok(snap.peak >= snap.avg)
    assert.ok(snap.vu.some((value) => value > 0))
  })

  it("clears the held frame when a new turn starts", () => {
    const meter = new TpsMeter(WIDE, () => 0, 0)
    meter.record("a".repeat(40), 1000, "m1")
    meter.settle(1200, 10)
    meter.record("a".repeat(40), 200_000, "m2")
    const snap = meter.snapshot(200_001, 4)
    assert.equal(snap.settled, false)
    assert.equal(snap.live, true)
  })
})

describe("MeterStore", () => {
  it("tracks sessions independently", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    store.record("b", "a".repeat(40), 1000)
    assert.equal(store.size, 2)
    assert.equal(store.snapshot("a", 1000, 4)?.tokens, 2)
    assert.equal(store.snapshot("b", 1000, 4)?.tokens, 10)
  })

  it("returns undefined and false for unknown sessions", () => {
    const store = new MeterStore(CONFIG, () => 0)
    assert.equal(store.snapshot("missing", 0, 4), undefined)
    assert.equal(store.settle("missing", 10, 0), false)
    assert.equal(store.newSegment("missing"), false)
  })

  it("settles a known session", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    assert.equal(store.settle("a", 99, 1100), true)
    assert.equal(store.snapshot("a", 1100, 4)?.tokens, 99)
  })

  it("drops sessions", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 1000)
    assert.equal(store.drop("a"), true)
    assert.equal(store.drop("a"), false)
    assert.equal(store.size, 0)
  })

  it("prunes every session", () => {
    const store = new MeterStore(CONFIG, () => 0)
    store.record("a", "abcdefgh", 0)
    store.record("b", "abcdefgh", 5000)
    store.prune(6000)
    assert.equal(store.snapshot("a", 6000, 4)?.tokens, 2)
    assert.equal(store.snapshot("b", 6000, 4)?.tokens, 2)
  })
})
