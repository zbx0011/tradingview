import { describe, expect, it, vi } from 'vitest'
import {
  LocalSyncConflictError, localPrivateSyncAvailable, parseLocalSyncAutoMarker,
  prepareLocalPrivateSync, publishLocalPrivateSync, shouldSkipRecentBackgroundSync,
} from './localPrivateSync'
import type { PortableWorkspace } from './portableWorkspace'

const workspace: PortableWorkspace = {
  app: 'kline-studio',
  version: 1,
  exportedAt: '2026-08-21T00:00:00.000Z',
  entries: { 'kline-studio-decision-replay-v1': '{}' },
}

describe('local private repository sync client', () => {
  it('deduplicates the same background snapshot across tabs for one minute', () => {
    const marker = JSON.stringify({ fingerprint: 'same', commit: 'abc', savedAt: 1000 })
    expect(parseLocalSyncAutoMarker(marker)).toMatchObject({ fingerprint: 'same', commit: 'abc' })
    expect(shouldSkipRecentBackgroundSync(marker, 'same', 60_999)).toBe(true)
    expect(shouldSkipRecentBackgroundSync(marker, 'same', 61_000)).toBe(false)
    expect(shouldSkipRecentBackgroundSync(marker, 'changed', 2000)).toBe(false)
    expect(shouldSkipRecentBackgroundSync('{bad', 'same', 2000)).toBe(false)
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
      head: 'abc123',
      snapshots: [workspace],
    })
    expect(fetch).toHaveBeenCalledWith('/__kline_studio_sync', expect.objectContaining({ method: 'POST' }))
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
