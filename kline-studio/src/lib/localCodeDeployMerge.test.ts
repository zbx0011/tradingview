import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { mergeCandidateWithRemote } from '../../scripts/local-code-deploy'

let tempRoot = ''
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}).trim()

async function repository() {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kline-deploy-git-test-'))
  git(tempRoot, 'init', '-b', 'master')
  git(tempRoot, 'config', 'user.name', 'Deployment Test')
  git(tempRoot, 'config', 'user.email', 'test@example.invalid')
  git(tempRoot, 'config', 'core.autocrlf', 'false')
  await mkdir(path.join(tempRoot, 'project'))
  await writeFile(path.join(tempRoot, 'project', 'base.txt'), 'base\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'base')
  git(tempRoot, 'checkout', '-b', 'remote')
  return { project: path.join(tempRoot, 'project') }
}

afterEach(async () => {
  if (tempRoot && path.dirname(tempRoot) === path.resolve(os.tmpdir())) {
    await rm(tempRoot, { recursive: true, force: true })
  }
  tempRoot = ''
})

it('merges divergent local commits and a snapshot of pending local changes without altering the live checkout', async () => {
  const { project } = await repository()
  await writeFile(path.join(project, 'remote.txt'), 'remote change\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'remote change')
  const remoteHead = git(tempRoot, 'rev-parse', 'HEAD')
  git(tempRoot, 'checkout', 'master')
  await writeFile(path.join(project, 'local.txt'), 'local committed\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'local commit')
  const localHead = git(tempRoot, 'rev-parse', 'HEAD')
  await writeFile(path.join(project, 'local.txt'), 'local uncommitted\n')
  await writeFile(path.join(project, 'untracked.txt'), 'new local file\n')
  const temporaryIndex = path.join(tempRoot, 'candidate-index')
  const candidateGit = (...args: string[]) => execFileSync('git', args, { cwd: tempRoot, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } }).trim()
  candidateGit('read-tree', 'HEAD')
  candidateGit('add', '--all', '--', 'project')
  const tree = candidateGit('write-tree')
  const candidate = candidateGit('commit-tree', tree, '-p', localHead, '-m', 'snapshot')
  const beforeStatus = git(tempRoot, 'status', '--porcelain')
  let validated = false
  const merged = await mergeCandidateWithRemote({ repositoryRoot: tempRoot, projectRelativePath: 'project', remoteHead }, candidate, async (checkoutProject: string) => {
    expect(await readFile(path.join(checkoutProject, 'remote.txt'), 'utf8')).toBe('remote change\n')
    expect(await readFile(path.join(checkoutProject, 'local.txt'), 'utf8')).toBe('local uncommitted\n')
    expect(await readFile(path.join(checkoutProject, 'untracked.txt'), 'utf8')).toBe('new local file\n')
    validated = true
  })
  expect(validated).toBe(true)
  expect(git(tempRoot, 'rev-parse', `${merged}^1`)).toBe(candidate)
  expect(git(tempRoot, 'rev-parse', `${merged}^2`)).toBe(remoteHead)
  expect(git(tempRoot, 'rev-parse', 'HEAD')).toBe(localHead)
  expect(git(tempRoot, 'status', '--porcelain')).toBe(beforeStatus)
  expect(await readFile(path.join(project, 'local.txt'), 'utf8')).toBe('local uncommitted\n')
  expect(await readFile(path.join(project, 'untracked.txt'), 'utf8')).toBe('new local file\n')
}, 30000)

it('rejects conflicting changes while preserving the original checkout', async () => {
  const { project } = await repository()
  await writeFile(path.join(project, 'base.txt'), 'remote\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'remote edit')
  const remoteHead = git(tempRoot, 'rev-parse', 'HEAD')
  git(tempRoot, 'checkout', 'master')
  await writeFile(path.join(project, 'base.txt'), 'local\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'local edit')
  const localHead = git(tempRoot, 'rev-parse', 'HEAD')
  const status = git(tempRoot, 'status', '--porcelain')
  let validated = false
  await expect(mergeCandidateWithRemote({ repositoryRoot: tempRoot, projectRelativePath: 'project', remoteHead }, localHead, async () => { validated = true })).rejects.toThrow()
  expect(validated).toBe(false)
  expect(git(tempRoot, 'rev-parse', 'HEAD')).toBe(localHead)
  expect(git(tempRoot, 'status', '--porcelain')).toBe(status)
  expect(await readFile(path.join(project, 'base.txt'), 'utf8')).toBe('local\n')
}, 30000)

it('keeps the live checkout intact when validation of a clean merge fails', async () => {
  const { project } = await repository()
  await writeFile(path.join(project, 'remote.txt'), 'remote\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'remote edit')
  const remoteHead = git(tempRoot, 'rev-parse', 'HEAD')
  git(tempRoot, 'checkout', 'master')
  await writeFile(path.join(project, 'local.txt'), 'local\n')
  git(tempRoot, 'add', '.')
  git(tempRoot, 'commit', '-m', 'local edit')
  const localHead = git(tempRoot, 'rev-parse', 'HEAD')
  await expect(mergeCandidateWithRemote({ repositoryRoot: tempRoot, projectRelativePath: 'project', remoteHead }, localHead, async () => {
    throw new Error('validation failed')
  })).rejects.toThrow('validation failed')
  expect(git(tempRoot, 'rev-parse', 'HEAD')).toBe(localHead)
  expect(git(tempRoot, 'status', '--porcelain')).toBe('')
  expect(await readFile(path.join(project, 'local.txt'), 'utf8')).toBe('local\n')
}, 30000)
