import { describe, expect, it } from 'vitest'
import { parseIntervalShortcut, resolveHistoryShortcut, TRADINGVIEW_SHORTCUTS } from './shortcuts'

const historyKey = (overrides: Partial<KeyboardEvent>) => resolveHistoryShortcut({
  altKey: false,
  code: '',
  ctrlKey: false,
  key: '',
  metaKey: false,
  shiftKey: false,
  ...overrides,
})

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
    for (const shortcut of ['Ctrl+K', 'Ctrl+Z', 'Ctrl+Y / Ctrl+Shift+Z', 'Alt+G', 'Alt+T', 'Ctrl+Alt+H', 'Shift+↓', 'Shift+→']) {
      expect(keys.has(shortcut)).toBe(true)
    }
  })

  it('maps Ctrl+Z to undo and common redo shortcuts to redo', () => {
    expect(historyKey({ ctrlKey: true, key: 'z', code: 'KeyZ' })).toBe('undo')
    expect(historyKey({ ctrlKey: true, shiftKey: true, key: 'Z', code: 'KeyZ' })).toBe('redo')
    expect(historyKey({ ctrlKey: true, key: 'y', code: 'KeyY' })).toBe('redo')
    expect(historyKey({ metaKey: true, key: 'z', code: 'KeyZ' })).toBe('undo')
  })

  it('does not steal unrelated or Alt-modified shortcuts', () => {
    expect(historyKey({ key: 'z', code: 'KeyZ' })).toBeNull()
    expect(historyKey({ ctrlKey: true, altKey: true, key: 'z', code: 'KeyZ' })).toBeNull()
    expect(historyKey({ ctrlKey: true, shiftKey: true, key: 'y', code: 'KeyY' })).toBeNull()
  })
})
