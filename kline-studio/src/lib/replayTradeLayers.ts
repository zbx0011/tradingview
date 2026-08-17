import type { IntervalId, SymbolId } from './market'
import { replayTradeDatasetInfos, type ReplayTradeDatasetInfo } from './replayTradeRegistry'

export interface ReplayTradeLayer {
  id: string
  sourceId: string
  name: string
  symbol: SymbolId
  interval: IntervalId
  visible: boolean
  createdAt: number
  startTime: number
  endTime: number
  startedAt: number | null
  finishedAt: number | null
  tradeCount: number
  markerCount: number
}

interface ReplayTradeLayerStore {
  version: 2
  initialized: true
  seenSourceIds: string[]
  layers: ReplayTradeLayer[]
}

interface StorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export const REPLAY_TRADE_LAYERS_STORAGE_KEY = 'kline-studio-replay-trade-layers-v1'

export function sortReplayTradeLayers(layers: ReplayTradeLayer[]): ReplayTradeLayer[] {
  return layers.map((layer) => ({ ...layer, startedAt: layer.startedAt ?? null, finishedAt: layer.finishedAt ?? null })).sort((left, right) => {
    const rightFinishedAt = right.finishedAt ?? right.startedAt ?? right.startTime
    const leftFinishedAt = left.finishedAt ?? left.startedAt ?? left.startTime
    return rightFinishedAt - leftFinishedAt || right.endTime - left.endTime || right.startTime - left.startTime || right.createdAt - left.createdAt || left.name.localeCompare(right.name, 'zh-CN')
  })
}

function browserStorage(): StorageLike | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

function isReplayTradeLayer(value: unknown): value is ReplayTradeLayer {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ReplayTradeLayer>
  return typeof item.id === 'string' && item.id.length > 0
    && typeof item.sourceId === 'string' && item.sourceId.length > 0
    && typeof item.name === 'string' && item.name.length > 0
    && ['XAUUSD', 'XAGUSD', 'BTCUSDT.P', 'US500', 'ETHUSD'].includes(item.symbol ?? '')
    && ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w'].includes(item.interval ?? '')
    && typeof item.visible === 'boolean'
    && typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
    && typeof item.startTime === 'number' && Number.isFinite(item.startTime)
    && typeof item.endTime === 'number' && Number.isFinite(item.endTime) && item.endTime >= item.startTime
    && (item.startedAt === undefined || item.startedAt === null || typeof item.startedAt === 'number' && Number.isFinite(item.startedAt))
    && (item.finishedAt === undefined || item.finishedAt === null || typeof item.finishedAt === 'number' && Number.isFinite(item.finishedAt))
    && typeof item.tradeCount === 'number' && Number.isInteger(item.tradeCount) && item.tradeCount > 0
    && typeof item.markerCount === 'number' && Number.isInteger(item.markerCount) && item.markerCount >= item.tradeCount
}

export function createDefaultReplayTradeLayer(source: ReplayTradeDatasetInfo = replayTradeDatasetInfos()[0]): ReplayTradeLayer {
  return {
    id: `replay-layer-${source.sourceId}`,
    sourceId: source.sourceId,
    name: source.name,
    symbol: source.symbol,
    interval: source.interval,
    visible: true,
    createdAt: source.endTime * 1000,
    startTime: source.startTime,
    endTime: source.endTime,
    startedAt: source.startedAt,
    finishedAt: source.finishedAt,
    tradeCount: source.tradeCount,
    markerCount: source.markerCount,
  }
}

export function createDefaultReplayTradeLayers(): ReplayTradeLayer[] {
  return sortReplayTradeLayers(replayTradeDatasetInfos().map(createDefaultReplayTradeLayer))
}

export function parseReplayTradeLayerStore(raw: string | null): ReplayTradeLayerStore | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { version?: unknown; initialized?: unknown; seenSourceIds?: unknown; layers?: unknown }
    if (value.initialized !== true || !Array.isArray(value.layers)) return null
    const layers = value.layers.filter(isReplayTradeLayer).map((layer) => ({ ...layer, startedAt: layer.startedAt ?? null, finishedAt: layer.finishedAt ?? null }))
    if (value.version === 2 && Array.isArray(value.seenSourceIds)) {
      return { version: 2, initialized: true, seenSourceIds: value.seenSourceIds.filter((item): item is string => typeof item === 'string'), layers }
    }
    if (value.version === 1) {
      return { version: 2, initialized: true, seenSourceIds: ['xauusd-replay-a702a57a46cb7143', ...layers.map((layer) => layer.sourceId)], layers }
    }
    return null
  } catch {
    return null
  }
}

function writeStore(layers: ReplayTradeLayer[], seenSourceIds: string[], storage: StorageLike | undefined) {
  storage?.setItem(REPLAY_TRADE_LAYERS_STORAGE_KEY, JSON.stringify({ version: 2, initialized: true, seenSourceIds: [...new Set(seenSourceIds)], layers } satisfies ReplayTradeLayerStore))
}

function isGeneratedMetricName(name: string) {
  return /胜率\s*[0-9]+(?:\.[0-9]+)?%/.test(name) && /净盈亏\s*[+-]\$/.test(name)
}

export function loadReplayTradeLayers(storage: StorageLike | undefined = browserStorage()): ReplayTradeLayer[] {
  const available = replayTradeDatasetInfos()
  if (!storage) return sortReplayTradeLayers(available.map(createDefaultReplayTradeLayer))
  const raw = storage.getItem(REPLAY_TRADE_LAYERS_STORAGE_KEY)
  const stored = parseReplayTradeLayerStore(raw)
  if (stored) {
    const seen = new Set(stored.seenSourceIds)
    const additions = available.filter((source) => !seen.has(source.sourceId)).map(createDefaultReplayTradeLayer)
    const availableBySourceId = new Map(available.map((source) => [source.sourceId, source]))
    const storedLayers = stored.layers.map((layer) => {
      const source = availableBySourceId.get(layer.sourceId)
      if (!source) return { ...layer, finishedAt: layer.finishedAt ?? null }
      return {
        ...layer,
        name: isGeneratedMetricName(layer.name) && isGeneratedMetricName(source.name) ? source.name : layer.name,
        symbol: source.symbol,
        interval: source.interval,
        startTime: source.startTime,
        endTime: source.endTime,
        tradeCount: source.tradeCount,
        markerCount: source.markerCount,
        startedAt: source.startedAt ?? layer.startedAt ?? null,
        finishedAt: source.finishedAt ?? layer.finishedAt ?? null,
      }
    })
    const layers = sortReplayTradeLayers([...storedLayers, ...additions])
    for (const source of available) seen.add(source.sourceId)
    writeStore(layers, [...seen], storage)
    return layers
  }
  const layers = sortReplayTradeLayers(available.map(createDefaultReplayTradeLayer))
  writeStore(layers, available.map((source) => source.sourceId), storage)
  return layers
}

export function saveReplayTradeLayers(layers: ReplayTradeLayer[], storage: StorageLike | undefined = browserStorage()) {
  const sortedLayers = sortReplayTradeLayers(layers)
  writeStore(sortedLayers, [...replayTradeDatasetInfos().map((source) => source.sourceId), ...sortedLayers.map((layer) => layer.sourceId)], storage)
}

export function hasVisibleReplayTradeLayer(layers: ReplayTradeLayer[], symbol: SymbolId, interval: IntervalId, sourceId: string) {
  return layers.some((layer) => layer.sourceId === sourceId && layer.symbol === symbol && layer.interval === interval && layer.visible)
}
