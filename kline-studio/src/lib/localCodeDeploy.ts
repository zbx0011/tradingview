const LOCAL_CODE_DEPLOY_ENDPOINT = '/__kline_studio_code_deploy'
const LOCAL_CODE_DEPLOY_ACTIVITY_KEY = 'kline-local-code-deploy-activity-v1'
const LOCAL_CODE_PENDING_UPDATE_KEY = 'kline-local-code-pending-update-v1'

export class LocalCodeDeployUnavailableError extends Error {
  override name = 'LocalCodeDeployUnavailableError'
}

export interface LocalCodeStatus {
  ok: true
  action: 'status'
  repositoryRoot: string
  projectRoot: string
  projectRelativePath: string
  branch: string
  localHead: string
  remoteHead: string
  localHeadTimestamp: string
  remoteHeadTimestamp: string
  dirtyFiles: string[]
  clean: boolean
  updateAvailable: boolean
  aheadOfRemote: boolean
  diverged: boolean
  serverInstanceId?: string
  runningCommit?: string
  restartRequired?: boolean
}

export interface LocalCodeDeployActivity {
  lastVerifiedAt?: string
  lastSuccessfulSync?: {
    action: 'publish' | 'update'
    at: string
    commit: string
  }
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

export function loadLocalCodeDeployActivity(
  storage?: Pick<Storage, 'getItem'>,
): LocalCodeDeployActivity {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const parsed = JSON.parse(target?.getItem(LOCAL_CODE_DEPLOY_ACTIVITY_KEY) ?? 'null') as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return {}
    const lastSuccessfulSync = parsed.lastSuccessfulSync as Record<string, unknown> | undefined
    return {
      ...(isIsoDate(parsed.lastVerifiedAt) ? { lastVerifiedAt: parsed.lastVerifiedAt } : {}),
      ...(lastSuccessfulSync
        && (lastSuccessfulSync.action === 'publish' || lastSuccessfulSync.action === 'update')
        && isIsoDate(lastSuccessfulSync.at)
        && typeof lastSuccessfulSync.commit === 'string'
        && lastSuccessfulSync.commit.length > 0
        ? { lastSuccessfulSync: { action: lastSuccessfulSync.action, at: lastSuccessfulSync.at, commit: lastSuccessfulSync.commit } }
        : {}),
    }
  } catch {
    return {}
  }
}

export function saveLocalCodeDeployActivity(
  activity: LocalCodeDeployActivity,
  storage?: Pick<Storage, 'setItem'>,
) {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    target?.setItem(LOCAL_CODE_DEPLOY_ACTIVITY_KEY, JSON.stringify(activity))
  } catch { /* Browser storage must not turn a verified deployment into a failure. */ }
}

export interface LocalCodePublishResult {
  ok: true
  action: 'publish-code'
  commit: string
  branch: string
  repository: string
  verified: true
}

export interface LocalCodeUpdateResult {
  ok: true
  action: 'update-code'
  commit: string
  updated: boolean
  restartRequired: boolean
  previousServerInstanceId?: string
  preservedLocalChanges?: boolean
  backupBranch?: string
  backupStash?: string
}

async function request<T>(action: 'status' | 'health' | 'publish-code' | 'update-code'): Promise<T> {
  const timeoutMs = action === 'health' ? 10_000 : action === 'status' ? 60_000 : 600_000
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let result: { response: Response; text: string }
  try {
    // Bound both connection and body reads, even if a transport ignores abort.
    result = await Promise.race([
      (async () => {
        const response = await fetch(LOCAL_CODE_DEPLOY_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kline-Studio-Deploy': '1' },
          body: JSON.stringify({ action }),
          signal: controller.signal,
        })
        return { response, text: await response.text() }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new LocalCodeDeployUnavailableError(`本机代码部署服务响应超时（${timeoutMs / 1000} 秒）`))
          controller.abort()
        }, timeoutMs)
      }),
    ])
  } catch (error) {
    if (error instanceof LocalCodeDeployUnavailableError) throw error
    throw new LocalCodeDeployUnavailableError('暂时无法连接本机代码部署服务')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const { response, text } = result
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const reason = /^\s*</.test(text) ? '返回了网页内容，服务可能正在重启或尚未加载' : '返回了无效 JSON 响应'
    throw new LocalCodeDeployUnavailableError(`本机代码部署接口${reason}（HTTP ${response.status}）`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalCodeDeployUnavailableError(`本机代码部署服务返回了无效响应对象（HTTP ${response.status}）`)
  }
  const payload = parsed as Record<string, unknown>
  if (!response.ok || payload.ok !== true) {
    if (response.ok && payload.ok !== false) {
      throw new LocalCodeDeployUnavailableError(`本机代码部署响应缺少结果标识（HTTP ${response.status}）`)
    }
    const details = Array.isArray(payload.dirtyFiles) ? `：${payload.dirtyFiles.join('；')}` : ''
    throw new Error(`${typeof payload.error === 'string' ? payload.error : `代码部署失败（HTTP ${response.status}）`}${details}`)
  }
  return payload as T
}

export async function loadLocalCodeStatus() {
  const result = await request<LocalCodeStatus>('status')
  if (typeof result.localHead !== 'string' || typeof result.remoteHead !== 'string'
    || !isIsoDate(result.localHeadTimestamp) || !isIsoDate(result.remoteHeadTimestamp)
    || !Array.isArray(result.dirtyFiles)) {
    throw new Error('本机代码状态响应缺少必要字段')
  }
  return result
}

export async function publishLocalCode() {
  const result = await request<LocalCodePublishResult>('publish-code')
  if (typeof result.commit !== 'string' || result.verified !== true) throw new Error('公开仓库提交验证结果缺失')
  return result
}

export async function updateLocalCode() {
  const result = await request<LocalCodeUpdateResult>('update-code')
  if (typeof result.commit !== 'string' || typeof result.updated !== 'boolean' || typeof result.restartRequired !== 'boolean') {
    throw new Error('本机代码更新结果缺少必要字段')
  }
  if (result.restartRequired && !result.previousServerInstanceId) throw new Error('部署服务需要重启后再更新：缺少服务实例标识')
  return result
}

export interface LocalCodeHealth {
  localHead: string
  serverInstanceId: string
}

export function isUpdatedCodeServerReady(status: Pick<LocalCodeStatus, 'localHead' | 'serverInstanceId'>, result: LocalCodeUpdateResult): boolean {
  return Boolean(result.previousServerInstanceId && status.serverInstanceId
    && status.serverInstanceId !== result.previousServerInstanceId && status.localHead === result.commit)
}

export async function loadLocalCodeHealth() {
  const result = await request<LocalCodeHealth>('health')
  if (typeof result.localHead !== 'string' || !result.localHead || typeof result.serverInstanceId !== 'string' || !result.serverInstanceId) {
    throw new LocalCodeDeployUnavailableError('本机代码部署健康响应缺少提交号或服务实例标识')
  }
  return result
}

export function savePendingLocalCodeUpdate(result: LocalCodeUpdateResult, storage?: Pick<Storage, 'setItem'>) {
  if (!result.restartRequired || !result.previousServerInstanceId) return
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    target?.setItem(LOCAL_CODE_PENDING_UPDATE_KEY, JSON.stringify(result))
  } catch { /* Keep polling the accepted restart even when its ticket cannot be persisted. */ }
}

export function loadPendingLocalCodeUpdate(storage?: Pick<Storage, 'getItem'>): LocalCodeUpdateResult | null {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const value = JSON.parse(target?.getItem(LOCAL_CODE_PENDING_UPDATE_KEY) ?? 'null') as LocalCodeUpdateResult | null
    return value?.restartRequired === true && typeof value.commit === 'string' && typeof value.previousServerInstanceId === 'string' && value.previousServerInstanceId.length > 0 ? value : null
  } catch { return null }
}

export function clearPendingLocalCodeUpdate(storage?: Pick<Storage, 'removeItem'>) {
  try {
    const target = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    target?.removeItem(LOCAL_CODE_PENDING_UPDATE_KEY)
  } catch { /* Completion and page reload must still proceed if storage is blocked. */ }
}
