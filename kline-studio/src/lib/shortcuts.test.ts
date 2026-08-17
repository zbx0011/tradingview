import { describe, expect, it } from 'vitest'
import { parseIntervalShortcut, TRADINGVIEW_SHORTCUTS } from './shortcuts'

describe('TradingView shortcut catalog', () => {
  it('parses every interval supported by the chart toolbar', () => {
    expect(parseIntervalShortcut('1')).toBe('1m')
    expect(parseIntervalShortcut('15m')).toBe('15m')
    expect(parseIntervalShortcut('60')).toBe('1h')
    expect(parseIntervalShortcut('2H')).toBe('2h')
    expect(parseIntervalShortcut('日')).toBe('1d')
    expect(parseIntervalShortcut('W')).toBe('1w')
    expect(parseIntervalShortcut('7')).toBeNull()
  })

  it('contains the official chart, drawing and replay key groups', () => {
    const keys = new Set(TRADINGVIEW_SHORTCUTS.map((item) => item.keys))
    for (const shortcut of ['Ctrl+K', 'Alt+G', 'Alt+T', 'Ctrl+Alt+H', 'Shift+↓', 'Shift+→']) {
      expect(keys.has(shortcut)).toBe(true)
    }
  })
})
