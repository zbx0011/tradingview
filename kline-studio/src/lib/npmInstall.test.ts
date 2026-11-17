import { describe, expect, it, vi } from 'vitest'
import { createNpmCiRunner, NPM_CI_TIMEOUT_MS, transientNpmInstallError } from '../../scripts/npm-install'

describe('bounded npm ci for isolated code validation', () => {
  it('runs a real cache-preferred ci without audit and returns successful output', async () => {
    const result = { stdout: 'added 100 packages', stderr: '' }
    const run = vi.fn(async () => result)
    const delay = vi.fn(async () => {})
    expect(await createNpmCiRunner({ run, delay })('C:/isolated-checkout')).toBe(result)
    expect(run).toHaveBeenCalledExactlyOnceWith([
      'ci', '--prefer-offline', '--no-audit', '--no-fund',
      '--fetch-retries=1', '--fetch-timeout=30000',
      '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000',
    ], 'C:/isolated-checkout', NPM_CI_TIMEOUT_MS)
    expect(delay).not.toHaveBeenCalled()
  })

  it.each(['ECONNRESET downloading package.tgz', 'Client network socket disconnected before secure TLS connection was established', 'Exit handler never called!', 'npm ci 运行超时（300 秒）'])(
    'retries a transient install failure once: %s', async (message) => {
      const result = { stdout: 'installed', stderr: '' }
      const run = vi.fn().mockRejectedValueOnce(new Error(message)).mockResolvedValueOnce(result)
      const delay = vi.fn(async () => {})
      expect(await createNpmCiRunner({ run, delay })('checkout')).toBe(result)
      expect(run).toHaveBeenCalledTimes(2)
      expect(run.mock.calls[1]).toEqual(run.mock.calls[0])
      expect(delay).toHaveBeenCalledExactlyOnceWith(750)
    },
  )

  it('stops after the second network failure and preserves the final error as its cause', async () => {
    const cause = new Error('npm error ECONNRESET registry.npmmirror.com package.tgz')
    const run = vi.fn(async () => { throw cause })
    const delay = vi.fn(async () => {})
    const error = await createNpmCiRunner({ run, delay })('checkout').catch((error: unknown) => error)
    expect(error).toMatchObject({ message: expect.stringContaining('npm ci 连续 2 次安装失败'), cause })
    expect(run).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledTimes(1)
  })

  it.each(['npm error EUSAGE: package-lock.json is not in sync', 'npm error ERESOLVE unable to resolve dependency tree', 'npm error SELF_SIGNED_CERT_IN_CHAIN', 'npm error EINTEGRITY checksum failed', 'npm error code 1: postinstall failed'])(
    'does not retry or hide a permanent validation failure: %s', async (message) => {
      const failure = new Error(message)
      const run = vi.fn(async () => { throw failure })
      const delay = vi.fn(async () => {})
      await expect(createNpmCiRunner({ run, delay })('checkout')).rejects.toBe(failure)
      expect(run).toHaveBeenCalledTimes(1)
      expect(delay).not.toHaveBeenCalled()
    },
  )

  it('does not treat npm exit-handler noise as retryable when the underlying error is a bad lock or certificate', () => {
    expect(transientNpmInstallError(new Error('npm error EUSAGE\nnpm error Exit handler never called!'))).toBe(false)
    expect(transientNpmInstallError(new Error('SELF_SIGNED_CERT_IN_CHAIN\nECONNRESET'))).toBe(false)
  })
})
