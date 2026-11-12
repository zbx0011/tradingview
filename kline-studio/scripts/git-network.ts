import { spawn } from 'node:child_process'
interface CommandResult { stdout: string; stderr: string }
interface CommandOptions { cwd?: string; input?: string; env?: NodeJS.ProcessEnv }
function runFile(command: string, args: readonly string[], options: CommandOptions = {}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      windowsHide: true,
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} 失败（退出码 ${code}）：${stderr.trim() || '没有错误输出'}`))
    })
    if (options.input) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

export function transientGitNetworkError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/certificate problem|certificate verify|untrusted.root|CERT_E_|expired certificate/i.test(message)) return false
  return /failed to connect|could not resolve host|connection (?:was )?reset|network is unreachable|operation timed out|http (?:5\d\d|429)|rpc failed|schannel|handshake|SSL\/TLS|SSL_connect|TLS connection|empty reply|could not read from remote/i.test(message)
}

function normalizeProxyUrl(value: string) {
  const target = value.trim()
  if (!target) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`
}

async function windowsSystemProxy() {
  if (process.platform !== 'win32') return null
  try {
    const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enabled = await runFile('reg.exe', ['query', registryKey, '/v', 'ProxyEnable'])
    if (!/REG_DWORD\s+0x1(?:\s|$)/i.test(enabled.stdout)) return null
    const configured = await runFile('reg.exe', ['query', registryKey, '/v', 'ProxyServer'])
    const match = configured.stdout.match(/ProxyServer\s+REG_SZ\s+(.+)$/im)
    if (!match) return null
    const raw = match[1].trim()
    const entries = new Map(raw.split(';').flatMap((entry) => {
      const separator = entry.indexOf('=')
      return separator > 0 ? [[entry.slice(0, separator).trim().toLowerCase(), entry.slice(separator + 1).trim()] as const] : []
    }))
    return normalizeProxyUrl(entries.get('https') ?? entries.get('http') ?? (entries.size === 0 ? raw : ''))
  } catch {
    return null
  }
}

interface NetworkDependencies {
  run: typeof runFile
  proxy: () => Promise<string | null>
  delay: (ms: number) => Promise<void>
}

/** Per-command fallbacks only: no changes to Git/global proxy or certificate verification. */
export function createGitNetworkRunner(dependencies: NetworkDependencies) {
  let lastGoodRoute: string | null = null
  return async (args: readonly string[], options: CommandOptions = {}) => {
    const proxy = await dependencies.proxy()
    const routes: { id: string; proxy?: string; tls12?: boolean }[] = proxy
      ? [{ id: 'system', proxy }, { id: 'system-tls12', proxy, tls12: true }]
      : []
    if (proxy) {
      const url = new URL(proxy)
      // Local mixed-port proxies can also tunnel via SOCKS, independently of HTTP CONNECT.
      if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
        routes.push({ id: 'local-socks', proxy: `socks5h://${url.host}` })
      }
    }
    routes.push({ id: 'configured' }, { id: 'direct', proxy: '' })
    const preferred = routes.findIndex(route => route.id === lastGoodRoute)
    if (preferred > 0) routes.unshift(...routes.splice(preferred, 1))
    let lastError: unknown
    for (let index = 0; index < routes.length; index += 1) {
      const route = routes[index]
      const config = ['-c', 'http.version=HTTP/1.1', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=45']
      if (route.proxy !== undefined) config.push('-c', `http.proxy=${route.proxy}`)
      if (route.tls12) config.push('-c', 'http.sslVersion=tlsv1.2')
      const env = route.proxy === undefined ? options.env : {
        ...options.env, HTTP_PROXY: route.proxy, HTTPS_PROXY: route.proxy,
        http_proxy: route.proxy, https_proxy: route.proxy, ALL_PROXY: '', all_proxy: '', NO_PROXY: '', no_proxy: '',
      }
      try {
        const result = await dependencies.run('git', [...config, ...args], { ...options, env })
        lastGoodRoute = route.id
        return result
      } catch (error) {
        lastError = error
        if (!transientGitNetworkError(error)) throw error
        if (index < routes.length - 1) await dependencies.delay(500)
      }
    }
    throw lastError
  }
}

export const runGitNetwork = createGitNetworkRunner({
  run: runFile,
  proxy: windowsSystemProxy,
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
})
