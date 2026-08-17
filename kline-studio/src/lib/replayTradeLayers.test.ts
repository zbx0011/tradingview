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
      startTime: 1785709200,
      endTime: 1786136100,
      startedAt: 1786264147,
      finishedAt: null,
      tradeCount: 94,
      markerCount: 188,
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

  it('sorts replay layers by latest completion time first', () => {
    const base = { ...createDefaultReplayTradeLayer(), finishedAt: 100 }
    const older = { ...base, id: 'older', sourceId: 'older', finishedAt: 100, endTime: base.endTime - 3600, startTime: base.startTime - 3600 }
    const newer = { ...base, id: 'newer', sourceId: 'newer', finishedAt: 200, endTime: base.endTime - 7200, startTime: base.startTime - 7200 }
    expect(sortReplayTradeLayers([older, newer]).map((layer) => layer.id)).toEqual(['newer', 'older'])
  })

  it('persists visibility and only activates a matching visible layer', () => {
    const storage = new MemoryStorage()
    const hidden = { ...createDefaultReplayTradeLayer(), visible: false }
    saveReplayTradeLayers([hidden], storage)
    const restored = loadReplayTradeLayers(storage)
    expect(restored).toEqual([hidden])
    expect(hasVisibleReplayTradeLayer(restored, 'XAUUSD', '5m', hidden.sourceId)).toBe(false)
    expect(hasVisibleReplayTradeLayer([{ ...hidden, visible: true }], 'XAUUSD', '5m', hidden.sourceId)).toBe(true)
    expect(hasVisibleReplayTradeLayer([{ ...hidden, visible: true }], 'XAUUSD', '1m', hidden.sourceId)).toBe(false)
  })

  it('persists a renamed replay layer across reloads', () => {
    const storage = new MemoryStorage()
    const renamed = { ...createDefaultReplayTradeLayer(), name: '伦敦盘回放 01' }
    saveReplayTradeLayers([renamed], storage)
    expect(loadReplayTradeLayers(storage)[0].name).toBe('伦敦盘回放 01')
  })

  it('refreshes generated metric names after a dataset replacement', () => {
    const storage = new MemoryStorage()
    const current = createDefaultReplayTradeLayers().find((layer) => layer.sourceId === 'xauusd-5m-conservative-stop-first-ce496184a2c3638e')
    expect(current).toBeDefined()
    const metricPrefix = current!.name.replace(/\s*胜率.*$/, '')
    const stale = { ...current!, name: `${metricPrefix} 胜率60.98% 净盈亏+$1,062.72` }
    saveReplayTradeLayers([stale], storage)
    expect(loadReplayTradeLayers(storage)[0]).toMatchObject({
      name: current!.name,
      tradeCount: current!.tradeCount,
      markerCount: current!.markerCount,
    })
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
