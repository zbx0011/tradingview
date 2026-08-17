import type { IntervalId, SymbolId } from './market'
import { replayRangeDatasetInfos, type ReplayRangeDatasetInfo } from './replayRangeRegistry'

export interface ReplayRangeLayer {
  id: string
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  visible: boolean
  createdAt: number
  startTime: number
  endTime: number
  rangeCount: number
  twoSidedCount: number
  oneSidedCount: number
  hiddenRangeIds: string[]
  deletedRangeIds: string[]
}

interface ReplayRangeLayerStore {
  version: 1
  initialized: true
  seenSourceIds: string[]
  layers: ReplayRangeLayer[]
}

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const REPLAY_RANGE_LAYERS_STORAGE_KEY = 'kline-studio-replay-range-layers-v1'

function browserStorage(): StorageLike | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

function isLayer(value: unknown): value is ReplayRangeLayer {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ReplayRangeLayer>
  return typeof item.id === 'string' && typeof item.sourceId === 'string' && typeof item.name === 'string'
    && typeof item.visible === 'boolean' && typeof item.createdAt === 'number'
    && typeof item.startTime === 'number' && typeof item.endTime === 'number' && item.endTime >= item.startTime
    && typeof item.rangeCount === 'number' && Number.isInteger(item.rangeCount) && item.rangeCount >= 0
    && typeof item.twoSidedCount === 'number' && typeof item.oneSidedCount === 'number'
    && item.twoSidedCount + item.oneSidedCount === item.rangeCount
    && (item.hiddenRangeIds === undefined || (Array.isArray(item.hiddenRangeIds) && item.hiddenRangeIds.every((id) => typeof id === 'string')))
    && (item.deletedRangeIds === undefined || (Array.isArray(item.deletedRangeIds) && item.deletedRangeIds.every((id) => typeof id === 'string')))
    && ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD'].includes(item.symbol ?? '')
    && ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'].includes(item.interval ?? '')
}

function normalizeLayer(layer: ReplayRangeLayer): ReplayRangeLayer {
  return {
    ...layer,
    hiddenRangeIds: [...new Set(layer.hiddenRangeIds ?? [])],
    deletedRangeIds: [...new Set(layer.deletedRangeIds ?? [])],
  }
}

export function createDefaultReplayRangeLayer(source: ReplayRangeDatasetInfo): ReplayRangeLayer {
  return {
    id: `replay-range-layer-${source.sourceId}`,
    sourceId: source.sourceId,
    name: source.name,
    symbol: source.symbol,
    interval: source.interval,
    visible: true,
    createdAt: source.endTime * 1000,
    startTime: source.startTime,
    endTime: source.endTime,
    rangeCount: source.rangeCount,
    twoSidedCount: source.twoSidedCount,
    oneSidedCount: source.oneSidedCount,
    hiddenRangeIds: [],
    deletedRangeIds: [],
  }
}

function parseStore(raw: string | null): ReplayRangeLayerStore | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ReplayRangeLayerStore>
    if (value.version !== 1 || value.initialized !== true || !Array.isArray(value.seenSourceIds) || !Array.isArray(value.layers)) return null
    return { version: 1, initialized: true, seenSourceIds: value.seenSourceIds.filter((item): item is string => typeof item === 'string'), layers: value.layers.filter(isLayer).map(normalizeLayer) }
  } catch {
    return null
  }
}

function writeStore(layers: ReplayRangeLayer[], seenSourceIds: string[], storage: StorageLike | undefined) {
  storage?.setItem(REPLAY_RANGE_LAYERS_STORAGE_KEY, JSON.stringify({ version: 1, initialized: true, seenSourceIds: [...new Set(seenSourceIds)], layers } satisfies ReplayRangeLayerStore))
}

export function loadReplayRangeLayers(storage: StorageLike | undefined = browserStorage()): ReplayRangeLayer[] {
  const available = replayRangeDatasetInfos()
  if (!storage) return available.map(createDefaultReplayRangeLayer)
  const stored = parseStore(storage.getItem(REPLAY_RANGE_LAYERS_STORAGE_KEY))
  if (!stored) {
    const layers = available.map(createDefaultReplayRangeLayer)
    writeStore(layers, available.map((item) => item.sourceId), storage)
    return layers
  }
  const seen = new Set(stored.seenSourceIds)
  const additions = available.filter((source) => !seen.has(source.sourceId)).map(createDefaultReplayRangeLayer)
  const layers = [...stored.layers, ...additions]
  writeStore(layers, [...seen, ...available.map((item) => item.sourceId)], storage)
  return layers
}

export function saveReplayRangeLayers(layers: ReplayRangeLayer[], storage: StorageLike | undefined = browserStorage()) {
  writeStore(layers, [...replayRangeDatasetInfos().map((item) => item.sourceId), ...layers.map((item) => item.sourceId)], storage)
}

export function toggleReplayRangeObjectInLayers(layers: ReplayRangeLayer[], layerId: string, objectId: string): ReplayRangeLayer[] {
  return layers.map((layer) => {
    if (layer.id !== layerId || layer.deletedRangeIds.includes(objectId)) return layer
    const hidden = layer.hiddenRangeIds.includes(objectId)
    return { ...layer, hiddenRangeIds: hidden ? layer.hiddenRangeIds.filter((id) => id !== objectId) : [...layer.hiddenRangeIds, objectId] }
  })
}

export function deleteReplayRangeObjectFromLayers(layers: ReplayRangeLayer[], objectId: string): ReplayRangeLayer[] {
  return layers.map((layer) => {
    if (!objectId.startsWith(`replay-range-${layer.sourceId}-`) || layer.deletedRangeIds.includes(objectId)) return layer
    return {
      ...layer,
      hiddenRangeIds: layer.hiddenRangeIds.filter((id) => id !== objectId),
      deletedRangeIds: [...layer.deletedRangeIds, objectId],
    }
  })
}
