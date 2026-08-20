import {
  DECISION_REPLAY_STORAGE_KEY,
  emptyDecisionReplayStore,
  mergeDecisionReplayStores,
  parseDecisionReplayStoreChecked,
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

  // If the browser cannot retain a rollback point (for example because storage is full), do not mutate anything.
  savePortableWorkspaceRecovery(before, storage)
  try {
    storage.setItem(DECISION_REPLAY_STORAGE_KEY, JSON.stringify(mergedStore))
    storage.setItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY, JSON.stringify(mergedFavorites))

    const verifiedStore = parseDecisionReplayStoreChecked(storage.getItem(DECISION_REPLAY_STORAGE_KEY))
    const verifiedFavorites = parseDecisionReplayFavoritesChecked(storage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY))
    if (!verifiedStore || JSON.stringify(verifiedStore) !== JSON.stringify(mergedStore)) throw new Error('写入后的做题记录校验失败')
    if (!verifiedFavorites || JSON.stringify(verifiedFavorites) !== JSON.stringify(mergedFavorites)) throw new Error('写入后的收藏记录校验失败')
  } catch (error) {
    restorePortableWorkspace(before, storage)
    savePortableWorkspaceRecovery(before, storage)
    throw error
  }

  return {
    sourceCount: snapshots.length,
    sessionCount: mergedStore.sessions.length,
    resultCount: mergedStore.sessions.reduce((total, session) => total + sessionResults(session).length, 0),
    favoriteCount: mergedFavorites.length,
  }
}
