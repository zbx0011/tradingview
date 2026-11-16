export interface BarCountSettings {
  /** 高1/2/3、低1/2/3 总开关。 */
  barCount?: boolean
  barCountHigh?: boolean
  barCountLow?: boolean
}

export const DEFAULT_BAR_COUNT_SETTINGS = { barCount: true, barCountHigh: true, barCountLow: true }

export function visibleBarCountSides(settings: BarCountSettings) {
  const on = settings.barCount !== false
  return { high: on && settings.barCountHigh !== false, low: on && settings.barCountLow !== false }
}

export function setAllBarCounts<T extends BarCountSettings>(settings: T, visible: boolean): T {
  return { ...settings, barCount: visible, barCountHigh: visible, barCountLow: visible }
}

export function toggleBarCountSide<T extends BarCountSettings>(settings: T, side: 'high' | 'low'): T {
  const visible = visibleBarCountSides(settings)
  const next = { ...visible, [side]: !visible[side] }
  return { ...settings, barCount: next.high || next.low, barCountHigh: next.high, barCountLow: next.low }
}
