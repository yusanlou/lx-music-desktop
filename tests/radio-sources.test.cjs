const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function compile(relative, dependencies = {}) {
  const file = path.resolve(__dirname, '../src', relative)
  const runtime = new Module(file, module)
  runtime.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)
  runtime._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, file)
  return runtime.exports
}
const { RadioSourcePool } = compile('main/modules/radioSources/pool.ts')
const catalog = compile('main/modules/radioSources/catalog.ts', { '@common/utils/request': {} })
const request = (id = 'song', source = 'kg') => ({ source, action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: id } } })
const source = id => ({ id, name: id })
const result = id => ({ provider: id, url: `https://music.test/${id}`, type: '128k' })

test('unavailable and preview-only providers silently fall through to a healthy provider', async () => {
  const calls = []
  const pool = new RadioSourcePool(async provider => {
    calls.push(provider.id)
    if (provider.id === 'broken') throw new Error('HTTP 503')
    if (provider.id === 'preview') throw new Error('short_audio')
    return result(provider.id)
  })
  pool.configure(true)
  pool.merge(['broken', 'preview', 'full'].map(source))
  assert.equal((await pool.resolve(request())).provider, 'full')
  assert.deepEqual(calls, ['broken', 'preview', 'full'])
  calls.length = 0
  assert.equal((await pool.resolve(request('another'))).provider, 'full')
  assert.deepEqual(calls, ['full'])
})

test('failed URLs are evicted across song cache entries and never returned on refresh', async () => {
  const pool = new RadioSourcePool(async provider => result(provider.id))
  pool.configure(true); pool.merge(['old', 'backup'].map(source))
  const old = await pool.resolve(request())
  pool.reject(old.url)
  assert.equal((await pool.resolve(request(), true)).provider, 'backup')
  assert.equal((await pool.resolve(request())).provider, 'backup')
})

test('provider cooldown is bounded, per platform, and avoids repeatedly stalling songs', async () => {
  let clock = 100, calls = 0
  const pool = new RadioSourcePool(async () => { calls++; throw new Error('radio_source_init_failed') }, () => clock)
  pool.configure(true); pool.merge([source('dead')])
  await assert.rejects(pool.resolve(request()), /unavailable/)
  await assert.rejects(pool.resolve(request('next')), /unavailable/)
  assert.equal(calls, 1)
  await assert.rejects(pool.resolve(request('next', 'wy')), /unavailable/)
  assert.equal(calls, 2)
  clock += 30_001
  await assert.rejects(pool.resolve(request('next')), /unavailable/)
  assert.equal(calls, 3)
})

test('exhaustion stays within a sixty-second foreground budget', async () => {
  let clock = 100, calls = 0
  const pool = new RadioSourcePool(async (_source, _request, timeout) => {
    calls++; clock += timeout; throw new Error('timeout')
  }, () => clock)
  pool.configure(true); pool.merge(Array.from({ length: 10 }, (_, i) => source(String(i))))
  await assert.rejects(pool.resolve(request()), /unavailable/)
  assert.equal(calls, 3)
  assert.equal(clock, 60_100)
})

test('same-song requests share one probe but disabling the radio cancels late results', async () => {
  let finish, calls = 0
  const pool = new RadioSourcePool(async () => {
    calls++; return new Promise(resolve => { finish = resolve })
  })
  pool.configure(true); pool.merge([source('a')])
  const first = pool.resolve(request()), second = pool.resolve(request())
  assert.equal(calls, 1)
  pool.configure(false)
  finish(result('a'))
  const settled = await Promise.allSettled([first, second])
  assert.ok(settled.every(item => item.status === 'rejected' && /cancelled/.test(item.reason.message)))
  assert.equal(pool.active, '')
})

test('a bad update retains the old revision; a verified update is promoted and can roll back', async () => {
  let newWorks = false
  const pool = new RadioSourcePool(async provider => {
    if (provider.id === 'new' && !newWorks) throw new Error('broken update')
    return result(provider.id)
  })
  pool.configure(true)
  const old = { ...source('old'), family: 'station', discoveredAt: 1 }
  const fresh = { ...source('new'), family: 'station', discoveredAt: 2 }
  pool.merge([old, fresh]); await pool.resolve(request())
  await assert.rejects(pool.probe(fresh, request()), /broken/)
  pool.promoteRevision(fresh)
  assert.equal(pool.active, 'old')
  newWorks = true; await pool.probe(fresh, request()); pool.promoteRevision(fresh)
  assert.equal(pool.active, 'new')
  newWorks = false
  assert.equal((await pool.resolve(request('next'))).provider, 'old')
})

test('catalog prefers recent recommended scripts, deduplicates, and excludes keys and large/binary files', () => {
  const entries = [
    { path: 'V260817/推荐/a.js', sha: 'new' }, { path: 'v260724/推荐/a.js', sha: 'old' },
    { path: 'V260817/未测试/b.js' }, { path: 'V260817/推荐/c.js' },
    { path: 'V260817/账号/credential.js' }, { path: 'V260817/推荐/需自备密钥.js' },
    { path: 'V260817/推荐/huge.js', size: 3 * 1024 * 1024 },
    { path: '../escaped.js' }, { path: 'player.apk' },
  ]
  const selected = catalog.selectEntries(entries)
  assert.deepEqual(selected.map(entry => entry.path), ['V260817/推荐/c.js', 'V260817/推荐/a.js', 'V260817/未测试/b.js'])
  assert.equal(selected.find(entry => entry.path.endsWith('/a.js')).sha, 'new')
})

test('API rate limits fall back to JSON tree pages, including nested Chinese directories', async () => {
  const paths = []
  const payload = items => JSON.stringify({ payload: { codeViewTreeRoute: { tree: { items } } } })
  const entries = await catalog.fetchCatalog(async url => {
    paths.push(url)
    if (url.includes('api.github.com')) throw new Error('HTTP 403')
    if (url.endsWith('/tree/main')) return payload([{ path: 'V260817', contentType: 'directory' }])
    if (url.endsWith('/V260817')) return payload([{ path: 'V260817/推荐', contentType: 'directory' }])
    return payload([{ path: 'V260817/推荐/音源.js', contentType: 'file' }])
  })
  assert.equal(entries[0].path, 'V260817/推荐/音源.js')
  assert.ok(paths.at(-1).endsWith(encodeURIComponent('推荐')))
  await assert.rejects(catalog.fetchCatalog(async () => { throw new Error('offline') }), /offline/)
})

test('rejected HTTP responses and oversized streams are closed without an uncaught stream error', async () => {
  const { Readable } = require('node:stream')
  let statusCode = 403
  const requests = []
  const remote = compile('main/modules/radioSources/catalog.ts', {
    '@common/utils/request': { request: async () => {
      const body = new Readable({ read() { this.push(Buffer.alloc(20)); this.push(null) },
        destroy(error, callback) { callback(error || new Error('aborted stream')) } })
      requests.push(body)
      return { statusCode, headers: {}, body }
    } },
  })
  await assert.rejects(remote.readRemote('https://test.invalid', 10), /http_403/)
  statusCode = 200
  await assert.rejects(remote.readRemote('https://test.invalid', 10), /too_large/)
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(requests.every(stream => stream.destroyed))
})

test('offline catalog preserves persisted providers across restart and radio shutdown closes maintenance', async t => {
  const { createHash } = require('node:crypto')
  const script = '/*\n * @name Cached source\n */\nlx.send()'
  const id = `remote_${createHash('sha256').update(script).digest('hex')}`
  const snapshot = JSON.stringify({ version: 1, lastSync: 1, active: id,
    sources: [{ id, script, path: 'V260817/cache.js', name: 'cache', healthyAt: 1 }] })
  let closed = 0, persisted = ''
  const probes = []
  const old = global.lx
  global.lx = { appSetting: { 'common.apiSource': 'installed' } }
  const service = compile('main/modules/radioSources/index.ts', {
    'node:fs/promises': { stat: async () => ({ size: snapshot.length }), readFile: async () => snapshot,
      mkdir: async () => {}, writeFile: async (_file, data) => { persisted = data }, rename: async () => {} },
    electron: { app: { getPath: () => '/radio-test' } },
    './catalog': { fetchCatalog: async () => { throw new Error('offline') } },
    './pool': { RadioSourcePool },
    './runtime': { closeSourceProbes: () => { closed++ }, probeSource: async provider => {
      probes.push(provider.id); return result(provider.id)
    } },
    '../userApi/utils': { getUserApis: () => [source('installed')], getScript: async () => script },
  })
  t.after(() => { service.closeRadioSources(); global.lx = old })
  await service.configureRadioSources(true)
  assert.equal((await service.resolveRadioSource(request(), false)).provider, id)
  assert.equal(probes[0], id)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.getRadioSourcesStatus().catalogError, 'catalog_unavailable')
  assert.ok(JSON.parse(persisted).sources.some(source => source.id === id))
  await service.configureRadioSources(false)
  await assert.rejects(service.resolveRadioSource(request(), false), /disabled/)
  assert.ok(closed > 0)
})

function eventFixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const listeners = {}, calls = [], status = [], cleanups = []
  const music = { id: 'one', source: 'kg' }
  const state = { musicInfo: music, playMusicInfo: { musicInfo: music, listId: 'temp', isTempPlay: false } }
  const playback = { enabled: true, positionId: 1 }
  const old = global.window
  global.window = { lx: { isPlayedStop: false }, app_event: {
    on: (name, callback) => { listeners[name] = callback }, off: name => { delete listeners[name] },
    setProgress: time => calls.push(['progress', time]),
  } }
  t.after(() => { cleanups.forEach(fn => fn()); global.window = old })
  compile('renderer/core/useApp/usePlayer/usePlayEvent.ts', {
    '@common/utils/vueTools': { onBeforeUnmount: fn => cleanups.push(fn) },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/store/player/state': state,
    '@renderer/plugins/player': { getCurrentTime: () => 91, isEmpty: () => false, setStop: () => calls.push(['stop']) },
    '@renderer/core/player': { setMusicUrl: (song, refresh) => calls.push(['refresh', song.id, refresh]), playNext: () => calls.push(['next']) },
    '@renderer/store/player/action': { setAllStatus: message => status.push(message) },
    '@renderer/store/setting': { appSetting: { 'player.autoSkipOnError': false } },
    '@renderer/core/radio/playback': { radioPlayback: playback },
    '@renderer/store/list/state': { tempListMeta: { id: 'mcp_radio_test' } },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
  }).default()
  return { listeners, calls, state, playback, status }
}

test('eight seconds of radio buffering refreshes at the same progress without visible source errors', t => {
  const f = eventFixture(t)
  f.listeners.playerWaiting(); t.mock.timers.tick(7999)
  assert.deepEqual(f.calls, [])
  t.mock.timers.tick(1)
  assert.deepEqual(f.calls, [['progress', 91], ['refresh', 'one', true]])
  f.listeners.playerError(2)
  assert.equal(f.status.includes('player__refresh_url'), false)
})

test('recovering playback or manually skipping cancels a stale buffering refresh', t => {
  const f = eventFixture(t)
  f.listeners.playerWaiting(); f.listeners.playerPlaying(); t.mock.timers.tick(8000)
  assert.deepEqual(f.calls, [])
  f.listeners.playerWaiting(); f.playback.positionId++; t.mock.timers.tick(8000)
  assert.deepEqual(f.calls, [])
})

test('pausing the radio cancels pending stall recovery', t => {
  const f = eventFixture(t)
  f.listeners.playerWaiting(); f.listeners.pause(); t.mock.timers.tick(8000)
  assert.deepEqual(f.calls, [])
})

test('radio error recovery works with auto-skip off and terminates after bounded retries', t => {
  const f = eventFixture(t)
  f.listeners.playerError(2); f.listeners.playerError(2); f.listeners.playerError(2)
  assert.equal(f.calls.filter(call => call[0] === 'refresh').length, 2)
  assert.equal(f.calls.filter(call => call[0] === 'next').length, 1)
})

test('ordinary playback keeps its previous buffering behavior', t => {
  const f = eventFixture(t)
  f.playback.enabled = false
  f.listeners.playerWaiting(); t.mock.timers.tick(8000)
  assert.deepEqual(f.calls, [])
})


test('an unavailable song does not suppress that provider for a different song on the same platform', async () => {
  const calls = []
  const pool = new RadioSourcePool(async (provider, req) => {
    calls.push(req.info.musicInfo.songmid)
    if (req.info.musicInfo.songmid === 'unavailable') throw new Error('radio_source_response_failed')
    return result(provider.id)
  })
  pool.configure(true); pool.merge([source('full')])
  await assert.rejects(pool.resolve(request('unavailable')), /unavailable/)
  assert.equal((await pool.resolve(request('available'))).provider, 'full')
  assert.deepEqual(calls, ['unavailable', 'available'])
})

test('fast failures cannot hide the fifth available provider while time remains', async () => {
  const calls = []
  const pool = new RadioSourcePool(async provider => {
    calls.push(provider.id)
    if (provider.id !== 'full') throw new Error('radio_source_unsupported')
    return result(provider.id)
  })
  pool.configure(true); pool.merge(['a', 'b', 'c', 'd', 'full'].map(source))
  assert.equal((await pool.resolve(request())).provider, 'full')
  assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'full'])
})


test('installed backups precede downloaded standbys, and diagnostics omit raw script errors', async () => {
  const calls = []
  const pool = new RadioSourcePool(async provider => {
    calls.push(provider.id)
    if (provider.id === 'active') throw new Error('secret=https://test.invalid/?key=private')
    return result(provider.id)
  })
  pool.configure(true); pool.active = 'active'
  pool.merge([{ ...source('downloaded'), path: 'remote.js', healthyAt: 20 }, source('active'), source('installed')])
  assert.equal((await pool.resolve(request())).provider, 'installed')
  assert.deepEqual(calls, ['active', 'installed'])
  const diagnostics = pool.status().lastResolution
  assert.equal(diagnostics.attempts[0].reason, 'request_failed')
  assert.equal(JSON.stringify(diagnostics).includes('private'), false)
})

test('song cooldown remains bounded and suppresses repeat requests only for that song', async () => {
  let clock = 100, calls = 0
  const pool = new RadioSourcePool(async () => { calls++; throw new Error('radio_source_response_failed') }, () => clock)
  pool.configure(true); pool.merge([source('a')])
  await assert.rejects(pool.resolve(request()), /unavailable/)
  await assert.rejects(pool.resolve(request()), /unavailable/)
  assert.equal(calls, 1)
  assert.equal(pool.status().lastResolution.attempts[0].outcome, 'cooldown')
  clock += 30001
  await assert.rejects(pool.resolve(request()), /unavailable/)
  assert.equal(calls, 2)
})
