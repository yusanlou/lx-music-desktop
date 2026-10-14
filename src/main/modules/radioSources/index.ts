import fs from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { fetchCatalog, fetchScript } from './catalog'
import { RadioSourcePool, type RadioSourceRequest } from './pool'
import { probeSource, closeSourceProbes } from './runtime'
import { getUserApis, getScript } from '../userApi/utils'

const SYNC_INTERVAL = 6 * 60 * 60_000
const HEALTH_INTERVAL = 20 * 60_000
const pool = new RadioSourcePool(async(source, request, timeout) => {
  const script = source.path ? source.script : await getScript(source.id)
  if (!script) throw new Error('radio_source_missing_script')
  return probeSource({ ...source, script }, request, timeout)
})
let initialized: Promise<void> | null = null
let syncing: Promise<void> | null = null
let checking: Promise<void> | null = null
let timer: NodeJS.Timeout | null = null
let lastSync = 0
let lastHealth = 0
let syncRetryAt = 0
let catalogError = ''
let foreground = 0
let configuration = 0
const cacheFile = () => path.join(app.getPath('userData'), 'radio-sources.json')
let saving = Promise.resolve()
const persist = () => {
  const records = pool.sources.filter(source => source.path && source.script)
    .sort((a, b) => (b.healthyAt ?? 0) - (a.healthyAt ?? 0)).slice(0, 32)
  const data = JSON.stringify({ version: 1, lastSync, active: pool.active, sources: records })
  saving = saving.catch(() => {}).then(async() => {
    const file = cacheFile()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(`${file}.tmp`, data, { mode: 0o600 })
    await fs.rename(`${file}.tmp`, file)
  })
  void saving.catch(() => {})
}

const initialize = async() => {
  initialized ??= (async() => {
    try {
      const stat = await fs.stat(cacheFile())
      if (stat.size > 64 * 1024 * 1024) throw new Error('radio_cache_too_large')
      const data = JSON.parse(await fs.readFile(cacheFile(), 'utf8'))
      if (data.version === 1 && Array.isArray(data.sources)) {
        pool.merge(data.sources.filter((item: any) => typeof item.script === 'string' && item.script.length <= 2 * 1024 * 1024 &&
          item.id === `remote_${createHash('sha256').update(item.script).digest('hex')}`))
        pool.active = typeof data.active === 'string' ? data.active : ''
        lastSync = typeof data.lastSync === 'number' ? data.lastSync : 0
      }
    } catch { /* An unreadable cache cannot stop ordinary installed providers. */ }
  })()
  await initialized
  const installed = getUserApis()
  const selected = global.lx.appSetting['common.apiSource']
  pool.merge([...installed].sort((a, b) => a.id === selected ? -1 : b.id === selected ? 1 : 0))
  if (!pool.active && installed.some(source => source.id === selected)) pool.active = selected
  // Remove uninstalled sources but retain downloaded revisions for rollback.
  pool.sources = pool.sources.filter(source => source.path != null || installed.some(item => item.id === source.id))
}

const syncCatalog = async() => {
  if (syncing) return syncing
  syncing = (async() => {
    try {
      const entries = await fetchCatalog()
      let downloaded = 0
      // Download a few scripts concurrently. Playback can use completed entries
      // immediately instead of waiting for every catalog file to finish.
      for (let index = 0; index < entries.length && pool.enabled; index += 3) {
        await Promise.allSettled(entries.slice(index, index + 3).map(async entry => {
          if (entry.sha && pool.sources.some(source => source.path === entry.path && source.sha === entry.sha && source.script)) { downloaded++; return }
          try {
            const script = await fetchScript(entry)
            if (!/^\/\*[\s\S]*?\*\//.test(script.trimStart()) || !/\blx\b/.test(script)) return
            // Git blob hashes bind a tree entry to the downloaded bytes. A racing
            // upstream update is retried during the next sync, never mislabelled.
            if (entry.sha) {
              const bytes = Buffer.from(script)
              const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
              if (blob !== entry.sha) return
            }
            const id = `remote_${createHash('sha256').update(script).digest('hex')}`
            const name = /\*\s*@name\s+([^\r\n]+)/.exec(script)?.[1].trim() ?? entry.path.split('/').pop()!
            const family = name.replace(/v?\d+(?:\.\d+)+.*$/i, '').trim()
            if (pool.enabled) {
              pool.merge([{ id, path: entry.path, sha: entry.sha, name, family, discoveredAt: Date.now(), script }])
              downloaded++
            }
          } catch { /* A broken download doesn't discard a previously working revision. */ }
        }))
      }
      if (!downloaded) throw new Error('catalog_no_compatible_scripts')
      // Keep working revisions and a bounded set of new candidates.
      pool.sources = [...pool.sources.filter(source => source.path == null || source.id === pool.active),
        ...pool.sources.filter(source => source.path && source.healthyAt && source.id !== pool.active)
          .sort((a, b) => b.healthyAt! - a.healthyAt!).slice(0, 16),
        ...pool.sources.filter(source => source.path && !source.healthyAt && source.id !== pool.active).slice(-16)]
      lastSync = Date.now()
      catalogError = ''
      syncRetryAt = 0
      lastHealth = 0 // Newly downloaded revisions get a real audio check soon.
      persist()
    } catch { catalogError = 'catalog_unavailable'; syncRetryAt = Date.now() + 15 * 60_000 }
  })().finally(() => { syncing = null })
  return syncing
}

const checkHealth = async() => {
  if (checking != null || !pool.lastRequest || foreground > 0) return
  const request = pool.lastRequest
  checking = (async() => {
    let healthy = 0
    let attempted = 0
    // Verify active and standby revisions against the last real song. Requests
    // take priority; maintenance stops between providers when playback needs one.
    const sources = [...pool.sources].sort((a, b) => {
      if (a.id === pool.active) return -1
      if (b.id === pool.active) return 1
      // Test newly discovered revisions before revisiting known standbys.
      return (b.discoveredAt ?? 0) - (a.discoveredAt ?? 0)
    })
    for (const source of sources) {
      if (!pool.enabled || foreground || healthy >= 3 || ++attempted > 6) break
      try {
        await pool.probe(source, request)
        if (pool.enabled) pool.promoteRevision(source)
        healthy++
      } catch {}
    }
    lastHealth = Date.now()
    persist()
  })().finally(() => { checking = null })
  await checking
}

export const configureRadioSources = async(enabled: boolean) => {
  const revision = ++configuration
  pool.configure(enabled)
  if (timer) clearInterval(timer)
  timer = null
  if (!enabled) { closeSourceProbes(); return }
  const generation = pool.generation
  await initialize()
  if (!pool.enabled || generation !== pool.generation || revision !== configuration) return
  const maintenance = () => {
    if (!pool.enabled) return
    if (Date.now() - lastSync >= SYNC_INTERVAL && Date.now() >= syncRetryAt && !syncing) void syncCatalog()
    if (Date.now() - lastHealth >= HEALTH_INTERVAL && !checking) void checkHealth()
  }
  maintenance()
  // configure(false) can arrive while initialize is reading the disk.
  // eslint-disable-next-line require-atomic-updates
  timer = setInterval(maintenance, 60_000)
  timer.unref()
}

export const resolveRadioSource = async(request: RadioSourceRequest, refresh: boolean, failedUrl?: string, timeoutMs = 60_000) => {
  const budget = Number.isFinite(timeoutMs) ? Math.max(0, Math.min(65_000, timeoutMs)) : 60_000
  const deadline = Date.now() + budget
  if (!pool.enabled) throw new Error('radio_sources_disabled')
  if (!['kw', 'kg', 'wy', 'tx', 'mg'].includes(request.source) || request.action !== 'musicUrl' || !request.info?.musicInfo) throw new Error('radio_sources_invalid_request')
  await initialize()
  if (failedUrl) pool.reject(failedUrl)
  foreground++
  try {
    // A working installed/cached provider never waits for GitHub. Only the very
    // first run with an empty pool needs the initial catalog.
    if (!pool.sources.length) {
      const sync = syncCatalog()
      await new Promise<void>(resolve => {
        const interval = setInterval(() => { if (pool.sources.length || !pool.enabled) done() }, 100)
        const timeout = setTimeout(done, Math.max(0, Math.min(30_000, deadline - Date.now())))
        function done() { clearInterval(interval); clearTimeout(timeout); resolve() }
        void sync.finally(done)
      })
    }
    const result = await pool.resolve(request, refresh, deadline - Date.now())
    persist()
    return result
  } finally {
    foreground--
    if (!foreground && Date.now() - lastHealth >= HEALTH_INTERVAL) void checkHealth()
  }
}

export const getRadioSourcesStatus = () => ({ ...pool.status(), lastSync, lastHealth, catalogError })
export const observeRadioSourceRequest = async(request: RadioSourceRequest) => {
  if (!pool.enabled || !['kw', 'kg', 'wy', 'tx', 'mg'].includes(request.source)) return
  await initialize()
  pool.lastRequest = request
}
export const closeRadioSources = () => {
  configuration++
  pool.configure(false)
  closeSourceProbes()
  if (timer) clearInterval(timer)
  timer = null
}
