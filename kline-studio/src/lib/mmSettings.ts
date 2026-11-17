import { MM_TIMEFRAMES, type MmTimeframe } from './mmChart'

export const MM_LEVELS: readonly MmTimeframe[] = MM_TIMEFRAMES.map((t) => t.label)

export type MmKind = 'swing' | 'spike'

export const MM_KINDS: readonly { kind: MmKind, label: string, title: string }[] = [
  { kind: 'swing', label: '突破点', title: '被实体突破的高低点（波段或区间的顶底）：从另一端量到它，再翻一倍' },
  { kind: 'spike', label: '连续大K', title: '连续大阳线 / 大阴线：第一根开盘到最后一根收盘的实体，再翻一倍' },
]

export interface MmSettings {
  mm?: boolean
  mmTimeframes?: Partial<Record<MmTimeframe, boolean>>
  mmKinds?: Partial<Record<MmKind, boolean>>
}

export const DEFAULT_MM_SETTINGS = {
  mm: true,
  mmTimeframes: { '1m': true, '5m': true, '15m': true, '30m': true, '1h': true },
  mmKinds: { swing: true, spike: true },
}

export function visibleMmKinds(settings: MmSettings): MmKind[] {
  return MM_KINDS.map((k) => k.kind).filter((kind) => settings.mmKinds?.[kind] !== false)
}

export function toggleMmKind<T extends MmSettings>(settings: T, kind: MmKind): T {
  const visible = visibleMmKinds(settings)
  return { ...settings, mmKinds: Object.fromEntries(MM_KINDS.map(({ kind: k }) => [k, k === kind ? !visible.includes(k) : visible.includes(k)])) }
}

export function visibleMmTimeframes(settings: MmSettings): MmTimeframe[] {
  return settings.mm === false || !visibleMmKinds(settings).length ? [] : MM_LEVELS.filter((level) => settings.mmTimeframes?.[level] !== false)
}

export function setAllMmTimeframes<T extends MmSettings>(settings: T, visible: boolean): T {
  // Turning MM on with both kinds switched off would still show nothing: switch the kinds back on too.
  const kinds = visible && !visibleMmKinds(settings).length ? { mmKinds: { swing: true, spike: true } } : {}
  return { ...settings, mm: visible, mmTimeframes: Object.fromEntries(MM_LEVELS.map((level) => [level, visible])), ...kinds }
}

export function toggleMmTimeframe<T extends MmSettings>(settings: T, timeframe: MmTimeframe): T {
  const visible = visibleMmTimeframes(settings)
  const timeframes = Object.fromEntries(MM_LEVELS.map((level) => [level, level === timeframe ? !visible.includes(level) : visible.includes(level)]))
  return { ...settings, mm: Object.values(timeframes).some(Boolean), mmTimeframes: timeframes }
}
