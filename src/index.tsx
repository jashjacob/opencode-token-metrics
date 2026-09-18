/** @jsxImportSource @opentui/solid */
/**
 * TUI rendering layer. Registers the `session_prompt_right` slot, wires events
 * through `createMeterController`, and renders one reactive line from the
 * store's snapshot. All measurement lives in `meter.ts`.
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { Show, createMemo, createSignal } from "solid-js"
import { createMeterController } from "./controller.ts"
import { formatLine, hasData, rateTier, type Tier, type VuScale } from "./meter.ts"

export type TpsMeterOptions = {
  enabled?: boolean
  rollingWindowMs?: number
  idleTimeoutMs?: number
  minSpanMs?: number
  vuColumns?: number
  vuFullTps?: number
  vuScale?: VuScale
  slowTps?: number
  fastTps?: number
  showVu?: boolean
  showTrend?: boolean
  showAvg?: boolean
  showPeak?: boolean
  showTtft?: boolean
  showTokenCount?: boolean
  showElapsed?: boolean
  alwaysShow?: boolean
  idleText?: string
  label?: string
}

const DEFAULTS = {
  enabled: true,
  rollingWindowMs: 5000,
  idleTimeoutMs: 1500,
  minSpanMs: 300,
  vuColumns: 12,
  vuFullTps: 50,
  vuScale: "auto" as VuScale,
  slowTps: 10,
  fastTps: 30,
  showVu: true,
  showTrend: true,
  showAvg: true,
  showPeak: true,
  showTtft: true,
  showTokenCount: false,
  showElapsed: false,
  alwaysShow: false,
  idleText: "idle",
  label: "tok/s",
} satisfies Required<TpsMeterOptions>

type ResolvedOptions = typeof DEFAULTS

function tierColor(tier: Tier, theme: TuiThemeCurrent) {
  switch (tier) {
    case "slow":
      return theme.error
    case "medium":
      return theme.warning
    case "fast":
      return theme.success
    default:
      return theme.textMuted
  }
}

function MeterLine(props: {
  api: TuiPluginApi
  sessionID: string
  store: ReturnType<typeof createMeterController>["store"]
  rev: () => number
  beat: () => number
  options: ResolvedOptions
}) {
  const snapshot = createMemo(() => {
    props.rev()
    props.beat()
    return props.store.snapshot(props.sessionID, Date.now(), props.options.vuColumns)
  })

  const active = createMemo(() => hasData(snapshot()))

  const mounted = createMemo(() => active() || props.options.alwaysShow)

  const text = createMemo(() => {
    const state = snapshot()
    if (!active() || !state) {
      return props.options.alwaysShow ? `${props.options.label} ${props.options.idleText}` : ""
    }
    return formatLine(state, props.options)
  })

  const color = createMemo(() => {
    const state = snapshot()
    const theme = props.api.theme.current
    if (!state) return theme.textMuted
    return tierColor(rateTier(state.rate, props.options.slowTps, props.options.fastTps), theme)
  })

  return (
    <Show when={mounted()}>
      <text fg={color()}>{text()}</text>
    </Show>
  )
}

const tui: TuiPlugin = async (api, rawOptions) => {
  const options: ResolvedOptions = { ...DEFAULTS, ...((rawOptions ?? {}) as Partial<ResolvedOptions>) }
  if (!options.enabled) return

  const [rev, setRev] = createSignal(0)
  const [beat, setBeat] = createSignal(0)
  const controller = createMeterController(api, options, () => setRev((n) => n + 1))

  const timer = setInterval(() => {
    controller.tick()
    setBeat((n) => n + 1)
  }, 1000)

  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    slots: {
      session_prompt_right(_ctx, props) {
        return (
          <MeterLine
            api={api}
            sessionID={props.session_id}
            store={controller.store}
            rev={rev}
            beat={beat}
            options={options}
          />
        )
      },
    },
  })
}

export default { id: "tps-meter", tui } satisfies TuiPluginModule
