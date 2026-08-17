import { describe, expect, it } from 'vitest'
import { shouldRenderReplayRangeSpec, validateReplayRangePayload } from './replayRangeRegistry'
import {
  REPLAY_RANGE_LAYERS_STORAGE_KEY, createDefaultReplayRangeLayer, deleteReplayRangeObjectFromLayers,
  loadReplayRangeLayers, saveReplayRangeLayers, toggleReplayRangeObjectInLayers,
} from './replayRangeLayers'

const SHA = 'a'.repeat(64)

function payload() {
  return {
    schemaVersion: 1,
    symbol: 'XAUUSD',
    interval: '5m',
    timeframeSeconds: 300,
    layer: { sourceId: 'xauusd-5m-custom-v2-ranges-test', name: 'XAUUSD 自定义V2震荡区间' },
    provenance: {
      recognizedRangesFile: 'recognized_ranges.json', recognizedRangesSha256: SHA,
      sourceDecisionsSha256: SHA, sourceDataSha256: SHA,
      ruleSetId: 'tvfloat_user_custom_v2_range30_unanchored_pullback_20260810', ruleSetSha256: SHA,
      generatedBy: 'scripts/import-replay-ranges.mjs',
    },
    window: { startTime: 1_000, endTime: 20_000 },
    summary: { ranges: 2, twoSided: 1, oneSided: 1 },
    ranges: [
      {
        rangeId: 'range-full', kind: 'two_sided_range', startIdx: 0, formationEndIdx: 35,
        firstDetectedIdx: 30, lastObservedIdx: 40, startTime: 1_000, formationEndTime: 12_000,
        firstDetectedTime: 10_000, lastObservedTime: 13_000, displayEndTime: 12_000,
        status: 'broken', brokenAtTime: 13_000,
        upperZoneLow: 110, upperZoneHigh: 111, lowerZoneLow: 99, lowerZoneHigh: 100, midpoint: 105,
        upperTouchIndices: [0, 15, 35], lowerTouchIndices: [5, 29, 36],
      },
      {
        rangeId: 'range-lower-only', kind: 'one_sided_edge', activeEdge: 'lower',
        startIdx: 2, formationEndIdx: 35, firstDetectedIdx: 35, lastObservedIdx: 40,
        startTime: 2_000, formationEndTime: 12_000, firstDetectedTime: 12_300,
        lastObservedTime: 13_000, displayEndTime: 20_000, status: 'active', brokenAtTime: null,
        edgeZoneLow: 106.8, edgeZoneHigh: 107.2, touchIndices: [2, 20, 35],
      },
    ],
  }
}

describe('replay range layers', () => {
  it('accepts full and one-sided lifecycles without inventing the missing edge', () => {
    const dataset = validateReplayRangePayload(payload())
    expect(dataset.rangeCount).toBe(2)
    expect(dataset.twoSidedCount).toBe(1)
    expect(dataset.oneSidedCount).toBe(1)
    expect(dataset.ranges[1]).toMatchObject({ kind: 'one_sided_edge', activeEdge: 'lower' })
    expect(dataset.ranges[1]).not.toHaveProperty('upperZoneLow')
  })

  it('accepts a touch-bounded drawing end before the later logical break', () => {
    const value = payload()
    value.ranges = [value.ranges[0]]
    value.summary = { ranges: 1, twoSided: 1, oneSided: 0 }
    const dataset = validateReplayRangePayload(value)
    expect(dataset.ranges[0]).toMatchObject({ displayEndTime: 12_000, brokenAtTime: 13_000 })
  })

  it('preserves validated frozen-OHLC user-confirmed supplement provenance', () => {
    const value = payload()
    const supplementedRange = {
      ...value.ranges[1],
      userConfirmedDisplaySupplement: true,
      evidenceSource: 'frozen_ohlc_user_confirmation',
      supplementReason: 'user_confirmed_long_horizon_upper_edge_20260811',
    }
    value.ranges[1] = supplementedRange
    const summary = value.summary as typeof value.summary & { userConfirmedSupplements?: number }
    summary.userConfirmedSupplements = 1
    const dataset = validateReplayRangePayload(value)
    expect(dataset.ranges[1]).toMatchObject({
      userConfirmedDisplaySupplement: true,
      evidenceSource: 'frozen_ohlc_user_confirmation',
    })
  })

  it('keeps two-sided lifecycles for audit but renders only one-sided edges', () => {
    const dataset = validateReplayRangePayload(payload())
    expect(dataset.ranges.filter(shouldRenderReplayRangeSpec)).toEqual([
      expect.objectContaining({ kind: 'one_sided_edge', activeEdge: 'lower' }),
    ])
    expect(shouldRenderReplayRangeSpec({ kind: 'two_sided_range' })).toBe(false)
    expect(shouldRenderReplayRangeSpec({ upperZoneLow: 100, upperZoneHigh: 101 })).toBe(false)
  })

  it('rejects a one-sided edge with fewer than three touches', () => {
    const value = payload()
    value.ranges[1].touchIndices = [4, 35]
    expect(() => validateReplayRangePayload(value)).toThrow(/单边回放区间无效/)
  })

  it('persists visibility and deletion independently from simulated-order layers', () => {
    const dataset = validateReplayRangePayload(payload())
    const storage = new Map<string, string>()
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }
    const layer = createDefaultReplayRangeLayer(dataset)
    const customized = { ...layer, visible: false, hiddenRangeIds: ['range-a'], deletedRangeIds: ['range-b'] }
    saveReplayRangeLayers([customized], adapter)
    expect(loadReplayRangeLayers(adapter)).toEqual([customized])
  })

  it('migrates older stored layers to per-range visibility state', () => {
    const dataset = validateReplayRangePayload(payload())
    const layer = createDefaultReplayRangeLayer(dataset)
    const legacyLayer = { ...layer } as Record<string, unknown>
    delete legacyLayer.hiddenRangeIds
    delete legacyLayer.deletedRangeIds
    const storage = new Map<string, string>([[REPLAY_RANGE_LAYERS_STORAGE_KEY, JSON.stringify({
      version: 1, initialized: true, seenSourceIds: [layer.sourceId], layers: [legacyLayer],
    })]])
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    }
    expect(loadReplayRangeLayers(adapter)[0]).toMatchObject({ hiddenRangeIds: [], deletedRangeIds: [] })
  })

  it('hides, restores, and deletes one range without changing the rest of its layer', () => {
    const layer = createDefaultReplayRangeLayer(validateReplayRangePayload(payload()))
    const objectId = `replay-range-${layer.sourceId}-range-full`
    const hidden = toggleReplayRangeObjectInLayers([layer], layer.id, objectId)
    expect(hidden[0]).toMatchObject({ hiddenRangeIds: [objectId], deletedRangeIds: [] })
    expect(toggleReplayRangeObjectInLayers(hidden, layer.id, objectId)[0].hiddenRangeIds).toEqual([])
    const deleted = deleteReplayRangeObjectFromLayers(hidden, objectId)
    expect(deleted[0]).toMatchObject({ hiddenRangeIds: [], deletedRangeIds: [objectId] })
  })
})
