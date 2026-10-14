export interface RadioSource {
  id: string
  name: string
  path?: string
  sha?: string
  script?: string
  healthyAt?: number
  family?: string
  discoveredAt?: number
}
export interface RadioSourceRequest {
  source: string
  action: 'musicUrl'
  info: { type: string, musicInfo: Record<string, any> }
}
export interface RadioSourceResult { url: string, type: string, provider: string, duration?: number }
interface RadioSourceAttempt {
  provider: string
  name: string
  outcome: string
  reason?: string
  elapsedMs: number
  duration?: number
}

// This pool owns radio providers, not the user's normal source selection.
// A new revision is a candidate until a real, full-length audio probe succeeds.
export class RadioSourcePool {
  sources: RadioSource[] = []
  active = ''
  private readonly failures = new Map<string, { count: number, until: number }>()
  private readonly urls = new Map<string, { result: RadioSourceResult, expires: number }>()
  private readonly pending = new Map<string, Promise<RadioSourceResult>>()
  private readonly rejectedUrls = new Map<string, number>()
  private lastResolution: { source: string, song: string, attempts: RadioSourceAttempt[] } | null = null
  lastRequest: RadioSourceRequest | null = null
  enabled = false
  generation = 0

  constructor(private readonly resolveSource: (source: RadioSource, request: RadioSourceRequest, timeout: number) => Promise<RadioSourceResult>, private readonly now = Date.now) {}

  configure(enabled: boolean) {
    if (this.enabled === enabled) return
    this.enabled = enabled
    this.generation++
    this.urls.clear()
  }

  merge(sources: RadioSource[]) {
    const known = new Set(this.sources.map(source => source.id))
    for (const source of sources) {
      if (!known.has(source.id)) {
        this.sources.push(source)
        known.add(source.id)
      }
    }
  }

  private key(request: RadioSourceRequest) {
    const music = request.info.musicInfo
    return `${request.source}:${music.songmid ?? music.id}:${music.hash ?? music.copyrightId ?? ''}:${request.info.type}`
  }

  reject(url: string) {
    if (!url) return
    this.rejectedUrls.set(url, this.now() + 10 * 60_000)
    for (const [key, item] of this.urls) if (item.result.url === url) this.urls.delete(key)
  }

  async resolve(request: RadioSourceRequest, refresh = false, budget = 60_000): Promise<RadioSourceResult> {
    if (!this.enabled) throw new Error('radio_sources_disabled')
    this.lastRequest = request
    const key = this.key(request)
    const cached = this.urls.get(key)
    if (refresh && cached) this.reject(cached.result.url)
    if (!refresh && cached && cached.expires > this.now()) return cached.result
    // Refresh must not join a request that could still return the failed URL.
    const pendingKey = `${key}:${refresh ? 'refresh' : 'normal'}:${this.generation}:${budget}`
    const pending = this.pending.get(pendingKey)
    if (pending) return pending
    const generation = this.generation
    const promise = this.trySources(request, generation, budget).then(result => {
      if (!this.enabled || generation !== this.generation) throw new Error('radio_sources_cancelled')
      this.urls.set(key, { result, expires: this.now() + 5 * 60_000 })
      if (this.urls.size > 64) this.urls.delete(this.urls.keys().next().value!)
      return result
    }).finally(() => { this.pending.delete(pendingKey) })
    this.pending.set(pendingKey, promise)
    return promise
  }

  private async trySources(request: RadioSourceRequest, generation: number, budget: number) {
    const deadline = this.now() + Math.max(0, Math.min(60_000, budget))
    const candidates = [...this.sources].sort((a, b) => {
      if (a.id === this.active) return -1
      if (b.id === this.active) return 1
      // Installed providers are the user's explicit choices. Downloaded
      // standbys must not hide them behind a short foreground attempt limit.
      if (!!a.path !== !!b.path) return a.path ? 1 : -1
      return (b.healthyAt ?? 0) - (a.healthyAt ?? 0)
    })
    const report = {
      source: request.source,
      song: String(request.info.musicInfo.name ?? request.info.musicInfo.songmid ?? ''),
      attempts: [] as RadioSourceAttempt[],
    }
    this.lastResolution = report
    for (const source of candidates) {
      if (!this.enabled || generation !== this.generation) throw new Error('radio_sources_cancelled')
      const failure = [this.failures.get(this.failureKey(source, request)), this.failures.get(`${source.id}:${request.source}`)]
        .find(item => item && item.until > this.now())
      if (failure) {
        report.attempts.push({ provider: source.id, name: source.name, outcome: 'cooldown', elapsedMs: 0 })
        continue
      }
      if (this.now() >= deadline) break
      const started = this.now()
      try {
        const result = await this.probe(source, request, Math.min(25_000, deadline - this.now()))
        if (!this.enabled || generation !== this.generation) throw new Error('radio_sources_cancelled')
        this.active = source.id
        report.attempts.push({ provider: source.id, name: source.name, outcome: 'available', elapsedMs: this.now() - started, duration: result.duration })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        // Never expose script error text: it may contain request URLs or keys.
        const reason = /^(radio_source_[a-z_]+|radio_audio_identity_[a-z_]+|short_audio|incomplete_audio|invalid_audio)$/.test(message) ? message : 'request_failed'
        report.attempts.push({ provider: source.id, name: source.name, outcome: 'failed', reason, elapsedMs: this.now() - started })
        if (!this.enabled || generation !== this.generation) throw new Error('radio_sources_cancelled')
        // Unavailable song/provider pairs cool down; other platforms can still
        // work. A single unavailable song does not delete a provider.
      }
    }
    throw new Error('radio_sources_unavailable')
  }

  promoteRevision(source: RadioSource) {
    const current = this.sources.find(item => item.id === this.active)
    if (source.healthyAt && source.family && source.family === current?.family &&
      (source.discoveredAt ?? 0) > (current.discoveredAt ?? 0)) this.active = source.id
  }

  private failureKey(source: RadioSource, request: RadioSourceRequest) {
    return `${source.id}:${request.source}:${this.key(request)}`
  }

  async probe(source: RadioSource, request: RadioSourceRequest, timeout = 25_000): Promise<RadioSourceResult> {
    const key = this.failureKey(source, request)
    try {
      const result = await this.resolveSource(source, request, timeout)
      const rejectedUntil = this.rejectedUrls.get(result.url) ?? 0
      if (rejectedUntil > this.now()) throw new Error('radio_source_returned_failed_url')
      source.healthyAt = this.now()
      this.failures.delete(key)
      this.failures.delete(`${source.id}:${request.source}`)
      for (const [url, until] of this.rejectedUrls) if (until <= this.now()) this.rejectedUrls.delete(url)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const failureKey = /^(radio_source_(unsupported|init_failed|init_timeout|crashed|missing_script))$/.test(message)
        ? `${source.id}:${request.source}` : key
      const count = (this.failures.get(failureKey)?.count ?? 0) + 1
      this.failures.set(failureKey, { count, until: this.now() + Math.min(30 * 60_000, 30_000 * 2 ** (count - 1)) })
      for (const [entry, failure] of this.failures) if (failure.until <= this.now()) this.failures.delete(entry)
      if (this.failures.size > 256) this.failures.delete(this.failures.keys().next().value!)
      throw error
    }
  }

  status() {
    return {
      enabled: this.enabled,
      active: this.active,
      candidates: this.sources.length,
      healthy: this.sources.filter(source => source.healthyAt).length,
      lastResolution: this.lastResolution,
    }
  }
}
