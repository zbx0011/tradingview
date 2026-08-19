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

// The newer replay exports use this suffix while the older export keeps the
// same symbol/interval/window name. They are two versions of the same object
// tree entry, not two independent replay windows.
const NEXT_BAR_CONFIRMATION_SUFFIX = ' · 反向下一根确认'

const RESTORE_XAUUSD_5M_LAYERS_MIGRATION_KEY = 'kline-studio-replay-trade-layers-restore-xauusd-5m-20260817'
const RESTORED_XAUUSD_5M_SOURCE_IDS = new Set([
  'xauusd-5m-conservative-stop-first-1a6a266771110a76',
  'xauusd-5m-conservative-stop-first-219378633980b82f',
  'xauusd-5m-conservative-stop-first-32b43a5403115e22',
  'xauusd-5m-conservative-stop-first-37a56a318a8b85b8',
  'xauusd-5m-conservative-stop-first-4c81a697bde008fe',
  'xauusd-5m-conservative-stop-first-522aa107b96fc147',
  'xauusd-5m-conservative-stop-first-573355177afe78b8',
  'xauusd-5m-conservative-stop-first-7ac796132eaa1a3d',
  'xauusd-5m-conservative-stop-first-8ca12ce88f31fd78',
  'xauusd-5m-conservative-stop-first-9a82af5403413c11',
  'xauusd-5m-conservative-stop-first-a0f3c2f8ba5ed224',
  'xauusd-5m-conservative-stop-first-a5b26fda13f28c38',
  'xauusd-5m-conservative-stop-first-a713791f7675c266',
  'xauusd-5m-conservative-stop-first-7434d1dc4125d1a7',
  'xauusd-5m-conservative-stop-first-ce496184a2c3638e',
  'xauusd-5m-conservative-stop-first-ee9da04efccd7ed5',
  'xauusd-5m-conservative-stop-first-f0e781e76baf7c53',
])
const REMOVE_ALL_V4_MIGRATION_KEY = 'kline-studio-replay-trade-layers-remove-all-v4-20260817'
const REMOVED_V4_SOURCE_IDS = new Set([
  'btcusdt-p-15m-conservative-stop-first-d0029026442a22d0',
  'btcusdt-p-15m-conservative-stop-first-ddcb51502ae39511',
  'btcusdt-p-5m-conservative-stop-first-00f45363c208592c',
  'btcusdt-p-5m-conservative-stop-first-ad79760ed74357bb',
  'btcusdt-p-5m-conservative-stop-first-bd032fdb2cadd637',
  'btcusdt-p-5m-conservative-stop-first-cf5baef2c5af20aa',
  'us500-15m-conservative-stop-first-06455a37a8fd2688',
  'us500-15m-conservative-stop-first-2e816623ff7d1061',
  'us500-15m-conservative-stop-first-3cc45291d4f07b06',
  'us500-15m-conservative-stop-first-5e22c8b44cd58a22',
  'us500-5m-conservative-stop-first-09f83904feb38779',
  'us500-5m-conservative-stop-first-1ab94efdf42765a9',
  'us500-5m-conservative-stop-first-a7c68658d76d1f6d',
  'us500-5m-conservative-stop-first-e68f2fad3773de17',
  'xagusd-15m-conservative-stop-first-02d78841623d98de',
  'xagusd-15m-conservative-stop-first-1768116115898c12',
  'xagusd-15m-conservative-stop-first-34279994ca194f11',
  'xagusd-15m-conservative-stop-first-9dabbfed402b86f7',
  'xagusd-15m-conservative-stop-first-a920665825be55fa',
  'xagusd-15m-conservative-stop-first-da04f9c692eb7d2f',
  'xagusd-5m-conservative-stop-first-1c07b1c370440118',
  'xagusd-5m-conservative-stop-first-247d829e7f58cbc8',
  'xagusd-5m-conservative-stop-first-5f1718d7828a77a2',
  'xagusd-5m-conservative-stop-first-5f6ad124c38da874',
  'xagusd-5m-conservative-stop-first-7729c9898356e672',
  'xagusd-5m-conservative-stop-first-a2451e37b84a7f01',
  'xagusd-5m-conservative-stop-first-b459729f9bec9675',
  'xagusd-5m-conservative-stop-first-e365502585de1315',
  'xagusd-5m-conservative-stop-first-ef64fc77ec8b65c6',
  'xagusd-5m-conservative-stop-first-f7aa8c4ff7df47db',
  'xauusd-15m-conservative-stop-first-0841b403bcba03c3',
  'xauusd-15m-conservative-stop-first-0d015f59fba86b8d',
  'xauusd-15m-conservative-stop-first-3ad7dc6de4e1b19e',
  'xauusd-15m-conservative-stop-first-435f1fe4296903c3',
  'xauusd-15m-conservative-stop-first-50ceb2b2201522da',
  'xauusd-15m-conservative-stop-first-d225976bab0fe74b',
  'xauusd-5m-conservative-stop-first-219378633980b82f',
  'xauusd-5m-conservative-stop-first-37a56a318a8b85b8',
  'xauusd-5m-conservative-stop-first-522aa107b96fc147',
  'xauusd-5m-conservative-stop-first-7434d1dc4125d1a7',
  'xauusd-5m-conservative-stop-first-9a82af5403413c11',
  'xauusd-5m-conservative-stop-first-a0f3c2f8ba5ed224',
  'xauusd-5m-conservative-stop-first-a5b26fda13f28c38',
  'xauusd-5m-conservative-stop-first-a713791f7675c266',
  'xauusd-5m-conservative-stop-first-f0e781e76baf7c53',
])
const REMOVED_OBSOLETE_REPLAY_SOURCE_IDS = new Set([
  // Superseded V5 layers replaced by the 2026-08-17 higher-high/lower-low
  // trailing-stop recalculation. Keep the files recoverable in the retired
  // archive, but remove their persisted object-tree entries on reload.
  'xauusd-replay-a702a57a46cb7143',
  'btcusdt-p-15m-conservative-stop-first-63ad06256c371ae6',
  'btcusdt-p-5m-conservative-stop-first-a74161d38e125fce',
  'btcusdt-p-5m-conservative-stop-first-631b16a149a4a1ba',
  'us500-15m-conservative-stop-first-63787e2c0fc38b36',
  'us500-15m-conservative-stop-first-0a9a733a1bcabb2b',
  'us500-5m-conservative-stop-first-7a0cb50f9024e8aa',
  'us500-5m-conservative-stop-first-451b06d33182c7c9',
  'xagusd-15m-conservative-stop-first-3eda2a59b0758cf4',
  'xagusd-15m-conservative-stop-first-ac8678234418e797',
  'xagusd-15m-conservative-stop-first-7f05fe04b9b24539',
  'xagusd-5m-conservative-stop-first-10a474b786c9843c',
  'xagusd-5m-conservative-stop-first-b4d8e666936e6911',
  'xagusd-5m-conservative-stop-first-3d322de62af746e3',
  'xagusd-5m-conservative-stop-first-62503b3b370d8bfb',
  'xauusd-15m-conservative-stop-first-374b1eeb0731d789',
  'xauusd-15m-conservative-stop-first-d6ba275826b3ed1a',
  'xauusd-15m-conservative-stop-first-b308664098183310',
  'xauusd-5m-conservative-stop-first-573355177afe78b8',
  'xauusd-5m-conservative-stop-first-ee9da04efccd7ed5',
  'xauusd-5m-conservative-stop-first-4c81a697bde008fe',
  'xauusd-5m-conservative-stop-first-32b43a5403115e22',
  'btcusdt-p-15m-conservative-stop-first-9a85efa4824034f1',
  'btcusdt-p-5m-conservative-stop-first-82d67b67cffef49b',
  'btcusdt-p-5m-conservative-stop-first-d8da6a2e061d6a0c',
  'us500-15m-conservative-stop-first-6f156811f1653470',
  'us500-15m-conservative-stop-first-58981fd7225e76b4',
  'us500-5m-conservative-stop-first-82b291b733439f30',
  'us500-5m-conservative-stop-first-f02c0b3c658d7bd6',
  'xagusd-15m-conservative-stop-first-367922589ec90d14',
  'xagusd-15m-conservative-stop-first-3bfada1a2b8fd140',
  'xagusd-15m-conservative-stop-first-34767ff5c0b0f938',
  'xagusd-5m-conservative-stop-first-36bc2a7e04aa3098',
  'xagusd-5m-conservative-stop-first-6c29f0afd387be34',
  'xagusd-5m-conservative-stop-first-224d579d6b2d2ed0',
  'xagusd-5m-conservative-stop-first-7bace61b2a469d08',
  'xauusd-15m-conservative-stop-first-a97474fd84cb99e3',
  'xauusd-15m-conservative-stop-first-bd677131f12b3b8c',
  'xauusd-15m-conservative-stop-first-50bc7e5d1e5a1fda',
  'xauusd-5m-conservative-stop-first-7ac796132eaa1a3d',
  'xauusd-5m-conservative-stop-first-ce496184a2c3638e',
  'xauusd-5m-conservative-stop-first-1a6a266771110a76',
  'xauusd-5m-conservative-stop-first-8ca12ce88f31fd78',
  'xauusd-5m-conservative-stop-first-ee9da04efccd7ed5',
])

export function sortReplayTradeLayers(layers: ReplayTradeLayer[]): ReplayTradeLayer[] {
  return layers.map((layer) => ({ ...layer, startedAt: layer.startedAt ?? null, finishedAt: layer.finishedAt ?? null })).sort((left, right) => {
    const rightFinishedAt = right.finishedAt ?? right.startedAt ?? right.startTime
    const leftFinishedAt = left.finishedAt ?? left.startedAt ?? left.startTime
    return rightFinishedAt - leftFinishedAt || right.endTime - left.endTime || right.startTime - left.startTime || right.createdAt - left.createdAt || left.name.localeCompare(right.name, 'zh-CN')
  })
}

function replayTradeLayerWindowKey(layer: ReplayTradeLayer) {
  return `${layer.symbol}|${layer.interval}|${layer.startTime}|${layer.endTime}`
}

function isNewerReplayTradeLayer(candidate: ReplayTradeLayer, current: ReplayTradeLayer) {
  const candidateFinishedAt = candidate.finishedAt ?? 0
  const currentFinishedAt = current.finishedAt ?? 0
  if (candidateFinishedAt !== currentFinishedAt) return candidateFinishedAt > currentFinishedAt
  const candidateStartedAt = candidate.startedAt ?? 0
  const currentStartedAt = current.startedAt ?? 0
  if (candidateStartedAt !== currentStartedAt) return candidateStartedAt > currentStartedAt
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt
  return candidate.sourceId.localeCompare(current.sourceId) > 0
}

function keepLatestReplayTradeLayerPerWindow(layers: ReplayTradeLayer[], preferredSourceIds = new Set<string>()) {
  const latestByWindow = new Map<string, ReplayTradeLayer>()
  for (const layer of layers) {
    const key = replayTradeLayerWindowKey(layer)
    const current = latestByWindow.get(key)
    if (!current) {
      latestByWindow.set(key, layer)
      continue
    }
    const candidateIsPreferred = isNextBarConfirmationLayer(layer, preferredSourceIds)
    const currentIsPreferred = isNextBarConfirmationLayer(current, preferredSourceIds)
    if (candidateIsPreferred !== currentIsPreferred) {
      if (candidateIsPreferred) latestByWindow.set(key, layer)
      continue
    }
    if (isNewerReplayTradeLayer(layer, current)) latestByWindow.set(key, layer)
  }
  return [...latestByWindow.values()]
}

function replayTradeLayerNamedWindowKey(layer: ReplayTradeLayer) {
  const baseName = layer.name.endsWith(NEXT_BAR_CONFIRMATION_SUFFIX)
    ? layer.name.slice(0, -NEXT_BAR_CONFIRMATION_SUFFIX.length)
    : layer.name
  // Exit confirmation can extend the final trade beyond the old export's
  // endTime, and some older exports also used a truncated end date in the
  // display name. The first trade's startTime is the stable replay-window
  // identity; keep the name family so unrelated custom layers do not merge.
  const familyName = baseName.replace(/\s+\d{4}-\d{2}-\d{2}(?:~\d{4}-\d{2}-\d{2})?$/, '')
  return `${layer.symbol}|${layer.interval}|${familyName}|${layer.startTime}`
}

function isNextBarConfirmationLayer(layer: ReplayTradeLayer, preferredSourceIds: Set<string>) {
  return preferredSourceIds.has(layer.sourceId) || layer.name.endsWith(NEXT_BAR_CONFIRMATION_SUFFIX)
}

function keepLatestReplayTradeLayerPerNamedWindow(layers: ReplayTradeLayer[], preferredSourceIds = new Set<string>()) {
  const latestByWindow = new Map<string, ReplayTradeLayer>()
  for (const layer of layers) {
    const key = replayTradeLayerNamedWindowKey(layer)
    const current = latestByWindow.get(key)
    if (!current) {
      latestByWindow.set(key, layer)
      continue
    }
    const candidateIsPreferred = isNextBarConfirmationLayer(layer, preferredSourceIds)
    const currentIsPreferred = isNextBarConfirmationLayer(current, preferredSourceIds)
    if (candidateIsPreferred !== currentIsPreferred) {
      if (candidateIsPreferred) latestByWindow.set(key, layer)
      continue
    }
    if (isNewerReplayTradeLayer(layer, current)) latestByWindow.set(key, layer)
  }

  return [...latestByWindow.values()].map((layer) => {
    if (!isNextBarConfirmationLayer(layer, preferredSourceIds)) return layer
    return { ...layer, name: layer.name.endsWith(NEXT_BAR_CONFIRMATION_SUFFIX)
      ? layer.name.slice(0, -NEXT_BAR_CONFIRMATION_SUFFIX.length)
      : layer.name }
  })
}

function keepLatestReplayTradeLayers(layers: ReplayTradeLayer[], preferredSourceIds = new Set<string>()) {
  return keepLatestReplayTradeLayerPerNamedWindow(keepLatestReplayTradeLayerPerWindow(layers, preferredSourceIds), preferredSourceIds)
}

function preferredReplayTradeSourceIds(available: ReplayTradeDatasetInfo[]) {
  return new Set(available
    .filter((source) => source.name.endsWith(NEXT_BAR_CONFIRMATION_SUFFIX))
    .map((source) => source.sourceId))
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
  const available = replayTradeDatasetInfos()
  return sortReplayTradeLayers(keepLatestReplayTradeLayers(available.map(createDefaultReplayTradeLayer), preferredReplayTradeSourceIds(available)))
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

function isV4ReplayTradeLayer(layer: ReplayTradeLayer) {
  return /(?:^|[^A-Za-z0-9])V4(?:[^A-Za-z0-9]|$)/i.test(layer.name)
}

export function loadReplayTradeLayers(storage: StorageLike | undefined = browserStorage()): ReplayTradeLayer[] {
  const available = replayTradeDatasetInfos()
  const preferredSourceIds = preferredReplayTradeSourceIds(available)
  if (!storage) return sortReplayTradeLayers(keepLatestReplayTradeLayers(available.map(createDefaultReplayTradeLayer), preferredSourceIds))
  const raw = storage.getItem(REPLAY_TRADE_LAYERS_STORAGE_KEY)
  const stored = parseReplayTradeLayerStore(raw)
  if (stored) {
    const storedSourceIds = new Set(stored.layers.map((layer) => layer.sourceId))
    const storedV4SourceIds = new Set(stored.layers.filter(isV4ReplayTradeLayer).map((layer) => layer.sourceId))
    const restoreMigrationPending = storage.getItem(RESTORE_XAUUSD_5M_LAYERS_MIGRATION_KEY) !== '1'
    const removeV4MigrationPending = storage.getItem(REMOVE_ALL_V4_MIGRATION_KEY) !== '1'
    const seen = new Set(stored.seenSourceIds
      .filter((sourceId) => !restoreMigrationPending || !RESTORED_XAUUSD_5M_SOURCE_IDS.has(sourceId) || storedSourceIds.has(sourceId))
      .filter((sourceId) => !REMOVED_OBSOLETE_REPLAY_SOURCE_IDS.has(sourceId))
      .filter((sourceId) => !removeV4MigrationPending || (!REMOVED_V4_SOURCE_IDS.has(sourceId) && !storedV4SourceIds.has(sourceId))))
    const additions = available
      .filter((source) => !seen.has(source.sourceId))
      .filter((source) => !REMOVED_OBSOLETE_REPLAY_SOURCE_IDS.has(source.sourceId))
      .filter((source) => !removeV4MigrationPending || !REMOVED_V4_SOURCE_IDS.has(source.sourceId))
      .map(createDefaultReplayTradeLayer)
    const availableBySourceId = new Map(available.map((source) => [source.sourceId, source]))
    const storedLayers = stored.layers
      .filter((layer) => !REMOVED_OBSOLETE_REPLAY_SOURCE_IDS.has(layer.sourceId))
      .filter((layer) => !removeV4MigrationPending || (!REMOVED_V4_SOURCE_IDS.has(layer.sourceId) && !isV4ReplayTradeLayer(layer)))
      .map((layer) => {
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
    const layers = sortReplayTradeLayers(keepLatestReplayTradeLayers([...storedLayers, ...additions], preferredSourceIds))
    for (const source of available) seen.add(source.sourceId)
    writeStore(layers, [...seen], storage)
    if (restoreMigrationPending) storage.setItem(RESTORE_XAUUSD_5M_LAYERS_MIGRATION_KEY, '1')
    if (removeV4MigrationPending) storage.setItem(REMOVE_ALL_V4_MIGRATION_KEY, '1')
    return layers
  }
  const layers = sortReplayTradeLayers(keepLatestReplayTradeLayers(available.map(createDefaultReplayTradeLayer), preferredSourceIds))
  writeStore(layers, available.map((source) => source.sourceId), storage)
  return layers
}

export function saveReplayTradeLayers(layers: ReplayTradeLayer[], storage: StorageLike | undefined = browserStorage()) {
  const available = replayTradeDatasetInfos()
  const sortedLayers = sortReplayTradeLayers(keepLatestReplayTradeLayers(layers, preferredReplayTradeSourceIds(available)))
  writeStore(sortedLayers, [...available.map((source) => source.sourceId), ...sortedLayers.map((layer) => layer.sourceId)], storage)
  storage?.setItem(RESTORE_XAUUSD_5M_LAYERS_MIGRATION_KEY, '1')
}

export function hasVisibleReplayTradeLayer(layers: ReplayTradeLayer[], symbol: SymbolId, interval: IntervalId, sourceId: string) {
  return layers.some((layer) => layer.sourceId === sourceId && layer.symbol === symbol && layer.interval === interval && layer.visible)
}
