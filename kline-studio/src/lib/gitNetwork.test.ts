import { describe, expect, it } from 'vitest'
import { transientGitNetworkError, createGitNetworkRunner } from '../../scripts/git-network'
describe('Git network retry classification', () => {
  it('retries TLS handshake failures and network interruptions', () => {
    for (const message of ['schannel: failed to receive handshake, SSL/TLS connection failed', 'OpenSSL SSL_connect: Connection reset', 'Could not resolve host', 'HTTP 503', 'RPC failed']) expect(transientGitNetworkError(new Error(message))).toBe(true)
  })
  it('does not retry authentication, repository conflicts or certificate trust failures', () => {
    for (const message of ['Authentication failed', 'non-fast-forward', 'repository not found', 'SSL certificate problem: unable to get local issuer certificate']) expect(transientGitNetworkError(new Error(message))).toBe(false)
  })
})

it('changes transport after TLS failures and remembers the successful route', async () => {
  const calls: string[][] = []
  const runner = createGitNetworkRunner({
    proxy: async () => 'http://127.0.0.1:7890', delay: async () => {},
    run: async (_command, args) => {
      calls.push([...args])
      if (!args.includes('http.proxy=socks5h://127.0.0.1:7890')) throw new Error('schannel: failed to receive handshake')
      return { stdout: 'ok', stderr: '' }
    },
  })
  await runner(['fetch', 'origin', 'main'])
  expect(calls).toHaveLength(3)
  expect(calls[1]).toContain('http.sslVersion=tlsv1.2')
  await runner(['push', 'origin', 'main'])
  expect(calls).toHaveLength(4)
  expect(calls[3]).toContain('http.proxy=socks5h://127.0.0.1:7890')
  expect(calls.flat()).not.toContain('http.sslVerify=false')
})
it('does not retry authentication failures or untrusted certificates', async () => {
  for (const message of ['Authentication failed', 'schannel: SEC_E_UNTRUSTED_ROOT']) {
    let calls = 0
    const runner = createGitNetworkRunner({ proxy: async () => 'http://127.0.0.1:7890', delay: async () => {}, run: async () => { calls++; throw new Error(message) } })
    await expect(runner(['fetch', 'origin', 'main'])).rejects.toThrow(message)
    expect(calls).toBe(1)
  }
})
