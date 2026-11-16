import { describe, expect, it } from 'vitest'
import { DEFAULT_THREE_PUSH_SETTINGS, normalizeThreePushSettings, setAllThreePushTimeframes, toggleThreePushTimeframe, visibleThreePushTimeframes } from './threePushSettings'

describe('three-push display controls', () => {
  it('opens all levels and merges identical shapes for legacy settings', () => {
    expect(normalizeThreePushSettings({})).toEqual(DEFAULT_THREE_PUSH_SETTINGS)
    expect(visibleThreePushTimeframes({})).toEqual(['1m', '5m', '15m'])
  })

  it('toggles individual levels without changing the others or overlap preference', () => {
    const settings = toggleThreePushTimeframe({ threePushMergeOverlaps: false }, '5m')
    expect(visibleThreePushTimeframes(settings)).toEqual(['1m', '15m'])
    expect(settings.threePushMergeOverlaps).toBe(false)
    expect(visibleThreePushTimeframes(toggleThreePushTimeframe(settings, '5m'))).toEqual(['1m', '5m', '15m'])
  })

  it('turns on only the clicked level when the master is off', () => {
    const settings = toggleThreePushTimeframe({ threePush: false }, '5m')
    expect(visibleThreePushTimeframes(settings)).toEqual(['5m'])
    expect(toggleThreePushTimeframe(settings, '5m').threePush).toBe(false)
  })

  it('makes the master show or hide every level, preserving unrelated settings', () => {
    const partial = toggleThreePushTimeframe({ ema: true, threePushMergeOverlaps: false }, '1m')
    const hidden = setAllThreePushTimeframes(partial, false)
    expect(visibleThreePushTimeframes(hidden)).toEqual([])
    const shown = setAllThreePushTimeframes(hidden, true)
    expect(visibleThreePushTimeframes(shown)).toEqual(['1m', '5m', '15m'])
    expect(shown).toMatchObject({ ema: true, threePushMergeOverlaps: false })
  })
})
