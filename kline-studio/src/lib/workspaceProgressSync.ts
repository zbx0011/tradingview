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
    storage.setItem(DECISION_REPLAY_STORAGE_KEY, serializeDecisionReplayStore(mergedStore))
    storage.setItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY, JSON.stringify(mergedFavorites))

    const verifiedStore = parseDecisionReplayStoreChecked(storage.getItem(DECISION_REPLAY_STORAGE_KEY))
    const verifiedFavorites = parseDecisionReplayFavoritesChecked(storage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY))
    if (!verifiedStore || serializeDecisionReplayStore(verifiedStore) !== serializeDecisionReplayStore(mergedStore)) throw new Error('写入后的做题记录校验失败')
    if (!verifiedFavorites || JSON.stringify(verifiedFavorites) !== JSON.stringify(mergedFavorites)) throw new Error('写入后的收藏记录校验失败')
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
