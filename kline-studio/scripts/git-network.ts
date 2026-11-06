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

export async function runGitNetwork(args: readonly string[], options: CommandOptions = {}) {
  let lastError: unknown
  let proxy: string | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const proxyEnvironment = proxy ? {
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
      } : undefined
      return await runFile('git', ['-c', 'http.connectTimeout=20', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=45', ...(proxy ? ['-c', `http.proxy=${proxy}`, '-c', 'http.version=HTTP/1.1'] : []), ...args], { ...options, env: { ...options.env, ...proxyEnvironment } })
    } catch (error) {
      lastError = error
      if (!transientGitNetworkError(error) || attempt === 2) throw error
      if (!proxy) proxy = await windowsSystemProxy()
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
}
