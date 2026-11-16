import { ABCD_TIMEFRAMES, type AbcdTimeframe } from './abcdChart'

export const ABCD_LEVELS: readonly AbcdTimeframe[] = ABCD_TIMEFRAMES.map((t) => t.label)

export interface AbcdSettings {
  abcd?: boolean
  abcdTimeframes?: Partial<Record<AbcdTimeframe, boolean>>
}

export const DEFAULT_ABCD_SETTINGS = {
  abcd: true,
  abcdTimeframes: { '1m': true, '5m': true, '15m': true, '30m': true, '1h': true },
}

export function visibleAbcdTimeframes(settings: AbcdSettings): AbcdTimeframe[] {
  return settings.abcd === false ? [] : ABCD_LEVELS.filter((level) => settings.abcdTimeframes?.[level] !== false)
}

export function setAllAbcdTimeframes<T extends AbcdSettings>(settings: T, visible: boolean): T {
  return { ...settings, abcd: visible, abcdTimeframes: Object.fromEntries(ABCD_LEVELS.map((level) => [level, visible])) }
}

export function toggleAbcdTimeframe<T extends AbcdSettings>(settings: T, timeframe: AbcdTimeframe): T {
  const visible = visibleAbcdTimeframes(settings)
  const timeframes = Object.fromEntries(ABCD_LEVELS.map((level) => [level, level === timeframe ? !visible.includes(level) : visible.includes(level)]))
  return { ...settings, abcd: Object.values(timeframes).some(Boolean), abcdTimeframes: timeframes }
}
