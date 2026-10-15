const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function compile(relative, dependencies = {}) {
  const file = path.resolve(__dirname, '..', relative)
  const runtime = new Module(file, module)
  runtime.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `missing dependency ${name}`)
    return dependencies[name]
  }
  runtime._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, file)
  return runtime.exports
}
function fixture() {
  const song = (id, name) => ({ id, name, source: 'kg', singer: '歌手', interval: '03:00', meta: {} })
  const first = song('first', '当前歌'), future = song('future', '自动续播'), requested = song('requested', '点播歌'), auto = song('auto-added', '补歌')
  const list = [first, future]
  const playMusicInfo = { musicInfo: first, listId: 'temp', isTempPlay: false }
  const playInfo = { playIndex: 0 }
  const { RadioPlayback, songKey } = compile('src/renderer/core/radio/playback.ts')
  const playback = new RadioPlayback(() => { throw new Error('text chat must not create speech') })
  playback.configure(true)
  playback.musicStarted = true
  const queue = compile('src/renderer/core/radio/queue.ts')
  const tempListMeta = { id: 'mcp_radio_test' }
  let dispatcher, held, checked = 0, searches = 0, starts = 0
  const pending = new Map()
  const common = compile('src/common/radioAudio.ts')
  const dependencies = {
    '@common/rendererIpc': { rendererOn: (_event, handler) => { dispatcher = handler }, rendererSend: (_event, response) => pending.get(response.requestId)(response) },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} }, '@common/utils/vueTools': { watch() {}, markRaw: x => x },
    '@renderer/utils': { deduplicationList: x => x },
    '@renderer/core/radio/search': { searchRadioMusic: async keyword => { searches++; return keyword.includes('补歌') ? [auto] : [requested] } },
    '@renderer/store/search/music/action': { search: async keyword => { searches++; return keyword.includes('补歌') ? [auto] : [requested] } },
    '@renderer/store/player/state': { playMusicInfo, playInfo, isPlay: { value: true } },
    '@renderer/store/list/action': {
      getListMusicsFromCache: () => list,
      overwriteListMusics: async({ musicInfos }) => { list.splice(0, list.length, ...musicInfos) },
      addListMusics: async(_id, songs) => { list.push(...songs) },
    },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/action': { updatePlayIndex: () => { playInfo.playIndex = list.indexOf(playMusicInfo.musicInfo) } },
    '@renderer/core/player': { playList: () => { starts++ }, getNextPlayMusicInfo: async() => ({ listId: 'temp', isTempPlay: false, musicInfo: list[playInfo.playIndex + 1] }) },
    '@renderer/core/radio/playback': { radioPlayback: playback, songKey },
    '@renderer/core/radio/mode': { miniRadioMode: { value: true } },
    '@renderer/core/radio/queue': queue,
    '@renderer/core/radio/matching': compile('src/renderer/core/radio/matching.ts', { '@common/radioAudio': common }),
    '@renderer/core/radio/hostSettings': { getHostSettings: async() => ({ ok: false }) },
    '@renderer/core/radio/sources': { configureRadioSources: async() => {} },
    '@renderer/core/music': { getMusicUrl: async(options) => {
      checked++
      await options.validateUrl('matching-full-song')
      if (held) await held
      return 'matching-full-song'
    } },
    '@renderer/core/radio/resource': { validateRadioAudio: async() => {} },
    '@renderer/plugins/player': { getCurrentTime: () => 15, getDuration: () => 180 },
    '@renderer/core/music/utils': {}, '@renderer/core/apiSource': {},
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/setting': { appSetting: {} }, '@renderer/utils/ipc': {}, '@renderer/store': {},
  }
  compile('src/renderer/core/useApp/useMcp.ts', dependencies).default()
  let serial = 0
  const invoke = (method, params) => new Promise((resolve, reject) => {
    const id = String(++serial)
    pending.set(id, response => { pending.delete(id); response.error ? reject(new Error(response.error)) : resolve(response.result) })
    dispatcher({ params: { requestId: id, method, params } })
  })
  return { list, playback, first, requested, tempListMeta, playMusicInfo, invoke,
    count: () => ({ checked, searches, starts }), hold: promise => { held = promise }, dependencies }
}

test('requested next song retains current audio, volume, session and automatic queue', async() => {
  const f = fixture()
  const session = f.playback.sessionId
  const result = await f.invoke('request_radio_next_song', { name: '点播歌', singer: '歌手', requestId: 'request' })
  assert.equal(result.requested, true)
  assert.deepEqual(f.list.map(song => song.id), ['first', 'requested', 'future'])
  assert.equal(f.playMusicInfo.musicInfo, f.first)
  assert.equal(f.playback.sessionId, session)
  assert.equal(f.playback.musicGain, 1)
  assert.equal(f.count().starts, 0)
  assert.equal(f.playback.requestedNextKey, 'kg:requested')
  const repeated = await f.invoke('request_radio_next_song', { name: '点播歌', singer: '歌手', requestId: 'request' })
  assert.deepEqual(repeated, result)
  assert.equal(f.count().checked, 1)
})
test('cancellation during silent audio verification never inserts or changes playback', async() => {
  const f = fixture()
  let release
  f.hold(new Promise(resolve => { release = resolve }))
  const pending = f.invoke('request_radio_next_song', { name: '点播歌', requestId: 'cancel' })
  await new Promise(resolve => setImmediate(resolve))
  await f.invoke('cancel_radio_request', { requestId: 'cancel' })
  release()
  assert.equal((await pending).reason, 'cancelled')
  assert.deepEqual(f.list.map(song => song.id), ['first', 'future'])
  assert.equal(f.count().starts, 0)
})
test('unavailable or short request leaves the original automatic queue intact', async() => {
  const f = fixture()
  f.dependencies['@renderer/core/radio/resource'].validateRadioAudio = async() => { throw new Error('short_audio') }
  const result = await f.invoke('request_radio_next_song', { name: '点播歌', requestId: 'short' })
  assert.equal(result.requested, false)
  assert.deepEqual(f.list.map(song => song.id), ['first', 'future'])
})
test('automatic append finishing during request verification is preserved', async() => {
  const f = fixture()
  let release
  f.hold(new Promise(resolve => { release = resolve }))
  const request = f.invoke('request_radio_next_song', { name: '点播歌', requestId: 'concurrent' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.invoke('append_songs', { songs: [{ name: '补歌', singer: '歌手' }], source: 'kg' })).appended, 1)
  release()
  assert.equal((await request).requested, true)
  assert.deepEqual(f.list.map(song => song.id), ['first', 'requested', 'future', 'auto-added'])
})
test('a new programme makes an old pending song request stale', async() => {
  const f = fixture()
  let release
  f.hold(new Promise(resolve => { release = resolve }))
  const request = f.invoke('request_radio_next_song', { name: '点播歌', requestId: 'stale' })
  await new Promise(resolve => setImmediate(resolve))
  f.playback.configure(true)
  release()
  assert.equal((await request).reason, 'stale')
  assert.deepEqual(f.list.map(song => song.id), ['first', 'future'])
})
