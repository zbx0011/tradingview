import { describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_SYNC_INTERVAL_MS, LocalSyncConflictError, localPrivateSyncAvailable, parseLocalSyncAutoMarker,
  prepareLocalPrivateSync, publishLocalPrivateSync, receiveLocalPrivateSync, runWithLocalPrivateSyncLock, shouldSkipRecentBackgroundSync,
} from './localPrivateSync'
import type { PortableWorkspace } from './portableWorkspace'

const workspace: PortableWorkspace = {
  app: 'kline-studio',
  version: 1,
  exportedAt: '2026-08-21T00:00:00.000Z',
  entries: { 'kline-studio-decision-replay-v1': '{}' },
}

describe('local private repository sync client', () => {
  it('deduplicates the same background snapshot across tabs for one hour', () => {
    const marker = JSON.stringify({ fingerprint: 'same', commit: 'abc', savedAt: 1000 })
    expect(parseLocalSyncAutoMarker(marker)).toMatchObject({ fingerprint: 'same', commit: 'abc' })
    expect(BACKGROUND_SYNC_INTERVAL_MS).toBe(3_600_000)
    expect(shouldSkipRecentBackgroundSync(marker, 'same', 3_600_999)).toBe(true)
    expect(shouldSkipRecentBackgroundSync(marker, 'same', 3_601_000)).toBe(false)
    expect(shouldSkipRecentBackgroundSync(marker, 'changed', 2000)).toBe(false)
    expect(shouldSkipRecentBackgroundSync('{bad', 'same', 2000)).toBe(false)
  })

  it('lets another Edge tab skip when the cross-tab background lock is already held', async () => {
    const operation = vi.fn(async () => 'done')
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, callback) => callback(null)) } })
    await expect(runWithLocalPrivateSyncLock(operation)).resolves.toEqual({ acquired: false })
    expect(operation).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('detects whether the same-origin background sync service is available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, available: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(localPrivateSyncAvailable()).resolves.toBe(true)
    vi.unstubAllGlobals()
  })

  it('validates the private prepare response and backup snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      private: true,
      head: 'abc123',
      premerge: { path: 'backups/before.json', commit: 'abc123', sha256: 'deadbeef' },
      snapshots: [workspace],
      sourcePaths: ['backups/source.json'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(prepareLocalPrivateSync(workspace)).resolves.toMatchObject({
      private: true,
      deduplicated: false,
      head: 'abc123',
      snapshots: [workspace],
    })
    expect(fetch).toHaveBeenCalledWith('/__kline_studio_sync', expect.objectContaining({ method: 'POST' }))
    vi.unstubAllGlobals()
  })

  it('requires a verified local disk recovery before receiving private snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: 'receive', scope: 'workspace', snapshot: workspace })
      return new Response(JSON.stringify({
        ok: true,
        private: true,
        head: 'receive-head',
        snapshots: [workspace],
        sourcePaths: ['backups/merged/latest.json'],
        recovery: { path: 'C:\\recovery\\before-receive.json', sha256: 'recovery-sha' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(receiveLocalPrivateSync('workspace', workspace)).resolves.toMatchObject({
      private: true,
      head: 'receive-head',
      snapshots: [workspace],
      recovery: { sha256: 'recovery-sha' },
    })
    vi.unstubAllGlobals()
  })

  it('marks history-only receive and publish requests without changing the workspace schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { action: string; scope: string; snapshot?: PortableWorkspace }
      if (body.action === 'receive') {
        expect(body.scope).toBe('history')
        expect(body.snapshot).toEqual(workspace)
        return new Response(JSON.stringify({
          ok: true,
          private: true,
          head: 'history-head',
          snapshots: [workspace],
          sourcePaths: ['backups/history.json'],
          recovery: { path: 'C:\\recovery\\history.json', sha256: 'history-recovery-sha' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      expect(body).toMatchObject({ action: 'publish', scope: 'history' })
      return new Response(JSON.stringify({
        ok: true,
        private: true,
        path: 'backups/merged/history.json',
        latestPath: 'backups/merged/latest.json',
        commit: 'history-commit',
        sha256: 'workspace-sha',
        verifiedSha256: 'workspace-sha',
        submittedSha256: 'history-sha',
        verifiedSubmittedSha256: 'history-sha',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await expect(receiveLocalPrivateSync('history', workspace)).resolves.toMatchObject({
      head: 'history-head', recovery: { sha256: 'history-recovery-sha' },
    })
    await expect(publishLocalPrivateSync('history-head', workspace, 'manual', 'history')).resolves.toMatchObject({
      submittedSha256: 'history-sha',
    })
    vi.unstubAllGlobals()
  })

  it('accepts a server-side deduplicated background response without requiring another upload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      private: true,
      deduplicated: true,
      head: 'already-running',
      premerge: null,
      snapshots: [],
      sourcePaths: [],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(prepareLocalPrivateSync(workspace, 'background')).resolves.toMatchObject({
      deduplicated: true,
      premerge: null,
      snapshots: [],
    })
    vi.unstubAllGlobals()
  })

  it('turns a concurrent remote update into a retryable conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: '远端已更新',
      head: 'new-head',
      snapshots: [workspace],
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })))

    await expect(publishLocalPrivateSync('old-head', workspace)).rejects.toEqual(expect.objectContaining({
      name: 'Error',
      message: '远端已更新',
      head: 'new-head',
    } satisfies Partial<LocalSyncConflictError>))
    vi.unstubAllGlobals()
  })

  it('refuses to report success when the remote verification hash differs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      private: true,
      path: 'backups/merged/final.json',
      latestPath: 'backups/merged/latest.json',
      commit: 'commit',
      sha256: 'one',
      verifiedSha256: 'two',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(publishLocalPrivateSync('head', workspace)).rejects.toThrow('SHA-256 不一致')
    vi.unstubAllGlobals()
  })
})
