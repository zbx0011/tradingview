import {
  DECISION_REPLAY_STORAGE_KEY,
  emptyDecisionReplayStore,
  mergeDecisionReplayStores,
  parseDecisionReplayStoreChecked,
  serializeDecisionReplayStore,
  sessionResults,
  type DecisionReplayStore,
} from './decisionReplay'
import {
  DECISION_REPLAY_FAVORITES_STORAGE_KEY,
  parseDecisionReplayFavoritesChecked,
} from './decisionReplayFavorites'
import {
  collectPortableWorkspace,
  restorePortableWorkspace,
  savePortableWorkspaceRecovery,
  type PortableWorkspace,
  type StorageLike,
} from './portableWorkspace'

export interface WorkspaceProgressMergeSummary {
  sourceCount: number
  sessionCount: number
  resultCount: number
  favoriteCount: number
}

export interface WorkspaceProgressMergeOptions {
  /**
   * File-based imports keep a browser-local undo snapshot. Background private-repository sync
   * already persisted the same pre-merge snapshot remotely, so it can avoid doubling large
   * histories inside localStorage while retaining in-memory rollback on write failure.
   */
  persistRecovery?: boolean
}

export function decisionHistoryWorkspace(workspace: PortableWorkspace): PortableWorkspace {
  return {
    ...workspace,
    entries: Object.fromEntries(Object.entries(workspace.entries).filter(([key]) => (
      key === DECISION_REPLAY_STORAGE_KEY || key === DECISION_REPLAY_FAVORITES_STORAGE_KEY
    ))),
  }
}

function workspaceMemoryStorage(workspace: PortableWorkspace): StorageLike {
  const values = new Map(Object.entries(workspace.entries))
  return {
    get length() { return values.size },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

function readDecisionStore(raw: string | null, label: string): DecisionReplayStore {
  if (raw === null) return emptyDecisionReplayStore()
  const store = parseDecisionReplayStoreChecked(raw)
  if (!store) throw new Error(`${label}中的做题记录已损坏，已停止合并`)
  return store
}

function readFavorites(raw: string | null, label: string) {
  if (raw === null) return []
  const favorites = parseDecisionReplayFavoritesChecked(raw)
  if (!favorites) throw new Error(`${label}中的收藏记录已损坏，已停止合并`)
  return favorites
}

function canonicalDecisionReplayStore(store: DecisionReplayStore) {
  let serialized = serializeDecisionReplayStore(store)
  for (let pass = 0; pass < 4; pass += 1) {
    const parsed = parseDecisionReplayStoreChecked(serialized)
    if (!parsed) throw new Error('合并后的做题记录格式无效，已停止写入')
    const nextSerialized = serializeDecisionReplayStore(parsed)
    if (nextSerialized === serialized) return { store: parsed, serialized }
    serialized = nextSerialized
  }
  throw new Error('合并后的做题记录无法稳定校验，已停止写入')
}

/**
 * Merge one or more computer backups into the current browser.
 * Local settings/drawings remain untouched; only decision history and favorites are merged.
 * A complete rollback snapshot is persisted before the first write.
 */
export function mergePortableWorkspaceProgress(
  snapshots: readonly PortableWorkspace[],
  storage: StorageLike,
  options: WorkspaceProgressMergeOptions = {},
): WorkspaceProgressMergeSummary {
  if (snapshots.length === 0) throw new Error('没有选择可合并的工作区备份')

  const before = collectPortableWorkspace(storage)
  let mergedStore = readDecisionStore(storage.getItem(DECISION_REPLAY_STORAGE_KEY), '本机')
  let mergedFavorites = readFavorites(storage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY), '本机')

  snapshots.forEach((snapshot, index) => {
    const label = `第 ${index + 1} 个备份`
    const importedStore = readDecisionStore(snapshot.entries[DECISION_REPLAY_STORAGE_KEY] ?? null, label)
    const importedFavorites = readFavorites(snapshot.entries[DECISION_REPLAY_FAVORITES_STORAGE_KEY] ?? null, label)
    mergedStore = mergeDecisionReplayStores(mergedStore, importedStore)
    mergedFavorites = [...new Set([...mergedFavorites, ...importedFavorites])]
  })

  const persistRecovery = options.persistRecovery !== false
  // File imports require a durable browser rollback point. Background sync stores this snapshot
  // in the verified private repository before calling us and therefore avoids a second large copy.
  if (persistRecovery) savePortableWorkspaceRecovery(before, storage)
  try {
    const canonicalStore = canonicalDecisionReplayStore(mergedStore)
    storage.setItem(DECISION_REPLAY_STORAGE_KEY, canonicalStore.serialized)
    storage.setItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY, JSON.stringify(mergedFavorites))

    const verifiedStore = parseDecisionReplayStoreChecked(storage.getItem(DECISION_REPLAY_STORAGE_KEY))
    const verifiedFavorites = parseDecisionReplayFavoritesChecked(storage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY))
    if (!verifiedStore || serializeDecisionReplayStore(verifiedStore) !== canonicalStore.serialized) throw new Error('写入后的做题记录校验失败')
    if (!verifiedFavorites || JSON.stringify(verifiedFavorites) !== JSON.stringify(mergedFavorites)) throw new Error('写入后的收藏记录校验失败')

    mergedStore = canonicalStore.store
  } catch (error) {
    restorePortableWorkspace(before, storage)
    if (persistRecovery) savePortableWorkspaceRecovery(before, storage)
    throw error
  }

  return {
    sourceCount: snapshots.length,
    sessionCount: mergedStore.sessions.length,
    resultCount: mergedStore.sessions.reduce((total, session) => total + sessionResults(session).length, 0),
    favoriteCount: mergedFavorites.length,
  }
}

/**
 * Collapse many cumulative repository backups into one history-only snapshot.
 * The server uses this before responding so the browser receives the exact same
 * merged progress without downloading and reprocessing every historical copy.
 */
export function mergePortableWorkspaceProgressSnapshots(
  snapshots: readonly PortableWorkspace[],
): PortableWorkspace {
  if (snapshots.length === 0) throw new Error('没有可合并的工作区备份')
  const storage = workspaceMemoryStorage({
    app: snapshots[0].app,
    version: snapshots[0].version,
    exportedAt: new Date().toISOString(),
    entries: {},
  })
  mergePortableWorkspaceProgress(snapshots, storage, { persistRecovery: false })
  return decisionHistoryWorkspace(collectPortableWorkspace(storage))
}

/**
 * Receive remote workspace settings while preserving and merging both computers' decision history.
 * The complete result is staged in memory before the real browser storage is touched.
 */
export function receivePortableWorkspaceSafely(
  remote: PortableWorkspace,
  storage: StorageLike,
  options: WorkspaceProgressMergeOptions = {},
): WorkspaceProgressMergeSummary {
  const local = collectPortableWorkspace(storage)
  const stagedStorage = workspaceMemoryStorage(remote)
  const summary = mergePortableWorkspaceProgress([decisionHistoryWorkspace(local)], stagedStorage, { persistRecovery: false })
  const staged = collectPortableWorkspace(stagedStorage)
  const persistRecovery = options.persistRecovery !== false
  if (persistRecovery) savePortableWorkspaceRecovery(local, storage)
  try {
    restorePortableWorkspace(staged, storage)
  } catch (error) {
    restorePortableWorkspace(local, storage)
    if (persistRecovery) savePortableWorkspaceRecovery(local, storage)
    throw error
  }
  return summary
}

/** Adopt the first snapshot's settings and merge history from every preserved remote snapshot. */
export function receivePortableWorkspaceSnapshotsSafely(
  snapshots: readonly PortableWorkspace[],
  storage: StorageLike,
  options: WorkspaceProgressMergeOptions = {},
): WorkspaceProgressMergeSummary {
  if (snapshots.length === 0) throw new Error('没有可接收的工作区备份')
  let summary = receivePortableWorkspaceSafely(snapshots[0], storage, options)
  if (snapshots.length > 1) {
    // Keep the recovery created before the settings restore; a second recovery
    // here would replace it with an already-mutated intermediate workspace.
    summary = mergePortableWorkspaceProgress(snapshots.slice(1), storage, { persistRecovery: false })
  }
  return summary
}
