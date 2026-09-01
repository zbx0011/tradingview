import { describe, expect, it } from 'vitest'
import { DECISION_REPLAY_STORAGE_KEY, parseDecisionReplayStore, type DecisionReplaySession, type DecisionReplayStore } from './decisionReplay'
import { DECISION_REPLAY_FAVORITES_STORAGE_KEY } from './decisionReplayFavorites'
import { PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY, loadPortableWorkspaceRecovery, type PortableWorkspace } from './portableWorkspace'
import { mergePortableWorkspaceProgress, mergePortableWorkspaceProgressSnapshots, receivePortableWorkspaceSafely, receivePortableWorkspaceSnapshotsSafely } from './workspaceProgressSync'

function session(id: string, startedAt: number): DecisionReplaySession {
  return {
    id,
    requestedCount: 1,
    candidates: [],
    attempts: [{
      candidateKey: `${id}:trade`, cursorTime: startedAt, stage: 'complete', entryMode: null, orderKind: null,
      pendingEntryPrice: null, initialStopLoss: null, stopLoss: null, takeProfit: null, fill: null, drawings: [],
      result: { candidateKey: `${id}:trade` } as DecisionReplaySession['attempts'][number]['result'],
    }],
    currentIndex: 1,
    status: 'completed',
    startedAt,
    updatedAt: startedAt,
    finishedAt: startedAt,
    positionSizingModes: ['fixed-risk', 'fixed-notional'],
  }
}

function store(...sessions: DecisionReplaySession[]): DecisionReplayStore {
  return {
    version: 1,
    seenTradeKeys: sessions.map((item) => `${item.id}:trade`),
    activeSessionId: null,
    sessions,
  }
}

function snapshot(history: DecisionReplayStore, favorites: string[] = []): PortableWorkspace {
  return {
    app: 'kline-studio',
    version: 1,
    exportedAt: '2026-08-20T00:00:00.000Z',
    entries: {
      [DECISION_REPLAY_STORAGE_KEY]: JSON.stringify(history),
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: JSON.stringify(favorites),
    },
  }
}

function createStorage(initial: Record<string, string>, failOnceFor?: string) {
  const values = new Map(Object.entries(initial))
  let shouldFail = Boolean(failOnceFor)
  return {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (shouldFail && key === failOnceFor) {
        shouldFail = false
        throw new Error('simulated quota failure')
      }
      values.set(key, value)
    },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

describe('workspace progress sync', () => {
  it('compacts cumulative repository backups without dropping older unique progress', () => {
    const compacted = mergePortableWorkspaceProgressSnapshots([
      snapshot(store(session('older-only', 1000)), ['trade:older']),
      snapshot(store(session('newer-only', 2000)), ['trade:newer']),
    ])
    const compactedStore = parseDecisionReplayStore(compacted.entries[DECISION_REPLAY_STORAGE_KEY])

    expect(compactedStore.sessions.map((item) => item.id)).toEqual(['newer-only', 'older-only'])
    expect(JSON.parse(compacted.entries[DECISION_REPLAY_FAVORITES_STORAGE_KEY])).toEqual(['trade:older', 'trade:newer'])
    expect(Object.keys(compacted.entries)).toEqual([DECISION_REPLAY_STORAGE_KEY, DECISION_REPLAY_FAVORITES_STORAGE_KEY])
  })

  it('merges multiple computer backups, preserves local settings, and creates a rollback point', () => {
    const local = store(session('local', 1000))
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: JSON.stringify(local),
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: JSON.stringify(['trade:local']),
      'kline-studio-workspace-v1': '{"symbol":"XAGUSD"}',
    })

    const summary = mergePortableWorkspaceProgress([
      snapshot(store(session('computer-a', 2000)), ['trade:a']),
      snapshot(store(session('computer-b', 3000)), ['trade:b', 'trade:a']),
    ], storage)

    expect(summary).toEqual({ sourceCount: 2, sessionCount: 3, resultCount: 3, favoriteCount: 3 })
    expect(parseDecisionReplayStore(storage.getItem(DECISION_REPLAY_STORAGE_KEY)).sessions.map((item) => item.id)).toEqual([
      'computer-b', 'computer-a', 'local',
    ])
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('{"symbol":"XAGUSD"}')
    expect(loadPortableWorkspaceRecovery(storage)?.entries[DECISION_REPLAY_STORAGE_KEY]).toBe(JSON.stringify(local))
  })

  it('rejects damaged imported history before changing local data', () => {
    const localRaw = JSON.stringify(store(session('local', 1000)))
    const storage = createStorage({ [DECISION_REPLAY_STORAGE_KEY]: localRaw })
    const damaged = snapshot(store())
    damaged.entries[DECISION_REPLAY_STORAGE_KEY] = '{bad json'

    expect(() => mergePortableWorkspaceProgress([damaged], storage)).toThrow('已损坏')
    expect(storage.getItem(DECISION_REPLAY_STORAGE_KEY)).toBe(localRaw)
    expect(storage.getItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)).toBeNull()
  })

  it('rolls back every app key if a merge write fails', () => {
    const localRaw = JSON.stringify(store(session('local', 1000)))
    const localFavorites = JSON.stringify(['trade:local'])
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: localRaw,
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: localFavorites,
      'kline-studio-workspace-v1': 'keep-local-settings',
    }, DECISION_REPLAY_FAVORITES_STORAGE_KEY)

    expect(() => mergePortableWorkspaceProgress([
      snapshot(store(session('imported', 2000)), ['trade:imported']),
    ], storage)).toThrow('simulated quota failure')
    expect(storage.getItem(DECISION_REPLAY_STORAGE_KEY)).toBe(localRaw)
    expect(storage.getItem(DECISION_REPLAY_FAVORITES_STORAGE_KEY)).toBe(localFavorites)
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('keep-local-settings')
    expect(storage.getItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)).not.toBeNull()
  })

  it('uses in-memory rollback without duplicating a large recovery snapshot during verified background sync', () => {
    const localRaw = JSON.stringify(store(session('local', 1000)))
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: localRaw,
      'kline-studio-workspace-v1': 'keep-local-settings',
    }, PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)

    expect(mergePortableWorkspaceProgress([
      snapshot(store(session('imported', 2000)), ['trade:imported']),
    ], storage, { persistRecovery: false })).toMatchObject({ sessionCount: 2, resultCount: 2 })
    expect(storage.getItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('keep-local-settings')
  })

  it('receives remote settings while merging and preserving local decision history', () => {
    const local = store(session('local', 1000))
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: JSON.stringify(local),
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: JSON.stringify(['trade:local']),
      'kline-studio-workspace-v1': 'local-settings',
    })
    const remote = snapshot(store(session('remote', 2000)), ['trade:remote'])
    remote.entries['kline-studio-workspace-v1'] = 'remote-settings'

    expect(receivePortableWorkspaceSafely(remote, storage)).toMatchObject({
      sessionCount: 2,
      resultCount: 2,
      favoriteCount: 2,
    })
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('remote-settings')
    expect(parseDecisionReplayStore(storage.getItem(DECISION_REPLAY_STORAGE_KEY)).sessions.map((item) => item.id)).toEqual([
      'remote', 'local',
    ])
    expect(loadPortableWorkspaceRecovery(storage)?.entries['kline-studio-workspace-v1']).toBe('local-settings')
  })

  it('receives settings from latest while recovering history from every before-sync snapshot', () => {
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: JSON.stringify(store(session('local', 1000))),
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: JSON.stringify(['trade:local']),
      'kline-studio-workspace-v1': 'local-settings',
    })
    const latest = snapshot(store(session('stale-latest', 2000)), ['trade:stale'])
    latest.entries['kline-studio-workspace-v1'] = 'remote-settings'
    const completedBeforeSync = snapshot(store(session('completed-before-sync', 3000)), ['trade:completed'])

    expect(receivePortableWorkspaceSnapshotsSafely([latest, completedBeforeSync], storage)).toMatchObject({
      sessionCount: 3,
      resultCount: 3,
      favoriteCount: 3,
    })
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('remote-settings')
    expect(parseDecisionReplayStore(storage.getItem(DECISION_REPLAY_STORAGE_KEY)).sessions.map((item) => item.id)).toEqual([
      'completed-before-sync', 'stale-latest', 'local',
    ])
    expect(loadPortableWorkspaceRecovery(storage)?.entries['kline-studio-workspace-v1']).toBe('local-settings')
  })

  it('uses the verified disk recovery path instead of duplicating a quota-sized workspace in localStorage', () => {
    const storage = createStorage({
      [DECISION_REPLAY_STORAGE_KEY]: JSON.stringify(store(session('local', 1000))),
      [DECISION_REPLAY_FAVORITES_STORAGE_KEY]: JSON.stringify(['trade:local']),
      'kline-studio-workspace-v1': 'local-settings',
    }, PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)
    const latest = snapshot(store(session('remote', 2000)), ['trade:remote'])
    latest.entries['kline-studio-workspace-v1'] = 'remote-settings'

    expect(receivePortableWorkspaceSnapshotsSafely([latest], storage, { persistRecovery: false })).toMatchObject({
      sessionCount: 2,
      resultCount: 2,
      favoriteCount: 2,
    })
    expect(storage.getItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)).toBeNull()
    expect(storage.getItem('kline-studio-workspace-v1')).toBe('remote-settings')
  })
})
