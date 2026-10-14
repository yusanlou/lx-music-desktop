import { request } from '@common/utils/request'
import { type Readable } from 'node:stream'

export const SOURCE_REPOSITORY = 'Macrohard0001/lx-ikun-music-sources'
const API = `https://api.github.com/repos/${SOURCE_REPOSITORY}`
const WEB = `https://github.com/${SOURCE_REPOSITORY}`
export interface CatalogEntry { path: string, sha?: string, size?: number, directory?: boolean }

export const readRemote = async(url: string, limit: number): Promise<string> => {
  const signal = AbortSignal.timeout(20_000)
  const response = await request<Readable>(url, { needBody: true, timeout: 15_000, retryNum: 0, signal, headers: { Accept: 'application/json' } })
  const stream = response.body
  // Destroying an unread HTTP-error/oversized response can emit asynchronously.
  // The rejection is handled here; it must never become a process-level error.
  stream.on('error', () => {})
  try {
    if (response.statusCode !== 200) throw new Error(`catalog_http_${response.statusCode}`)
    if (Number(response.headers['content-length']) > limit) throw new Error('catalog_too_large')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk)
      length += buffer.length
      if (length > limit) throw new Error('catalog_too_large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { stream.destroy() }
}

export const selectEntries = (entries: CatalogEntry[]): CatalogEntry[] => {
  const unique = new Set<string>()
  const date = (entry: CatalogEntry) => Number(/(?:^|\/)v(\d{6})(?:\/|$)/i.exec(entry.path)?.[1] ?? 0)
  const priority = (entry: CatalogEntry) => /推荐|优质/.test(entry.path) ? 0 : /未测试|较差/.test(entry.path) ? 2 : 1
  return entries.filter(entry => /\.js$/i.test(entry.path) && !/(?:^|\/)\.{1,2}(?:\/|$)/.test(entry.path) &&
    !/付费|卡密|账号|自填|自备|自行配置|account|cookie|token|购买/i.test(entry.path) && (entry.size ?? 0) <= 2 * 1024 * 1024)
    .sort((a, b) => date(b) - date(a) || priority(a) - priority(b) || b.path.localeCompare(a.path, 'en', { numeric: true }))
    .filter(entry => {
      // Repeated dated folders often contain the same provider. Prefer newest.
      const name = entry.path.split('/').pop()!.toLowerCase()
      if (unique.has(name)) return false
      unique.add(name)
      return true
    }).slice(0, 16)
}

export const parseHtmlEntries = (html: string): CatalogEntry[] => {
  const entries: CatalogEntry[] = []
  const payloads = html.trimStart().startsWith('{') ? [html] : [...html.matchAll(/<script\b[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1])
  for (const payload of payloads) {
    let data: any
    try { data = JSON.parse(payload) } catch { continue }
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return
      if (typeof value.path === 'string' && (value.contentType === 'file' || value.contentType === 'directory')) {
        entries.push({ path: value.path, directory: value.contentType === 'directory' })
      }
      for (const item of Object.values(value)) {
        if (typeof item === 'object') visit(item)
      }
    }
    visit(data)
  }
  return entries
}

export const fetchCatalog = async(read = readRemote): Promise<CatalogEntry[]> => {
  try {
    const tree = JSON.parse(await read(`${API}/git/trees/main?recursive=1`, 4 * 1024 * 1024))
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('catalog_incomplete')
    const selected = selectEntries(tree.tree.filter((item: any) => item.type === 'blob'))
    if (!selected.length) throw new Error('catalog_empty')
    return selected
  } catch {
    // Anonymous GitHub API limits must not break an already cached radio pool.
    // The public tree pages are a bounded fallback; never download APK/archive.
    const root = parseHtmlEntries(await read(`${WEB}/tree/main`, 4 * 1024 * 1024))
    let folders = root.filter(item => item.directory && /^v\d+/i.test(item.path))
      .sort((a, b) => b.path.localeCompare(a.path, 'en', { numeric: true })).slice(0, 2)
    const entries = [...root]
    const visited = new Set<string>()
    for (let depth = 0; depth < 4 && folders.length && visited.size < 12; depth++) {
      folders = folders.filter(item => !visited.has(item.path)).slice(0, 12 - visited.size)
      for (const folder of folders) visited.add(folder.path)
      const nested = await Promise.allSettled(folders.map(async folder => parseHtmlEntries(await read(`${WEB}/tree/main/${folder.path.split('/').map(encodeURIComponent).join('/')}`, 4 * 1024 * 1024))))
      const children = nested.flatMap(item => item.status === 'fulfilled' ? item.value : [])
      entries.push(...children)
      folders = children.filter(item => item.directory)
      if (selectEntries(entries).length >= 16) break
    }
    const selected = selectEntries(entries)
    if (!selected.length) throw new Error('catalog_unavailable')
    return selected
  }
}

export const fetchScript = async(entry: CatalogEntry): Promise<string> => {
  // Raw file URLs avoid API quotas. The content digest is checked by the cache;
  // the catalog SHA is only a revision hint, never used as an executable URL.
  return readRemote(`https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/main/${entry.path.split('/').map(encodeURIComponent).join('/')}`, 2 * 1024 * 1024)
}
