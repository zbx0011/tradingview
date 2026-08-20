export const PORTABLE_WORKSPACE_APP = 'kline-studio'
export const PORTABLE_WORKSPACE_VERSION = 1 as const
export const PORTABLE_STORAGE_PREFIX = 'kline-studio-'
export const PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY = 'kline-studio-workspace-import-recovery-v1'

export interface PortableWorkspace {
  app: typeof PORTABLE_WORKSPACE_APP
  version: typeof PORTABLE_WORKSPACE_VERSION
  exportedAt: string
  entries: Record<string, string>
}

export interface StorageLike {
  length: number
  key: (index: number) => string | null
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

function isPortableDataKey(key: string) {
  return key.startsWith(PORTABLE_STORAGE_PREFIX) && key !== PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY
}

function browserStorage(): StorageLike | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function collectPortableWorkspace(storage: StorageLike | undefined = browserStorage()): PortableWorkspace {
  const entries: Record<string, string> = {}
  if (storage) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key || !isPortableDataKey(key)) continue
      const value = storage.getItem(key)
      if (value !== null) entries[key] = value
    }
  }
  return {
    app: PORTABLE_WORKSPACE_APP,
    version: PORTABLE_WORKSPACE_VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  }
}

export function serializePortableWorkspace(workspace: PortableWorkspace): string {
  return JSON.stringify(workspace, null, 2)
}

export function parsePortableWorkspace(raw: string): PortableWorkspace | null {
  try {
    const value = JSON.parse(raw) as Partial<PortableWorkspace>
    if (value.app !== PORTABLE_WORKSPACE_APP || value.version !== PORTABLE_WORKSPACE_VERSION || !isRecord(value.entries)) return null
    const entries: Record<string, string> = {}
    for (const [key, item] of Object.entries(value.entries)) {
      if (!key.startsWith(PORTABLE_STORAGE_PREFIX) || typeof item !== 'string') return null
      if (key === PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY) continue
      entries[key] = item
    }
    return {
      app: PORTABLE_WORKSPACE_APP,
      version: PORTABLE_WORKSPACE_VERSION,
      exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : new Date().toISOString(),
      entries,
    }
  } catch {
    return null
  }
}

/** Replace all app-owned browser state with a previously exported snapshot. */
export function restorePortableWorkspace(workspace: PortableWorkspace, storage: StorageLike | undefined = browserStorage()): number {
  if (!storage) return 0
  const importedKeys = new Set(Object.keys(workspace.entries))
  const existingKeys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key && isPortableDataKey(key)) existingKeys.push(key)
  }
  for (const key of existingKeys) {
    if (!importedKeys.has(key)) storage.removeItem(key)
  }
  for (const [key, value] of Object.entries(workspace.entries)) storage.setItem(key, value)
  return Object.keys(workspace.entries).length
}

/** Keep a browser-local rollback point before any import or merge mutates app data. */
export function savePortableWorkspaceRecovery(workspace: PortableWorkspace, storage: StorageLike | undefined = browserStorage()) {
  if (!storage) return false
  storage.setItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY, serializePortableWorkspace(workspace))
  return true
}

export function loadPortableWorkspaceRecovery(storage: StorageLike | undefined = browserStorage()) {
  if (!storage) return null
  const raw = storage.getItem(PORTABLE_WORKSPACE_RECOVERY_STORAGE_KEY)
  return raw ? parsePortableWorkspace(raw) : null
}

/** Replace app data while retaining an automatic rollback point; roll back immediately on write failure. */
export function restorePortableWorkspaceSafely(workspace: PortableWorkspace, storage: StorageLike | undefined = browserStorage()) {
  if (!storage) return 0
  const before = collectPortableWorkspace(storage)
  savePortableWorkspaceRecovery(before, storage)
  try {
    return restorePortableWorkspace(workspace, storage)
  } catch (error) {
    restorePortableWorkspace(before, storage)
    savePortableWorkspaceRecovery(before, storage)
    throw error
  }
}

/** Swap the current workspace with the last automatic rollback point, so undoing is itself reversible. */
export function restorePortableWorkspaceRecovery(storage: StorageLike | undefined = browserStorage()) {
  if (!storage) return 0
  const recovery = loadPortableWorkspaceRecovery(storage)
  if (!recovery) return 0
  const current = collectPortableWorkspace(storage)
  try {
    const count = restorePortableWorkspace(recovery, storage)
    savePortableWorkspaceRecovery(current, storage)
    return count
  } catch (error) {
    restorePortableWorkspace(current, storage)
    savePortableWorkspaceRecovery(recovery, storage)
    throw error
  }
}

export function downloadPortableWorkspace(workspace: PortableWorkspace, fileName = 'kline-studio-workspace.json') {
  if (typeof document === 'undefined') return
  const blob = new Blob([serializePortableWorkspace(workspace)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
