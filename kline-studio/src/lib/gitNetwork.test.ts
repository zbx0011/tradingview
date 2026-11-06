import { describe, expect, it } from 'vitest'
import { transientGitNetworkError } from '../../scripts/git-network'
describe('Git network retry classification', () => {
  it('retries TLS handshake failures and network interruptions', () => {
    for (const message of ['schannel: failed to receive handshake, SSL/TLS connection failed', 'OpenSSL SSL_connect: Connection reset', 'Could not resolve host', 'HTTP 503', 'RPC failed']) expect(transientGitNetworkError(new Error(message))).toBe(true)
  })
  it('does not retry authentication, repository conflicts or certificate trust failures', () => {
    for (const message of ['Authentication failed', 'non-fast-forward', 'repository not found', 'SSL certificate problem: unable to get local issuer certificate']) expect(transientGitNetworkError(new Error(message))).toBe(false)
  })
})
