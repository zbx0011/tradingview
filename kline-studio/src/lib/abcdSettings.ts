import { ABCD_TIMEFRAMES, type AbcdTimeframe } from './abcdChart'

export const ABCD_LEVELS: readonly AbcdTimeframe[] = ABCD_TIMEFRAMES.map((t) => t.label)

export type AbcdKind = 'leg' | 'spike'

export const ABCD_KINDS: readonly { kind: AbcdKind, label: string, title: string }[] = [
  { kind: 'leg', label: '两腿', title: '普通 AB=CD：第二腿 CD 和第一腿 AB 等长' },
  { kind: 'spike', label: '急速转通道', title: '急速转通道：从急速起点量到急速顶点，再从通道起点（急速后的回调低点）量同样长' },
]

export interface AbcdSettings {
  abcd?: boolean
  abcdTimeframes?: Partial<Record<AbcdTimeframe, boolean>>
  abcdKinds?: Partial<Record<AbcdKind, boolean>>
}

export const DEFAULT_ABCD_SETTINGS = {
  abcd: true,
  abcdTimeframes: { '1m': true, '5m': true, '15m': true, '30m': true, '1h': true },
  abcdKinds: { leg: true, spike: true },
}

export function visibleAbcdKinds(settings: AbcdSettings): AbcdKind[] {
  return ABCD_KINDS.map((k) => k.kind).filter((kind) => settings.abcdKinds?.[kind] !== false)
}

export function toggleAbcdKind<T extends AbcdSettings>(settings: T, kind: AbcdKind): T {
  const visible = visibleAbcdKinds(settings)
  return { ...settings, abcdKinds: Object.fromEntries(ABCD_KINDS.map(({ kind: k }) => [k, k === kind ? !visible.includes(k) : visible.includes(k)])) }
}

export function visibleAbcdTimeframes(settings: AbcdSettings): AbcdTimeframe[] {
  return settings.abcd === false || !visibleAbcdKinds(settings).length ? [] : ABCD_LEVELS.filter((level) => settings.abcdTimeframes?.[level] !== false)
}

export function setAllAbcdTimeframes<T extends AbcdSettings>(settings: T, visible: boolean): T {
  // Turning AB=CD on with both kinds switched off would still show nothing: switch the kinds back on too.
  const kinds = visible && !visibleAbcdKinds(settings).length ? { abcdKinds: { leg: true, spike: true } } : {}
  return { ...settings, abcd: visible, abcdTimeframes: Object.fromEntries(ABCD_LEVELS.map((level) => [level, visible])), ...kinds }
}

export function toggleAbcdTimeframe<T extends AbcdSettings>(settings: T, timeframe: AbcdTimeframe): T {
  const visible = visibleAbcdTimeframes(settings)
  const timeframes = Object.fromEntries(ABCD_LEVELS.map((level) => [level, level === timeframe ? !visible.includes(level) : visible.includes(level)]))
  return { ...settings, abcd: Object.values(timeframes).some(Boolean), abcdTimeframes: timeframes }
}
