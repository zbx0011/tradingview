import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const API_PATH = '/__kline_studio_sync'
const REPOSITORY_OWNER = 'zbx0011'
const REPOSITORY_NAME = 'kline-studio-sync-private'
const REPOSITORY_URL = `https://github.com/${REPOSITORY_OWNER}/${REPOSITORY_NAME}.git`
const MAX_REQUEST_BYTES = 64 * 1024 * 1024
const MAX_BACKUP_FILES = 300
const MAX_BACKUP_BYTES = 768 * 1024 * 1024
const REPLAY_KEY = 'kline-studio-decision-replay-v1'
const FAVORITES_KEY = 'kline-studio-decision-replay-favorites-v1'

interface PortableWorkspace {
  app: 'kline-studio'
  version: 1
  exportedAt: string
  entries: Record<string, string>
}

interface CommandResult {
  stdout: string
  stderr: string
}

interface PrivateRepositoryState {
  repositoryPath: string
  head: string
}

type SyncMode = 'manual' | 'background'

let recentBackgroundLease: { fingerprint: string; expiresAt: number } | null = null

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: Record<string, unknown>) {
    super(message)
  }
}

function runFile(command: string, args: readonly string[], options: { cwd?: string; input?: string } = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${stderr.trim() || '没有错误输出'}`))
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function normalizeRemote(value: string) {
  return value.trim().replace(/\.git$/i, '').replace(/^git@github\.com:/i, 'https://github.com/')
}

function workspaceFromUnknown(value: unknown): PortableWorkspace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '备份不是有效的对象')
  const candidate = value as Partial<PortableWorkspace>
  if (candidate.app !== 'kline-studio' || candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== 'object' || Array.isArray(candidate.entries)) {
    throw new HttpError(400, '备份 app、version 或 entries 无效')
  }
  const entries: Record<string, string> = {}
  for (const [key, item] of Object.entries(candidate.entries)) {
    if (!key.startsWith('kline-studio-') || typeof item !== 'string') throw new HttpError(400, `备份包含无效存储项：${key}`)
    if (key === 'kline-studio-workspace-import-recovery-v1') continue
    entries[key] = item
  }
  return {
    app: 'kline-studio',
    version: 1,
    exportedAt: typeof candidate.exportedAt === 'string' ? candidate.exportedAt : new Date().toISOString(),
    entries,
  }
}

function serializeWorkspace(workspace: PortableWorkspace) {
  return JSON.stringify(workspace, null, 2)
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function progressFingerprint(workspace: PortableWorkspace) {
  return sha256(JSON.stringify([
    workspace.entries[REPLAY_KEY] ?? null,
    workspace.entries[FAVORITES_KEY] ?? null,
  ]))
}

async function readJsonRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_REQUEST_BYTES) throw new HttpError(413, '同步备份超过 64MB，已停止处理')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, '同步请求不是有效 JSON')
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(value))
}

function verifyLocalRequest(request: IncomingMessage) {
  const host = String(request.headers.host ?? '')
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    throw new HttpError(403, '本机同步接口只接受 localhost 请求')
  }
  if (request.method !== 'GET') {
    const origin = String(request.headers.origin ?? '')
    if (origin !== `http://${host}` || request.headers['x-kline-studio-sync'] !== '1') {
      throw new HttpError(403, '同步请求来源校验失败')
    }
  }
}

function configuredRepositoryPath() {
  const configured = process.env.KLINE_STUDIO_SYNC_REPO?.trim()
  if (configured) return path.resolve(configured)
  const workspaceSibling = path.resolve(process.cwd(), '..', '..', REPOSITORY_NAME)
  return workspaceSibling
}

async function ensureClone(repositoryPath: string) {
  try {
    await fs.access(path.join(repositoryPath, '.git'))
    return
  } catch {
    // Continue to the standard per-user clone when no explicit or workspace-adjacent clone exists.
  }
  const fallback = process.env.KLINE_STUDIO_SYNC_REPO?.trim()
    ? repositoryPath
    : path.join(process.env.LOCALAPPDATA || os.homedir(), 'KlineStudio', 'sync-private')
  await fs.mkdir(path.dirname(fallback), { recursive: true })
  try {
    await fs.access(path.join(fallback, '.git'))
  } catch {
    await runFile('git', ['clone', REPOSITORY_URL, fallback])
  }
  return fallback
}

async function verifyPrivateVisibility() {
  let credentialOutput: string
  try {
    credentialOutput = (await runFile('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' })).stdout
  } catch {
    throw new HttpError(503, '无法从 Git 凭据管理器取得 GitHub 登录状态；未上传任何数据')
  }
  const credential = Object.fromEntries(credentialOutput.split(/\r?\n/).map((line) => {
    const index = line.indexOf('=')
    return index > 0 ? [line.slice(0, index), line.slice(index + 1)] : ['', '']
  }).filter(([key]) => key))
  const token = credential.password
  if (!token) throw new HttpError(503, 'GitHub 凭据中没有可用令牌；未上传任何数据')
  const apiResponse = await fetch(`https://api.github.com/repos/${REPOSITORY_OWNER}/${REPOSITORY_NAME}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'kline-studio-local-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!apiResponse.ok) throw new HttpError(503, `GitHub 私有仓库校验失败（HTTP ${apiResponse.status}）；未上传任何数据`)
  const metadata = await apiResponse.json() as { private?: boolean; visibility?: string; full_name?: string }
  if (metadata.full_name !== `${REPOSITORY_OWNER}/${REPOSITORY_NAME}` || metadata.private !== true || metadata.visibility !== 'private') {
    throw new HttpError(403, '同步仓库不是 PRIVATE，已停止且未上传任何数据')
  }
}

async function ensureRepositoryUpdated(): Promise<PrivateRepositoryState> {
  const preferredPath = configuredRepositoryPath()
  const repositoryPath = await ensureClone(preferredPath) ?? preferredPath
  const remote = normalizeRemote((await runFile('git', ['remote', 'get-url', 'origin'], { cwd: repositoryPath })).stdout)
  if (remote !== normalizeRemote(REPOSITORY_URL)) throw new HttpError(409, `同步仓库 origin 不匹配：${remote}`)
  const dirty = (await runFile('git', ['status', '--porcelain'], { cwd: repositoryPath })).stdout.trim()
  if (dirty) throw new HttpError(409, `私有同步仓库存在本机修改，未覆盖也未上传：${repositoryPath}（${dirty.split(/\r?\n/).slice(0, 5).join('；')}）`)
  await runFile('git', ['switch', 'main'], { cwd: repositoryPath })
  await runFile('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: repositoryPath })
  const head = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).stdout.trim()
  return { repositoryPath, head }
}

async function commitAndPush(repositoryPath: string, relativePaths: readonly string[], message: string) {
  await verifyPrivateVisibility()
  await runFile('git', ['add', '--', ...relativePaths], { cwd: repositoryPath })
  const staged = await runFile('git', ['diff', '--cached', '--quiet'], { cwd: repositoryPath }).then(() => false).catch(() => true)
  if (staged) await runFile('git', [
    '-c', 'user.name=Kline Studio Sync',
    '-c', 'user.email=kline-studio-sync@users.noreply.github.com',
    'commit', '-m', message,
  ], { cwd: repositoryPath })
  await runFile('git', ['push', 'origin', 'main'], { cwd: repositoryPath })
  return (await runFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryPath })).stdout.trim()
}

async function backupFiles(root: string) {
  const result: string[] = []
  async function visit(directory: string) {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) result.push(fullPath)
    }
  }
  try {
    await visit(path.join(root, 'backups'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  result.sort()
  if (result.length > MAX_BACKUP_FILES) throw new HttpError(413, `私有仓库备份超过 ${MAX_BACKUP_FILES} 份，请先归档后再同步`)
  return result
}

async function collectProgressSnapshots(repositoryPath: string) {
  const files = await backupFiles(repositoryPath)
  const snapshots: PortableWorkspace[] = []
  const sourcePaths: string[] = []
  let totalBytes = 0
  for (const file of files) {
    const raw = await fs.readFile(file, 'utf8')
    totalBytes += Buffer.byteLength(raw)
    if (totalBytes > MAX_BACKUP_BYTES) throw new HttpError(413, '私有仓库备份总量超过 768MB，请先归档后再同步')
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new HttpError(409, `私有仓库存在损坏 JSON：${path.relative(repositoryPath, file)}`) }
    const workspace = workspaceFromUnknown(parsed)
    snapshots.push({
      ...workspace,
      entries: Object.fromEntries(Object.entries(workspace.entries).filter(([key]) => key === REPLAY_KEY || key === FAVORITES_KEY)),
    })
    sourcePaths.push(path.relative(repositoryPath, file).replaceAll(path.sep, '/'))
  }
  return { snapshots, sourcePaths }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')
}

function safeMachineName() {
  return os.hostname().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'windows-pc'
}

async function prepareSync(snapshot: PortableWorkspace, mode: SyncMode) {
  const state = await ensureRepositoryUpdated()
  const fingerprint = progressFingerprint(snapshot)
  if (mode === 'background' && recentBackgroundLease
    && recentBackgroundLease.fingerprint === fingerprint && recentBackgroundLease.expiresAt > Date.now()) {
    return {
      ok: true,
      private: true,
      deduplicated: true,
      head: state.head,
      premerge: null,
      snapshots: [],
      sourcePaths: [],
    }
  }
  await verifyPrivateVisibility()
  const relativePath = mode === 'background'
    ? `backups/devices/${safeMachineName()}/before-sync/kline-studio-sync-before-latest.json`
    : `backups/devices/${safeMachineName()}/before-sync/kline-studio-sync-before-${timestamp()}.json`
  const fullPath = path.join(state.repositoryPath, ...relativePath.split('/'))
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  const raw = serializeWorkspace(snapshot)
  let commit = state.head
  let backupRaw = raw
  let writeBackup = true
  if (mode === 'background') {
    try {
      const existingRaw = await fs.readFile(fullPath, 'utf8')
      const existing = workspaceFromUnknown(JSON.parse(existingRaw))
      if (progressFingerprint(existing) === fingerprint) {
        writeBackup = false
        backupRaw = existingRaw
      }
    } catch {
      // A missing or invalid rotating backup is replaced by the verified current snapshot below.
    }
  }
  if (writeBackup) {
    await fs.writeFile(fullPath, raw, mode === 'background' ? 'utf8' : { encoding: 'utf8', flag: 'wx' })
    commit = await commitAndPush(state.repositoryPath, [relativePath], mode === 'background'
      ? 'backup: preserve latest workspace before background sync'
      : 'backup: preserve workspace before private sync')
  }
  if (mode === 'background') recentBackgroundLease = { fingerprint, expiresAt: Date.now() + 60_000 }
  const collected = await collectProgressSnapshots(state.repositoryPath)
  return {
    ok: true,
    private: true,
    deduplicated: false,
    head: commit,
    premerge: { path: relativePath, commit, sha256: sha256(backupRaw) },
    ...collected,
  }
}

async function receiveSync() {
  await verifyPrivateVisibility()
  const state = await ensureRepositoryUpdated()
  const collected = await collectProgressSnapshots(state.repositoryPath)
  return {
    ok: true,
    private: true,
    head: state.head,
    ...collected,
  }
}

async function publishSync(expectedHead: string, snapshot: PortableWorkspace, mode: SyncMode) {
  const state = await ensureRepositoryUpdated()
  if (state.head !== expectedHead) {
    const collected = await collectProgressSnapshots(state.repositoryPath)
    throw new HttpError(409, '远端在同步期间产生了新备份，请合并最新版本后重试', { head: state.head, ...collected })
  }
  await verifyPrivateVisibility()
  const raw = serializeWorkspace(snapshot)
  const latestPath = 'backups/merged/kline-studio-sync-latest.json'
  const relativePath = mode === 'background'
    ? latestPath
    : `backups/merged/kline-studio-sync-merged-${timestamp()}.json`
  await fs.mkdir(path.join(state.repositoryPath, 'backups', 'merged'), { recursive: true })
  await fs.writeFile(path.join(state.repositoryPath, ...relativePath.split('/')), raw, mode === 'background' ? 'utf8' : { encoding: 'utf8', flag: 'wx' })
  await fs.writeFile(path.join(state.repositoryPath, ...latestPath.split('/')), raw, 'utf8')
  const commit = await commitAndPush(state.repositoryPath, [...new Set([relativePath, latestPath])], mode === 'background'
    ? 'backup: publish latest background-synced workspace'
    : 'backup: publish merged Kline Studio workspace')
  await runFile('git', ['fetch', 'origin', 'main'], { cwd: state.repositoryPath })
  const downloaded = (await runFile('git', ['show', `origin/main:${relativePath}`], { cwd: state.repositoryPath })).stdout
  const uploadedSha = sha256(raw)
  const downloadedSha = sha256(downloaded)
  if (uploadedSha !== downloadedSha) throw new HttpError(500, '远端回下载 SHA-256 不一致，已停止报告成功')
  return { ok: true, private: true, path: relativePath, latestPath, commit, sha256: uploadedSha, verifiedSha256: downloadedSha }
}

export function localPrivateSyncPlugin(): Plugin {
  let operationQueue: Promise<void> = Promise.resolve()
  function enqueue<T>(operation: () => Promise<T>) {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    name: 'kline-studio-local-private-sync',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(API_PATH, async (request, response) => {
        try {
          verifyLocalRequest(request)
          if (request.method === 'GET') {
            sendJson(response, 200, { ok: true, available: true, repository: `${REPOSITORY_OWNER}/${REPOSITORY_NAME}` })
            return
          }
          if (request.method !== 'POST') throw new HttpError(405, '只支持 GET 和 POST')
          const body = await readJsonRequest(request) as { action?: unknown; mode?: unknown; snapshot?: unknown; expectedHead?: unknown }
          if (body.action === 'receive') {
            sendJson(response, 200, await enqueue(receiveSync))
            return
          }
          const snapshot = workspaceFromUnknown(body.snapshot)
          const mode: SyncMode = body.mode === 'background' ? 'background' : 'manual'
          if (body.action === 'prepare') {
            sendJson(response, 200, await enqueue(() => prepareSync(snapshot, mode)))
            return
          }
          if (body.action === 'publish' && typeof body.expectedHead === 'string') {
            sendJson(response, 200, await enqueue(() => publishSync(body.expectedHead as string, snapshot, mode)))
            return
          }
          throw new HttpError(400, '未知同步操作')
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof Error ? error.message : '本机同步服务发生未知错误'
          const details = error instanceof HttpError ? error.details : undefined
          sendJson(response, status, { ok: false, error: message, ...(details ?? {}) })
        }
      })
    },
  }
}
