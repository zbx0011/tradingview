import { describe, expect, it } from 'vitest'
import {
  REPLAY_TRADE_LAYERS_STORAGE_KEY, createDefaultReplayTradeLayer, createDefaultReplayTradeLayers, hasVisibleReplayTradeLayer,
  loadReplayTradeLayers, parseReplayTradeLayerStore, saveReplayTradeLayers, sortReplayTradeLayers,
} from './replayTradeLayers'

class MemoryStorage {
  private values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe('replay trade layers', () => {
  it('describes the imported XAUUSD replay as one stable simulated-order layer', () => {
    expect(createDefaultReplayTradeLayer()).toMatchObject({
      id: 'replay-layer-xauusd-replay-a702a57a46cb7143',
      sourceId: 'xauusd-replay-a702a57a46cb7143',
      name: 'XAUUSD 回放交易',
      symbol: 'XAUUSD',
      interval: '5m',
      visible: true,
      startTime: 1785712800,
      endTime: 1786133100,
      startedAt: 1786264147,
      finishedAt: null,
      tradeCount: 87,
      markerCount: 174,
    })
  })

  it('seeds all known replays once and preserves an intentional deletion', () => {
    const storage = new MemoryStorage()
    const expected = createDefaultReplayTradeLayers()
    const seeded = loadReplayTradeLayers(storage)
    expect(seeded).toHaveLength(expected.length)
    expect(seeded.map((layer) => layer.sourceId)).toEqual(expected.map((layer) => layer.sourceId))
    expect(storage.getItem(REPLAY_TRADE_LAYERS_STORAGE_KEY)).toContain('XAUUSD 回放交易')

    saveReplayTradeLayers([], storage)
    expect(loadReplayTradeLayers(storage)).toEqual([])
  })

  it('keeps the next-bar-confirmed version when an older named window is also present', () => {
    const layers = createDefaultReplayTradeLayers()
    const pairedSourceIds = new Set([
      'xagusd-5m-conservative-stop-first-cb952aecedad0c23',
      'xagusd-5m-conservative-stop-first-cf1f9665945cf63c',
      'xagusd-5m-conservative-stop-first-e0d1a1cb0690b52c',
    ])
    const pairedLayers = layers.filter((layer) => pairedSourceIds.has(layer.sourceId))

    expect(pairedLayers).toHaveLength(1)
    expect(pairedLayers[0].sourceId).toBe('xagusd-5m-conservative-stop-first-e0d1a1cb0690b52c')
    expect(pairedLayers[0].name).toBe('XAGUSD 5m V5 2026-08-10~2026-08-15')
  })

  it('sorts replay layers by latest completion time first', () => {
    const base = { ...createDefaultReplayTradeLayer(), finishedAt: 100 }
    const older = { ...base, id: 'older', sourceId: 'older', finishedAt: 100, endTime: base.endTime - 3600, startTime: base.startTime - 3600 }
    const newer = { ...base, id: 'newer', sourceId: 'newer', finishedAt: 200, endTime: base.endTime - 7200, startTime: base.startTime - 7200 }
    expect(sortReplayTradeLayers([older, newer]).map((layer) => layer.id)).toEqual(['newer', 'older'])
  })

  it('persists visibility and only activates a matching visible layer', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    const hidden = { ...current!, visible: false }
    saveReplayTradeLayers([hidden], storage)
    const restored = loadReplayTradeLayers(storage)
    expect(restored).toEqual([hidden])
    expect(hasVisibleReplayTradeLayer(restored, 'XAUUSD', '5m', hidden.sourceId)).toBe(false)
    expect(hasVisibleReplayTradeLayer([{ ...hidden, visible: true }], 'XAUUSD', '5m', hidden.sourceId)).toBe(true)
    expect(hasVisibleReplayTradeLayer([{ ...hidden, visible: true }], 'XAUUSD', '1m', hidden.sourceId)).toBe(false)
  })

  it('persists a renamed replay layer across reloads', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    const renamed = { ...current!, name: '伦敦盘回放 01' }
    saveReplayTradeLayers([renamed], storage)
    expect(loadReplayTradeLayers(storage)[0].name).toBe('伦敦盘回放 01')
  })

  it('preserves the latest layer display name across reloads', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    const renamed = { ...current!, name: 'XAUUSD 5m V5 2026-08-03~2026-08-08' }
    saveReplayTradeLayers([renamed], storage)
    expect(loadReplayTradeLayers(storage)[0]).toMatchObject({
      name: renamed.name,
      tradeCount: current!.tradeCount,
      markerCount: current!.markerCount,
    })
  })

  it('removes the superseded XAUUSD 5m layer from an existing store', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    storage.setItem(REPLAY_TRADE_LAYERS_STORAGE_KEY, JSON.stringify({
      version: 2,
      initialized: true,
      seenSourceIds: ['xauusd-5m-conservative-stop-first-ee9da04efccd7ed5', current!.sourceId],
      layers: [current],
    }))

    const loaded = loadReplayTradeLayers(storage)

    expect(loaded.map((layer) => layer.sourceId)).not.toContain('xauusd-5m-conservative-stop-first-ee9da04efccd7ed5')
    expect(loaded.map((layer) => layer.sourceId)).toContain(current!.sourceId)
  })

  it('removes V4 layers from an existing store once', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    storage.setItem(REPLAY_TRADE_LAYERS_STORAGE_KEY, JSON.stringify({
      version: 2,
      initialized: true,
      seenSourceIds: ['xauusd-5m-conservative-stop-first-7434d1dc4125d1a7', current!.sourceId],
      layers: [{
        ...current!,
        id: 'replay-layer-xauusd-5m-conservative-stop-first-7434d1dc4125d1a7',
        sourceId: 'xauusd-5m-conservative-stop-first-7434d1dc4125d1a7',
        name: 'XAUUSD 5m V4 2026-08-03~2026-08-08',
      }, current],
    }))

    const loaded = loadReplayTradeLayers(storage)

    expect(loaded.map((layer) => layer.sourceId)).not.toContain('xauusd-5m-conservative-stop-first-7434d1dc4125d1a7')
    expect(loaded.map((layer) => layer.sourceId)).toContain(current!.sourceId)
  })

  it('removes obsolete duplicate versions and keeps the corrected layer', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-df68c64a47f5f569')
    expect(current).toBeDefined()
    storage.setItem(REPLAY_TRADE_LAYERS_STORAGE_KEY, JSON.stringify({
      version: 2,
      initialized: true,
      seenSourceIds: ['xauusd-5m-conservative-stop-first-ee9da04efccd7ed5', current!.sourceId],
      layers: [
        { ...current!, id: 'replay-layer-xauusd-5m-conservative-stop-first-ee9da04efccd7ed5', sourceId: 'xauusd-5m-conservative-stop-first-ee9da04efccd7ed5', name: 'XAUUSD 5m V5 old' },
        current,
      ],
    }))

    const loaded = loadReplayTradeLayers(storage)

    expect(loaded.map((layer) => layer.sourceId)).not.toContain('xauusd-5m-conservative-stop-first-ee9da04efccd7ed5')
    expect(loaded.map((layer) => layer.sourceId)).toContain(current!.sourceId)
  })

  it('rejects malformed stores and drops malformed layer entries', () => {
    expect(parseReplayTradeLayerStore('{bad json')).toBeNull()
    expect(parseReplayTradeLayerStore(JSON.stringify({ version: 2, initialized: true, layers: [] }))).toBeNull()
    expect(parseReplayTradeLayerStore(JSON.stringify({
      version: 1,
      initialized: true,
      layers: [createDefaultReplayTradeLayer(), { id: 'broken' }],
    }))?.layers).toHaveLength(1)
  })
})
