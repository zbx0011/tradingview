import { parsePortableWorkspace, serializePortableWorkspace, type PortableWorkspace } from './portableWorkspace'

const LOCAL_SYNC_ENDPOINT = '/__kline_studio_sync'
export const LOCAL_SYNC_AUTO_MARKER_KEY = 'kline-studio-private-sync-auto-marker-v1'
const BACKGROUND_SYNC_DEDUP_WINDOW_MS = 60_000
export type LocalSyncMode = 'manual' | 'background'

export interface LocalSyncAutoMarker {
  fingerprint: string
  commit: string
  savedAt: number
}

export function parseLocalSyncAutoMarker(raw: string | null): LocalSyncAutoMarker | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<LocalSyncAutoMarker>
    return typeof value.fingerprint === 'string' && typeof value.commit === 'string' && typeof value.savedAt === 'number'
      ? { fingerprint: value.fingerprint, commit: value.commit, savedAt: value.savedAt }
      : null
  } catch {
    return null
  }
}

export function shouldSkipRecentBackgroundSync(rawMarker: string | null, fingerprint: string, now = Date.now()) {
  const marker = parseLocalSyncAutoMarker(rawMarker)
  return Boolean(marker && marker.fingerprint === fingerprint && now - marker.savedAt >= 0 && now - marker.savedAt < BACKGROUND_SYNC_DEDUP_WINDOW_MS)
}

export async function runWithLocalPrivateSyncLock<T>(operation: () => Promise<T>, waitForLock = false) {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    return { acquired: true as const, value: await operation() }
  }
  return navigator.locks.request('kline-studio-private-repository-sync', {
    mode: 'exclusive',
    ifAvailable: !waitForLock,
  }, async (lock) => lock
    ? { acquired: true as const, value: await operation() }
    : { acquired: false as const })
}

export async function localPrivateSyncAvailable() {
  try {
    const response = await fetch(LOCAL_SYNC_ENDPOINT, { headers: { Accept: 'application/json' } })
    if (!response.ok) return false
    const payload = await response.json() as { ok?: unknown; available?: unknown }
    return payload.ok === true && payload.available === true
  } catch {
    return false
  }
}

export interface LocalSyncPrepareResult {
  ok: true
  private: true
  deduplicated: boolean
  head: string
  premerge: { path: string; commit: string; sha256: string } | null
  snapshots: PortableWorkspace[]
  sourcePaths: string[]
}

export interface LocalSyncPublishResult {
  ok: true
  private: true
  path: string
  latestPath: string
  commit: string
  sha256: string
  verifiedSha256: string
}

export class LocalSyncConflictError extends Error {
  constructor(
    message: string,
    public readonly head: string,
    public readonly snapshots: PortableWorkspace[],
  ) {
    super(message)
  }
}

function checkedSnapshots(value: unknown): PortableWorkspace[] {
  if (!Array.isArray(value)) throw new Error('本机同步服务未返回备份列表')
  return value.map((item, index) => {
    const parsed = parsePortableWorkspace(JSON.stringify(item))
    if (!parsed) throw new Error(`私有仓库第 ${index + 1} 份备份格式无效`)
    return parsed
  })
}

async function request(body: Record<string, unknown>) {
  const response = await fetch(LOCAL_SYNC_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kline-Studio-Sync': '1' },
    body: JSON.stringify(body),
  })
  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    throw new Error(`本机同步服务返回了无效响应（HTTP ${response.status}）`)
  }
  if (!response.ok || payload.ok !== true) {
    const message = typeof payload.error === 'string' ? payload.error : `本机同步失败（HTTP ${response.status}）`
    if (response.status === 409 && typeof payload.head === 'string' && Array.isArray(payload.snapshots)) {
      throw new LocalSyncConflictError(message, payload.head, checkedSnapshots(payload.snapshots))
    }
    throw new Error(message)
  }
  return payload
}

export async function prepareLocalPrivateSync(snapshot: PortableWorkspace, mode: LocalSyncMode = 'manual'): Promise<LocalSyncPrepareResult> {
  const payload = await request({ action: 'prepare', mode, snapshot })
  if (payload.private !== true || typeof payload.head !== 'string') {
    throw new Error('私有仓库校验结果缺失，已停止同步')
  }
  if (payload.deduplicated === true) {
    return { ok: true, private: true, deduplicated: true, head: payload.head, premerge: null, snapshots: [], sourcePaths: [] }
  }
  if (!payload.premerge || typeof payload.premerge !== 'object') throw new Error('合并前保护备份校验结果缺失，已停止同步')
  const premerge = payload.premerge as Record<string, unknown>
  if (typeof premerge.path !== 'string' || typeof premerge.commit !== 'string' || typeof premerge.sha256 !== 'string') {
    throw new Error('合并前保护备份校验结果缺失，已停止同步')
  }
  return {
    ok: true,
    private: true,
    deduplicated: false,
    head: payload.head,
    premerge: { path: premerge.path, commit: premerge.commit, sha256: premerge.sha256 },
    snapshots: checkedSnapshots(payload.snapshots),
    sourcePaths: Array.isArray(payload.sourcePaths) ? payload.sourcePaths.filter((item): item is string => typeof item === 'string') : [],
  }
}

export async function publishLocalPrivateSync(expectedHead: string, snapshot: PortableWorkspace, mode: LocalSyncMode = 'manual'): Promise<LocalSyncPublishResult> {
  const payload = await request({ action: 'publish', mode, expectedHead, snapshot })
  if (payload.private !== true || typeof payload.path !== 'string' || typeof payload.latestPath !== 'string'
    || typeof payload.commit !== 'string' || typeof payload.sha256 !== 'string' || typeof payload.verifiedSha256 !== 'string') {
    throw new Error('远端备份验证结果缺失，未报告同步成功')
  }
  if (payload.sha256 !== payload.verifiedSha256) throw new Error('远端回下载 SHA-256 不一致，未报告同步成功')
  return {
    ok: true,
    private: true,
    path: payload.path,
    latestPath: payload.latestPath,
    commit: payload.commit,
    sha256: payload.sha256,
    verifiedSha256: payload.verifiedSha256,
  }
}

export async function sha256PortableWorkspace(snapshot: PortableWorkspace) {
  const bytes = new TextEncoder().encode(serializePortableWorkspace(snapshot))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}
