import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocalCodeDeployUnavailableError, loadLocalCodeDeployActivity, loadLocalCodeHealth, loadLocalCodeStatus,
  isUpdatedCodeServerReady, publishLocalCode, saveLocalCodeDeployActivity, updateLocalCode,
  type LocalCodeStatus, type LocalCodeUpdateResult,
} from './localCodeDeploy'

afterEach(() => vi.unstubAllGlobals())

describe('local code deployment client', () => {
  it('uses the local-only health action to check a restarting service', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: 'health' })
      return new Response(JSON.stringify({ ok: true, action: 'health', localHead: 'updated-sha', serverInstanceId: 'new-service' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))
    await expect(loadLocalCodeHealth()).resolves.toMatchObject({ localHead: 'updated-sha', serverInstanceId: 'new-service' })
  })

  it('loads verified local and remote code state', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: 'status' })
      return new Response(JSON.stringify({
        ok: true,
        action: 'status',
        repositoryRoot: 'D:\\repo',
        projectRoot: 'D:\\repo\\kline-studio',
        projectRelativePath: 'kline-studio',
        branch: 'master',
        localHead: 'local',
        remoteHead: 'remote',
        localHeadTimestamp: '2026-08-31T09:00:00+08:00',
        remoteHeadTimestamp: '2026-08-31T09:05:00+08:00',
        dirtyFiles: [],
        clean: true,
        updateAvailable: true,
        aheadOfRemote: false,
        diverged: false,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(loadLocalCodeStatus()).resolves.toMatchObject({ localHead: 'local', remoteHead: 'remote', updateAvailable: true })
    expect(fetch).toHaveBeenCalledWith('/__kline_studio_code_deploy', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-Kline-Studio-Deploy': '1' }),
    }))
  })

  it('requires a verified commit after publishing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      action: 'publish-code',
      commit: 'published-sha',
      branch: 'master',
      repository: 'https://github.com/zbx0011/tradingview',
      verified: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(publishLocalCode()).resolves.toMatchObject({ commit: 'published-sha', verified: true })
  })

  it('reports whether an update requires a service restart', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      action: 'update-code',
      commit: 'updated-sha',
      updated: true,
      restartRequired: true,
      previousServerInstanceId: 'old-service',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).resolves.toMatchObject({ commit: 'updated-sha', restartRequired: true, previousServerInstanceId: 'old-service' })
  })

  it('rejects restart responses from an old backend that cannot identify the running service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, action: 'update-code', commit: 'updated-sha', updated: true, restartRequired: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).rejects.toThrow('部署服务需要重启后再更新')
  })

  it('does not require a new service identity when no restart is needed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, action: 'update-code', commit: 'current-sha', updated: false, restartRequired: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).resolves.toMatchObject({ commit: 'current-sha', updated: false, restartRequired: false })
  })

  it('supports retrying a restart after the code has already been updated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true, action: 'update-code', commit: 'current-sha', updated: false, restartRequired: true,
      previousServerInstanceId: 'old-service',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).resolves.toMatchObject({ commit: 'current-sha', updated: false, restartRequired: true })
  })

  it('waits for the new service rather than mistaking an updated Git HEAD for a completed restart', () => {
    const result: LocalCodeUpdateResult = {
      ok: true, action: 'update-code', commit: 'updated-sha', updated: true, restartRequired: true,
      previousServerInstanceId: 'old-service',
    }
    const status = {
      ok: true, action: 'status', repositoryRoot: 'D:\\repo', projectRoot: 'D:\\repo\\kline-studio',
      projectRelativePath: 'kline-studio', branch: 'master', localHead: 'updated-sha', remoteHead: 'updated-sha',
      localHeadTimestamp: '2026-11-04T06:00:00Z', remoteHeadTimestamp: '2026-11-04T06:00:00Z',
      clean: true, dirtyFiles: [], updateAvailable: false, aheadOfRemote: false, diverged: false,
      serverInstanceId: 'old-service',
    } satisfies LocalCodeStatus

    expect(isUpdatedCodeServerReady(status, result)).toBe(false)
    expect(isUpdatedCodeServerReady({ ...status, serverInstanceId: '' }, result)).toBe(false)
    expect(isUpdatedCodeServerReady({ ...status, serverInstanceId: 'new-service', localHead: 'wrong-sha' }, result)).toBe(false)
    expect(isUpdatedCodeServerReady({ ...status, serverInstanceId: 'new-service' }, result)).toBe(true)
  })

  it('surfaces dirty-worktree details without hiding the protected files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: '当前代码工作区不干净',
      dirtyFiles: [' M kline-studio/src/App.tsx'],
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).rejects.toThrow('当前代码工作区不干净： M kline-studio/src/App.tsx')
  })

  it('distinguishes an unreachable local service from a backend operation error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(loadLocalCodeStatus()).rejects.toBeInstanceOf(LocalCodeDeployUnavailableError)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: 'git fetch origin master 失败',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } })))
    await expect(loadLocalCodeStatus()).rejects.not.toBeInstanceOf(LocalCodeDeployUnavailableError)
    await expect(loadLocalCodeStatus()).rejects.toThrow('git fetch origin master 失败')
  })

  it('treats a non-JSON endpoint response as an unavailable deployment service', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 404 })))
    await expect(loadLocalCodeStatus()).rejects.toBeInstanceOf(LocalCodeDeployUnavailableError)
  })

  it('persists the latest successful local code sync audit separately from workspace history', () => {
    let saved = ''
    const storage = {
      getItem: () => saved || null,
      setItem: (_key: string, value: string) => { saved = value },
    }
    const activity = {
      lastVerifiedAt: '2026-08-31T10:00:00+08:00',
      lastSuccessfulSync: { action: 'publish' as const, at: '2026-08-31T09:59:00+08:00', commit: 'abc1234' },
    }
    saveLocalCodeDeployActivity(activity, storage)
    expect(loadLocalCodeDeployActivity(storage)).toEqual(activity)
  })
})
