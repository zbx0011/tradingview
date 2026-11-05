import { afterEach, expect, it, vi } from 'vitest'
import { loadPageValue, savePageValue } from './pageState'

afterEach(() => vi.unstubAllGlobals())

it('restores replay state, drawing sets and open panels without changing values', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  savePageValue('manualReplayEnd', 1744642800)
  savePageValue('manualReplayDrawingIds', new Set(['line1', 'rect2']))
  savePageValue('settingsOpen', true)
  expect(loadPageValue<number | null>('manualReplayEnd', null)).toBe(1744642800)
  expect(loadPageValue<Set<string> | null>('manualReplayDrawingIds', null)).toEqual(new Set(['line1', 'rect2']))
  expect(loadPageValue('settingsOpen', false)).toBe(true)
  expect(loadPageValue('otherPanel', false)).toBe(false)
})

it('keeps defaults when stored UI state is corrupt, incompatible or unavailable', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{broken' })
  expect(loadPageValue('settingsOpen', false)).toBe(false)
  vi.stubGlobal('localStorage', { getItem: () => '"not a boolean"' })
  expect(loadPageValue('settingsOpen', false)).toBe(false)
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('full') } })
  expect(loadPageValue('settingsOpen', false)).toBe(false)
  expect(() => savePageValue('settingsOpen', true)).not.toThrow()
})
