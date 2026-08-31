const LOCAL_CODE_DEPLOY_ENDPOINT = '/__kline_studio_code_deploy'
const LOCAL_CODE_DEPLOY_ACTIVITY_KEY = 'kline-local-code-deploy-activity-v1'

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
  storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): LocalCodeDeployActivity {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(LOCAL_CODE_DEPLOY_ACTIVITY_KEY) ?? 'null') as Record<string, unknown> | null
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
  storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  storage?.setItem(LOCAL_CODE_DEPLOY_ACTIVITY_KEY, JSON.stringify(activity))
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
}

async function request<T>(action: 'status' | 'publish-code' | 'update-code'): Promise<T> {
  let response: Response
  try {
    response = await fetch(LOCAL_CODE_DEPLOY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kline-Studio-Deploy': '1' },
      body: JSON.stringify({ action }),
    })
  } catch {
    throw new LocalCodeDeployUnavailableError('暂时无法连接本机代码部署服务')
  }
  let payload: Record<string, unknown>
  try {
    payload = await response.json() as Record<string, unknown>
  } catch {
    throw new LocalCodeDeployUnavailableError(`本机代码部署服务返回了无效响应（HTTP ${response.status}）`)
  }
  if (!response.ok || payload.ok !== true) {
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
  return result
}
