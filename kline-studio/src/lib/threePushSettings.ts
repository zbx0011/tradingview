import type { ThreePushTimeframe } from './threePush'

export const THREE_PUSH_TIMEFRAMES: readonly ThreePushTimeframe[] = ['1m', '5m', '15m']

export interface ThreePushSettings {
  threePush?: boolean
  threePushTimeframes?: Partial<Record<ThreePushTimeframe, boolean>>
  threePushMergeOverlaps?: boolean
}

export const DEFAULT_THREE_PUSH_SETTINGS = {
  threePush: true,
  threePushTimeframes: { '1m': true, '5m': true, '15m': true },
  threePushMergeOverlaps: true,
}

export function normalizeThreePushSettings(settings: ThreePushSettings) {
  return {
    threePush: settings.threePush !== false,
    threePushTimeframes: {
      '1m': settings.threePushTimeframes?.['1m'] !== false,
      '5m': settings.threePushTimeframes?.['5m'] !== false,
      '15m': settings.threePushTimeframes?.['15m'] !== false,
    },
    threePushMergeOverlaps: settings.threePushMergeOverlaps !== false,
  }
}

export function visibleThreePushTimeframes(settings: ThreePushSettings) {
  return settings.threePush === false ? [] : THREE_PUSH_TIMEFRAMES.filter((timeframe) => settings.threePushTimeframes?.[timeframe] !== false)
}

export function setAllThreePushTimeframes<T extends ThreePushSettings>(settings: T, visible: boolean): T {
  return { ...settings, threePush: visible, threePushTimeframes: { '1m': visible, '5m': visible, '15m': visible } }
}

export function toggleThreePushTimeframe<T extends ThreePushSettings>(settings: T, timeframe: ThreePushTimeframe): T {
  const visible = visibleThreePushTimeframes(settings)
  const timeframes = Object.fromEntries(THREE_PUSH_TIMEFRAMES.map((level) => [level, level === timeframe ? !visible.includes(level) : visible.includes(level)]))
  return { ...settings, threePush: Object.values(timeframes).some(Boolean), threePushTimeframes: timeframes }
}
