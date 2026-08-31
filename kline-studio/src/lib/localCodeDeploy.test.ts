import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalCodeDeployUnavailableError, loadLocalCodeStatus, publishLocalCode, updateLocalCode } from './localCodeDeploy'

afterEach(() => vi.unstubAllGlobals())

describe('local code deployment client', () => {
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
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await expect(updateLocalCode()).resolves.toMatchObject({ commit: 'updated-sha', restartRequired: true })
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
})
