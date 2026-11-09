import { describe, expect, it } from 'vitest'
import {
  PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY,
  collectPortableWorkspace,
  loadPortableWorkspaceRecovery,
  parsePortableWorkspace,
  restorePortableWorkspace,
  restorePortableWorkspaceRecovery,
  restorePortableWorkspaceSafely,
  serializePortableWorkspace,
} from './portableWorkspace'

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

describe('portable workspace', () => {
  it('exports only app-owned local state and round-trips valid JSON', () => {
    const storage = createStorage({ 'kline-studio-workspace-v1': '{"symbol":"XAUUSD"}', unrelated: 'keep' })
    const snapshot = collectPortableWorkspace(storage)
    expect(snapshot.entries).toEqual({ 'kline-studio-workspace-v1': '{"symbol":"XAUUSD"}' })
    expect(parsePortableWorkspace(serializePortableWorkspace(snapshot))).toEqual(snapshot)
  })

  it('rejects malformed or foreign snapshots', () => {
    expect(parsePortableWorkspace('{"app":"other","version":1,"entries":{}}')).toBeNull()
    expect(parsePortableWorkspace('{"app":"kline-studio","version":1,"entries":{"other":"x"}}')).toBeNull()
    expect(parsePortableWorkspace('not-json')).toBeNull()
  })

  it('replaces old app-owned keys but preserves unrelated storage', () => {
    const storage = createStorage({
      'kline-studio-old': 'remove',
      'kline-studio-keep': 'old',
      unrelated: 'keep',
    })
    const snapshot = parsePortableWorkspace(JSON.stringify({
      app: 'kline-studio', version: 1, exportedAt: '2026-01-01T00:00:00.000Z',
      entries: { 'kline-studio-keep': 'new', 'kline-studio-added': 'yes' },
    }))!
    expect(restorePortableWorkspace(snapshot, storage)).toBe(2)
    expect(Object.fromEntries(storage.values)).toEqual({
      'kline-studio-keep': 'new',
      'kline-studio-added': 'yes',
      unrelated: 'keep',
    })
  })

  it('keeps window layout on each computer instead of syncing it', () => {
    const layout = {
      'kline-studio-manual-card-v1:timeline': '{"left":0,"top":0,"width":900,"height":1200}',
      'kline-studio-floating-card-order-v1': '["timeline"]',
      'kline-studio-trade-marker-panel-v1': '{"position":null,"size":null,"fontSize":"large"}',
      'kline-studio-quick-drawing-toolbar-position-v1': '{"x":1,"y":2}',
      'kline-studio-chart-view-v1:NQ1!:5m': '{"from":1,"to":2}',
      'kline-studio-page-state-v1:card-scroll:timeline:x': '120',
    }
    const storage = createStorage({ 'kline-studio-workspace-v1': 'local', ...layout })
    expect(collectPortableWorkspace(storage).entries).toEqual({ 'kline-studio-workspace-v1': 'local' })

    // A backup from another computer (or an older version) may still carry layout: it is ignored on import.
    const imported = parsePortableWorkspace(JSON.stringify({
      app: 'kline-studio', version: 1, exportedAt: '2026-11-09T00:00:00.000Z',
      entries: { 'kline-studio-workspace-v1': 'remote', 'kline-studio-manual-card-v1:timeline': '{"left":9,"top":9,"width":999,"height":999}' },
    }))!
    expect(Object.keys(imported.entries)).toEqual(['kline-studio-workspace-v1'])
    restorePortableWorkspace(imported, storage)
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('remote')
    for (const [key, value] of Object.entries(layout)) expect(storage.getItem(key)).toBe(value)
  })

  it('keeps internal recovery data out of exported backups', () => {
    const storage = createStorage({
      'kline-studio-workspace-v1': 'current',
      [PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY]: 'internal rollback data',
    })
    expect(collectPortableWorkspace(storage).entries).toEqual({ 'kline-studio-workspace-v1': 'current' })
  })

  it('creates a reversible rollback point before a full restore', () => {
    const storage = createStorage({ 'kline-studio-workspace-v1': 'local', unrelated: 'keep' })
    const imported = parsePortableWorkspace(JSON.stringify({
      app: 'kline-studio', version: 1, exportedAt: '2026-08-20T00:00:00.000Z',
      entries: { 'kline-studio-workspace-v1': 'imported' },
    }))!

    expect(restorePortableWorkspaceSafely(imported, storage)).toBe(1)
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('imported')
    expect(loadPortableWorkspaceRecovery(storage)?.entries['kline-studio-workspace-v1']).toBe('local')

    expect(restorePortableWorkspaceRecovery(storage)).toBe(1)
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('local')
    expect(loadPortableWorkspaceRecovery(storage)?.entries['kline-studio-workspace-v1']).toBe('imported')
    expect(storage.getItem('unrelated')).toBe('keep')
  })
})
