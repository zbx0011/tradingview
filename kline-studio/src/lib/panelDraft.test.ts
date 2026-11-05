import { afterEach, expect, it, vi } from 'vitest'
import { clearPanelState, loadPanelState, savePanelState } from './panelDraft'

afterEach(() => vi.unstubAllGlobals())
const valid = (value: unknown): value is { rows: string[] } => Boolean(value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows))

it('keeps separate transaction drafts across page reload and clears only the saved/cancelled one', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { setItem: (key: string, value: string) => values.set(key, value), getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => values.delete(key) })
  savePanelState('session1:trade1', { rows: ['趋势线', '回测'] })
  savePanelState('session2:trade1', { rows: ['突破'] })
  expect(loadPanelState('session1:trade1', { rows: [] }, valid)).toEqual({ rows: ['趋势线', '回测'] })
  clearPanelState('session1:trade1')
  expect(loadPanelState('session1:trade1', { rows: [] }, valid)).toEqual({ rows: [] })
  expect(loadPanelState('session2:trade1', { rows: [] }, valid)).toEqual({ rows: ['突破'] })
})

it('falls back safely when local storage is corrupt or unavailable', () => {
  vi.stubGlobal('localStorage', { getItem: () => '{broken' })
  expect(loadPanelState('draft', { rows: [] }, valid)).toEqual({ rows: [] })
  vi.stubGlobal('localStorage', { getItem: () => { throw Error('blocked') }, setItem: () => { throw Error('quota') } })
  expect(loadPanelState('draft', { rows: [] }, valid)).toEqual({ rows: [] })
  expect(() => savePanelState('draft', {})).not.toThrow()
})
