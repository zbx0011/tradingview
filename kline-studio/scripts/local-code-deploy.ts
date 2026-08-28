import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'

const API_PATH = '/__kline_studio_code_deploy'
const EXPECTED_REMOTE = 'https://github.com/zbx0011/tradingview'
const EXPECTED_BRANCH = 'master'
const MAX_OUTPUT_CHARS = 2_000_000

interface CommandResult {
  stdout: string
  stderr: string
}

interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

interface RepositoryState {
  repositoryRoot: string
  projectRoot: string
  projectRelativePath: string
  branch: string
  localHead: string
  remoteHead: string
  dirtyFiles: string[]
  clean: boolean
  updateAvailable: boolean
  aheadOfRemote: boolean
  diverged: boolean
}

class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly details?: Record<string, unknown>) {
    super(message)
  }
}

function runFile(command: string, args: readonly string[], options: CommandOptions = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: string) => (current + chunk).slice(-MAX_OUTPUT_CHARS)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${stderr.trim() || stdout.trim() || '没有错误输出'}`))
    })
  })
}

function normalizeRemote(value: string) {
  return value.trim().replace(/\.git$/i, '').replace(/^git@github\.com:/i, 'https://github.com/')
}

function npmInvocation(args: readonly string[]) {
  if (process.platform !== 'win32') return { command: 'npm', args }
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { command: process.execPath, args: [npmCli, ...args] }
}

async function runNpm(args: readonly string[], cwd: string) {
  const invocation = npmInvocation(args)
  return runFile(invocation.command, invocation.args, { cwd })
}

async function fetchRemote(repositoryRoot: string) {
  await runFile('git', ['fetch', 'origin', EXPECTED_BRANCH], { cwd: repositoryRoot })
}

async function repositoryState(fetchLatest = false): Promise<RepositoryState> {
  const projectRoot = path.resolve(process.cwd())
  const repositoryRoot = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd: projectRoot })).stdout.trim()
  const projectRelativePath = path.relative(repositoryRoot, projectRoot).replace(/\\/g, '/')
  if (!projectRelativePath || projectRelativePath.startsWith('../')) throw new HttpError(409, '当前 Kline Studio 不在有效 Git 仓库内')
  const remote = normalizeRemote((await runFile('git', ['remote', 'get-url', 'origin'], { cwd: repositoryRoot })).stdout)
  if (remote !== EXPECTED_REMOTE) throw new HttpError(409, `origin 不是指定公开仓库：${remote}`)
  const branch = (await runFile('git', ['branch', '--show-current'], { cwd: repositoryRoot })).stdout.trim()
  if (branch !== EXPECTED_BRANCH) throw new HttpError(409, `当前分支是 ${branch || '游离状态'}，只允许在 ${EXPECTED_BRANCH} 部署`)
  if (fetchLatest) await fetchRemote(repositoryRoot)
  const localHead = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim()
  const remoteHead = (await runFile('git', ['rev-parse', `origin/${EXPECTED_BRANCH}`], { cwd: repositoryRoot })).stdout.trim()
  const dirtyFiles = (await runFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repositoryRoot })).stdout
    .split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean)
  const behindCount = Number((await runFile('git', ['rev-list', '--count', `${localHead}..${remoteHead}`], { cwd: repositoryRoot })).stdout.trim())
  const aheadCount = Number((await runFile('git', ['rev-list', '--count', `${remoteHead}..${localHead}`], { cwd: repositoryRoot })).stdout.trim())
  return {
    repositoryRoot,
    projectRoot,
    projectRelativePath,
    branch,
    localHead,
    remoteHead,
    dirtyFiles,
    clean: dirtyFiles.length === 0,
    updateAvailable: behindCount > 0 && aheadCount === 0,
    aheadOfRemote: aheadCount > 0 && behindCount === 0,
    diverged: aheadCount > 0 && behindCount > 0,
  }
}

function statusPath(line: string) {
  return line.slice(3).replace(/^"|"$/g, '')
}

function assertOnlyProjectChanges(state: RepositoryState) {
  const prefix = `${state.projectRelativePath}/`
  const outside = state.dirtyFiles.filter((line) => statusPath(line).split(' -> ').some((file) => file !== state.projectRelativePath && !file.startsWith(prefix)))
  if (outside.length > 0) {
    throw new HttpError(409, '仓库存在 Kline Studio 以外的修改，已停止发布', { dirtyFiles: outside })
  }
}

async function validateProject(projectRoot: string) {
  await runNpm(['ci'], projectRoot)
  await runNpm(['test', '--', '--run'], projectRoot)
  await runNpm(['run', 'lint'], projectRoot)
  await runNpm(['run', 'build'], projectRoot)
}

async function validateCommitInTemporaryWorktree(state: RepositoryState, commit: string) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kline-studio-code-validate-'))
  const worktree = path.join(temporaryRoot, 'checkout')
  let added = false
  try {
    await runFile('git', ['worktree', 'add', '--detach', worktree, commit], { cwd: state.repositoryRoot })
    added = true
    await validateProject(path.join(worktree, state.projectRelativePath))
  } finally {
    if (added) await runFile('git', ['worktree', 'remove', '--force', worktree], { cwd: state.repositoryRoot }).catch(() => undefined)
    const temporaryBase = path.resolve(os.tmpdir()) + path.sep
    if (path.resolve(temporaryRoot).startsWith(temporaryBase)) await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function createCandidateCommit(state: RepositoryState, message: string) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kline-studio-code-index-'))
  const indexFile = path.join(temporaryRoot, 'index')
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    await runFile('git', ['read-tree', 'HEAD'], { cwd: state.repositoryRoot, env })
    await runFile('git', ['add', '--all', '--', state.projectRelativePath], { cwd: state.repositoryRoot, env })
    const tree = (await runFile('git', ['write-tree'], { cwd: state.repositoryRoot, env })).stdout.trim()
    return (await runFile('git', ['commit-tree', tree, '-p', state.localHead, '-m', message], { cwd: state.repositoryRoot, env })).stdout.trim()
  } finally {
    const temporaryBase = path.resolve(os.tmpdir()) + path.sep
    if (path.resolve(temporaryRoot).startsWith(temporaryBase)) await fs.rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function publishCode() {
  let state = await repositoryState(true)
  if (state.diverged || state.updateAvailable) {
    throw new HttpError(409, '远程 master 已更新，当前仓库不能安全快进发布；未修改或推送任何文件')
  }
  assertOnlyProjectChanges(state)
  await runFile('git', ['diff', '--check'], { cwd: state.repositoryRoot })
  if (!state.clean) {
    const stamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    const message = `deploy: publish Kline Studio ${stamp}`
    const candidateCommit = await createCandidateCommit(state, message)
    await validateCommitInTemporaryWorktree(state, candidateCommit)
    await runFile('git', ['add', '--all', '--', state.projectRelativePath], { cwd: state.repositoryRoot })
    await runFile('git', ['diff', '--cached', '--check'], { cwd: state.repositoryRoot })
    const staged = (await runFile('git', ['diff', '--cached', '--name-only'], { cwd: state.repositoryRoot })).stdout.trim()
    if (!staged) throw new HttpError(409, '没有可发布的 Kline Studio 代码变更')
    await runFile('git', ['commit', '-m', message], { cwd: state.repositoryRoot })
  }
  state = await repositoryState(false)
  if (state.diverged || state.updateAvailable) throw new HttpError(409, '推送前发现远程已更新，已停止发布')
  await runFile('git', ['push', 'origin', `HEAD:${EXPECTED_BRANCH}`], { cwd: state.repositoryRoot })
  await fetchRemote(state.repositoryRoot)
  const verified = await repositoryState(false)
  if (verified.localHead !== verified.remoteHead) throw new HttpError(500, '公开仓库回读提交号不一致，未报告部署成功')
  return {
    ok: true,
    action: 'publish-code',
    commit: verified.localHead,
    branch: verified.branch,
    repository: EXPECTED_REMOTE,
    verified: true,
  }
}

function scheduleRestart(response: ServerResponse, projectRoot: string, port: number, expectedCommit: string) {
  const helper = path.join(projectRoot, 'scripts', 'restart-after-code-update.ps1')
  response.once('finish', () => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-ProjectDirectory', projectRoot,
      '-Port', String(port),
      '-ParentPid', String(process.pid),
      '-ExpectedCommit', expectedCommit,
    ], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    setTimeout(() => process.exit(0), 900)
  })
}

async function updateCode() {
  const state = await repositoryState(true)
  if (!state.clean) throw new HttpError(409, '当前代码工作区不干净，已停止更新，不会覆盖本机修改', { dirtyFiles: state.dirtyFiles })
  if (state.diverged || state.aheadOfRemote) throw new HttpError(409, '当前代码不能快进到远程 master，已停止更新')
  if (state.localHead === state.remoteHead) {
    return { ok: true, action: 'update-code', commit: state.localHead, updated: false, restartRequired: false, projectRoot: state.projectRoot }
  }
  await validateCommitInTemporaryWorktree(state, state.remoteHead)
  await runFile('git', ['merge', '--ff-only', `origin/${EXPECTED_BRANCH}`], { cwd: state.repositoryRoot })
  await runNpm(['ci'], state.projectRoot)
  const updated = await repositoryState(false)
  if (!updated.clean || updated.localHead !== state.remoteHead) throw new HttpError(500, '更新后代码状态校验失败，已停止自动重启')
  return { ok: true, action: 'update-code', commit: updated.localHead, updated: true, restartRequired: true, projectRoot: updated.projectRoot }
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
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') throw new HttpError(403, '代码部署接口只接受 localhost 请求')
  const origin = String(request.headers.origin ?? '')
  if (origin !== `http://${host}` || request.headers['x-kline-studio-deploy'] !== '1') throw new HttpError(403, '代码部署请求来源校验失败')
}

async function readRequest(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as { action?: unknown }
  } catch {
    throw new HttpError(400, '代码部署请求不是有效 JSON')
  }
}

export function localCodeDeployPlugin(): Plugin {
  let operationQueue: Promise<void> = Promise.resolve()
  function enqueue<T>(operation: () => Promise<T>) {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(() => undefined, () => undefined)
    return result
  }
  return {
    name: 'kline-studio-local-code-deploy',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(API_PATH, async (request, response) => {
        try {
          verifyLocalRequest(request)
          if (request.method !== 'POST') throw new HttpError(405, '只支持 POST')
          const body = await readRequest(request)
          if (body.action === 'status') {
            const state = await enqueue(() => repositoryState(true))
            sendJson(response, 200, { ok: true, action: 'status', ...state })
            return
          }
          if (body.action === 'publish-code') {
            sendJson(response, 200, await enqueue(publishCode))
            return
          }
          if (body.action === 'update-code') {
            const result = await enqueue(updateCode)
            if (result.restartRequired) scheduleRestart(response, result.projectRoot, server.config.server.port ?? 4173, result.commit)
            sendJson(response, 200, result)
            return
          }
          throw new HttpError(400, '未知代码部署操作')
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          const message = error instanceof Error ? error.message : '本机代码部署服务发生未知错误'
          const details = error instanceof HttpError ? error.details : undefined
          sendJson(response, status, { ok: false, error: message, ...(details ?? {}) })
        }
      })
    },
  }
}
