/** Keep a failed registry connection from blocking a local publish indefinitely. */
export const NPM_CI_TIMEOUT_MS = 300_000
const NPM_CI_ARGS = [
  'ci', '--prefer-offline', '--no-audit', '--no-fund',
  '--fetch-retries=1', '--fetch-timeout=30000',
  '--fetch-retry-mintimeout=1000', '--fetch-retry-maxtimeout=5000',
] as const

export function transientNpmInstallError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  // Retrying cannot fix invalid lockfiles, permissions, dependency conflicts or trust failures.
  if (/EUSAGE|ELOCKVERIFY|EINTEGRITY|ERESOLVE|EBADENGINE|EACCES|EPERM|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|ERR_TLS_CERT_ALTNAME_INVALID|certificate (?:has expired|verify failed|verification failed)|unable to get local issuer certificate/i.test(message)) return false
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|ECONNREFUSED|EHOSTUNREACH|EPIPE|socket hang up|client network socket disconnected|fetch failed|Exit handler never called|HTTP\s+(?:429|5\d\d)|运行超时/i.test(message)
}

interface NpmInstallDependencies<T> {
  /** The actual npm runner must enforce timeoutMs; neither attempt bypasses npm ci. */
  run: (args: readonly string[], cwd: string, timeoutMs: number) => Promise<T>
  delay: (ms: number) => Promise<void>
}

/** One retry for a transient failure; inherit the configured route and keep TLS verification enabled. */
export function createNpmCiRunner<T>(dependencies: NpmInstallDependencies<T>) {
  return async (cwd: string): Promise<T> => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        return await dependencies.run(NPM_CI_ARGS, cwd, NPM_CI_TIMEOUT_MS)
      } catch (error) {
        if (!transientNpmInstallError(error)) throw error
        if (attempt === 2) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`npm ci 连续 2 次安装失败：${message}`, { cause: error })
        }
        await dependencies.delay(750)
      }
    }
    throw new Error('npm ci 未完成')
  }
}
