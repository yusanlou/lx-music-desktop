const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function compile(relative, dependencies = {}) {
  const file = path.resolve(__dirname, '../src/renderer', relative)
  const runtime = new Module(file, module)
  runtime.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `missing fixture dependency: ${name}`)
    return dependencies[name]
  }
  runtime._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file)
  return runtime.exports
}

function musicFixture(radio = {}) {
  const songs = ['kg', 'wy', 'kw'].map(source => ({ id: source, source, name: '一首歌', singer: '歌手', interval: '04:00', meta: { albumName: '', _qualitys: { '128k': true } } }))
  const cached = { kg: 'cached-placeholder', wy: 'cached-preview' }
  const links = { kg: 'fresh-placeholder', wy: 'fresh-preview', kw: 'complete-song' }
  const saved = []
  const dependencies = {
    '@renderer/store': { qualityList: {} },
    '@renderer/store/utils': { assertApiSupport: () => true },
    '@renderer/utils/musicSdk': { __esModule: true, default: {
      ...Object.fromEntries(songs.map(song => [song.source, { getMusicUrl: () => ({ promise: Promise.resolve({ url: links[song.source], type: '128k' }) }) }])),
      findMusic: async () => songs.slice(1),
    } },
    '@renderer/utils/ipc': { getMusicUrl: async song => cached[song.source], getPlayerLyric: async () => ({}), saveMusicUrl: (song, quality, url) => saved.push(url) },
    '@renderer/store/setting': { appSetting: { 'player.playQuality': '128k' } },
    '@renderer/utils': { toOldMusicInfo: value => value, toNewMusicInfo: value => value },
    '@renderer/utils/message': { requestMsg: { tooManyRequests: 'busy', cancelRequest: 'cancel' } },
    '@renderer/utils/musicSdk/api-source': {},
    '@renderer/store/list/action': {},
    '@renderer/core/radio/sources': { radioSourcesEnabled: { value: false }, validateRadioMusicIdentity: async () => {}, ...radio },
    '@renderer/core/radio/matching': compile('core/radio/matching.ts', { '@common/radioAudio': compile('../common/radioAudio.ts') }),
  }
  dependencies['./utils'] = compile('core/music/utils.ts', dependencies)
  return { online: compile('core/music/online.ts', dependencies), songs, saved, links, dependencies, utils: dependencies['./utils'] }
}

test('radio checks actual cached and alternate audio instead of trusting four-minute search metadata', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
  try {
    const { online, songs, saved } = musicFixture()
    const checked = []
    const validateUrl = async url => {
      checked.push(url)
      if (url !== 'complete-song') throw new Error('radio_short_audio')
    }
    const url = await online.getMusicUrl({ musicInfo: songs[0], isRefresh: false, validateUrl })
    assert.equal(url, 'complete-song')
    assert.deepEqual(checked, ['cached-placeholder', 'fresh-placeholder', 'cached-preview', 'fresh-preview', 'complete-song'])
    assert.equal(saved.includes('fresh-placeholder'), false)
    assert.equal(saved.includes('fresh-preview'), false)
  } finally { global.window = oldWindow }
})

test('a radio cancellation never proceeds to another source or stores the rejected link', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
  try {
    const { online, songs, saved } = musicFixture()
    let attempts = 0
    await assert.rejects(online.getMusicUrl({ musicInfo: songs[0], isRefresh: true,
      validateUrl: async () => { attempts++; throw new Error('cancel') } }), /cancel/)
    assert.equal(attempts, 1)
    assert.deepEqual(saved, [])
  } finally { global.window = oldWindow }
})

test('managed radio providers still recover music when the normal API failed to initialize', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    const calls = []
    const { online, songs, saved } = musicFixture({
      radioSourcesEnabled: { value: true }, observeRadioSong() {},
      resolveRadioMusicUrl: async(song, quality, refresh, failedUrl) => {
        calls.push({ source: song.source, failedUrl })
        return 'managed-full'
      },
    })
    const url = await online.getMusicUrl({ musicInfo: songs[0], isRefresh: false,
      validateUrl: async url => { if (url !== 'managed-full') throw new Error('short') } })
    assert.equal(url, 'managed-full')
    assert.deepEqual(calls, [{ source: 'kg', failedUrl: 'cached-placeholder' }])
    assert.deepEqual(saved, ['managed-full', 'managed-full'])
  } finally { global.window = oldWindow }
})

test('managed radio exhausts providers before looking up the same song on another platform', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    const calls = []
    const { online, songs } = musicFixture({
      radioSourcesEnabled: { value: true }, observeRadioSong() {},
      resolveRadioMusicUrl: async(song) => {
        calls.push(song.source)
        if (song.source !== 'kw') throw new Error('providers_unavailable')
        return 'managed-full'
      },
    })
    assert.equal(await online.getMusicUrl({ musicInfo: songs[0], isRefresh: true, validateUrl: async () => {} }), 'managed-full')
    assert.deepEqual(calls, ['kg', 'wy', 'kw'])
  } finally { global.window = oldWindow }
})

test('radio fallback keeps the announced song instead of playing and caching a fuzzy title match', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    const calls = []
    const { online, songs, saved } = musicFixture({
      radioSourcesEnabled: { value: true }, observeRadioSong() {},
      resolveRadioMusicUrl: async(song) => {
        calls.push(song.name)
        if (song.source === 'kg') throw new Error('providers_unavailable')
        return song.source === 'wy' ? 'wrong-song-full-audio' : 'announced-song-full-audio'
      },
    })
    Object.assign(songs[0], { name: '朋友', singer: '周华健' })
    Object.assign(songs[1], { name: '朋友别哭', singer: '周华健' })
    Object.assign(songs[2], { name: '朋友', singer: '周华健' })
    const url = await online.getMusicUrl({ musicInfo: songs[0], isRefresh: true, validateUrl: async () => {} })
    assert.equal(url, 'announced-song-full-audio', 'audio must be the same song as the queue title and host announcement')
    assert.deepEqual(calls, ['朋友', '朋友'])
    assert.equal(saved.includes('wrong-song-full-audio'), false, 'a mismatched recording must not pollute the announced song cache')
  } finally { global.window = oldWindow }
})

test('radio bypasses legacy URLs that may already contain a different recording', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    const f = musicFixture({ radioSourcesEnabled: { value: true }, observeRadioSong() {},
      resolveRadioMusicUrl: async () => 'fresh-correct-song' })
    const scopes = []
    f.dependencies['@renderer/utils/ipc'].getMusicUrl = async (_song, _quality, radio) => {
      scopes.push(radio)
      return radio ? '' : 'legacy-wrong-song-with-valid-duration'
    }
    assert.equal(await f.online.getMusicUrl({ musicInfo: f.songs[0], isRefresh: false, validateUrl: async () => {} }), 'fresh-correct-song')
    assert.deepEqual(scopes, [true])
  } finally { global.window = oldWindow }
})

test('radio URL cache reads and writes use the same new key without changing ordinary cache keys', async () => {
  const calls = []
  const ipc = compile('utils/ipc.ts', {
    '@common/rendererIpc': { rendererInvoke: async (channel, params) => { calls.push({ channel, params }); return '' } },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { get_music_url: 'read', save_music_url: 'save' } },
    '@common/utils/vueTools': { markRaw: value => value },
    '@common/hotKey': compile('../common/hotKey.ts', { './constants': { APP_EVENT_NAMES: {} } }),
    '@common/constants': { APP_EVENT_NAMES: {}, DATA_KEYS: {}, DEFAULT_SETTING: {} },
  })
  const song = { id: 'track-id', source: 'kg' }
  await ipc.getMusicUrl(song, '128k', true)
  await ipc.saveMusicUrl(song, '128k', 'verified-song', true)
  await ipc.getMusicUrl(song, '128k')
  await ipc.saveMusicUrl(song, '128k', 'ordinary-song')
  assert.equal(calls[0].params, calls[1].params.id)
  assert.equal(calls[0].params, 'radio_identity_v2:kg:track-id:128k')
  assert.equal(calls[2].params, 'track-id_128k')
  assert.equal(calls[3].params.id, 'track-id_128k')
})

test('radio fallback excludes a cover, DJ recording and a different duration before caching a same-title URL', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    for (const mismatch of [{ singer: '翻唱歌手' }, { name: '一首歌 (DJ版)' }, { interval: '05:30' }]) {
      const calls = []
      const f = musicFixture({ radioSourcesEnabled: { value: true }, observeRadioSong() {},
        resolveRadioMusicUrl: async song => {
          calls.push(song.source)
          if (song.source === 'kg') throw new Error('unavailable')
          return song.source === 'wy' ? 'different-recording' : 'correct-recording'
        } })
      Object.assign(f.songs[1], mismatch)
      assert.equal(await f.online.getMusicUrl({ musicInfo: f.songs[0], isRefresh: true, validateUrl: async () => {} }), 'correct-recording')
      assert.deepEqual(calls, ['kg', 'kw'])
      assert.equal(f.saved.includes('different-recording'), false)
    }
  } finally { global.window = oldWindow }
})

test('the ordinary API fallback also checks recording identity for radio requests', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
  try {
    const f = musicFixture()
    Object.assign(f.songs[0], { name: '朋友', singer: '周华健' })
    Object.assign(f.songs[1], { name: '朋友别哭', singer: '周华健' })
    Object.assign(f.songs[2], { name: '朋友', singer: '周华健' })
    f.links.wy = 'wrong-full-song'
    const checked = []
    const url = await f.online.getMusicUrl({ musicInfo: f.songs[0], isRefresh: true, validateUrl: async url => {
      checked.push(url)
      if (url === 'fresh-placeholder') throw new Error('short_audio')
    } })
    assert.equal(url, 'complete-song')
    assert.deepEqual(checked, ['fresh-placeholder', 'complete-song'])
    assert.equal(f.saved.includes('wrong-full-song'), false)
  } finally { global.window = oldWindow }
})

test('ordinary playback keeps its existing fuzzy fallback behavior', async () => {
  const oldWindow = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(true)] }, i18n: { t: value => value } }
  try {
    const f = musicFixture()
    Object.assign(f.songs[1], { name: '近似歌名' })
    f.dependencies['@renderer/utils/musicSdk'].default.kg.getMusicUrl = () => ({ promise: Promise.reject(new Error('unavailable')) })
    assert.equal(await f.online.getMusicUrl({ musicInfo: f.songs[0], isRefresh: true }), 'fresh-preview')
  } finally { global.window = oldWindow }
})

const { RadioPlayback, songKey } = compile('core/radio/playback.ts')
const { validateRadioAudio, RadioAudioError } = compile('core/radio/resource.ts', { '@common/radioAudio': compile('../common/radioAudio.ts') })

function probeFixture(duration) {
  const audio = { duration, src: '', loads: 0, pauses: 0,
    pause() { this.pauses++ }, removeAttribute() { this.src = '' },
    load() { this.loads++; if (this.src) queueMicrotask(() => this.onloadedmetadata?.()) },
  }
  return { audio, create: () => audio }
}

test('metadata probe silently rejects 6-second and 30-second placeholders but accepts real songs', async () => {
  for (const duration of [6, 29.9, 30, 30.05, 30.2, 31, 240]) {
    const { audio, create } = probeFixture(duration)
    const result = validateRadioAudio('audio', undefined, create)
    if (duration <= 30.25) await assert.rejects(result, error => error instanceof RadioAudioError && error.reason === 'short_audio')
    else await result
    assert.equal(audio.autoplay, false)
    assert.equal(audio.muted, true)
    assert.equal(audio.volume, 0)
    assert.equal(audio.src, '')
    assert.equal(audio.onloadedmetadata, null)
  }
})

test('unknown duration waits for a useful metadata update, with bounded timeout and cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { audio, create } = probeFixture(Infinity)
  const pending = validateRadioAudio('stream', undefined, create)
  await Promise.resolve()
  audio.duration = 240
  audio.ondurationchange()
  await pending
  const stalled = probeFixture(NaN)
  const failure = assert.rejects(validateRadioAudio('stalled', undefined, stalled.create), /有效时长/)
  t.mock.timers.tick(8000)
  await failure
  const controller = new AbortController()
  const aborted = probeFixture(NaN)
  const cancelled = assert.rejects(validateRadioAudio('old', controller.signal, aborted.create), { name: 'AbortError' })
  controller.abort()
  await cancelled
  assert.equal(aborted.audio.src, '')
})

function actionFixture(t, { allShort = false, hold = false } = {}) {
  const order = [], resources = [], voices = [], probes = [], requests = []
  let currentResource = ''
  class AudioProbe {
    constructor() { probes.push(this) }
    pause() {}
    removeAttribute() { this.src = '' }
    load() {
      if (!this.src) return
      this.duration = this.src.includes('bad') ? 6 : 240
      if (!hold) queueMicrotask(() => this.onloadedmetadata?.())
    }
  }
  const playback = new RadioPlayback(() => {
    const audio = { duration: 8, plays: 0, play() { this.plays++; order.push('voice'); return Promise.resolve() },
      pause() {}, removeAttribute() {}, load() { queueMicrotask(() => this.oncanplay?.()) } }
    voices.push(audio)
    return audio
  })
  playback.configure(true)
  const list = ['bad-first', allShort ? 'bad-second' : 'good-second'].map(id => ({ id, source: 'kg', name: id, singer: '歌手', meta: {} }))
  const state = { isPlay: { value: false }, playedList: [], tempPlayList: [], musicInfo: { pic: '' }, playInfo: {}, playMusicInfo: {} }
  const dependencies = {
    '@renderer/plugins/player': {
      isEmpty: () => !currentResource,
      setResource: url => { currentResource = url; resources.push(url); order.push('music') },
      setStop: () => { currentResource = '' }, setPause() {}, setPlay() {},
    },
    '@renderer/store/player/state': state,
    '@renderer/store/player/action': {
      getList: () => list,
      setPlayListId: id => { state.playInfo.playerListId = id },
      setPlayMusicInfo: (listId, song) => { Object.assign(state.playMusicInfo, { listId, musicInfo: song, isTempPlay: false }) },
      clearPlayedList() {}, clearTempPlayeList() {}, setMusicInfo() {}, setAllStatus: message => order.push(message),
    },
    '@renderer/store/setting': { appSetting: { 'player.autoSkipOnError': false, 'player.togglePlayMethod': 'singleLoop' } },
    '../music/index': {
      getMusicUrl: async({ musicInfo, validateUrl }) => {
        requests.push(musicInfo.id)
        const url = `https://test.invalid/${musicInfo.id}`
        await validateUrl?.(url)
        return url
      },
      getPicPath: async () => 'pic',
      getLyricInfo: async () => ({ rawlrcInfo: { lyric: '' } }),
    },
    './utils': { filterList: async options => ({ filteredList: options.list, playerIndex: options.list.indexOf(options.playerMusicInfo) }) },
    '@renderer/utils/message': { requestMsg: {} }, '@renderer/utils/index': {},
    '@renderer/store/list/action': {}, '@renderer/store/list/state': { tempListMeta: { id: 'mcp_radio_test' } },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } }, '@renderer/core/dislikeList': {},
    '@renderer/core/radio/playback': { radioPlayback: playback, songKey },
    '@renderer/core/radio/resource': { validateRadioAudio }, '@renderer/store/player/volume': { volume: { value: 0.35 }, isMute: { value: false } },
    '@renderer/core/radio/matching': compile('core/radio/matching.ts', { '@common/radioAudio': compile('../common/radioAudio.ts') }),
  }
  const oldWindow = global.window, oldAudio = global.Audio
  global.Audio = AudioProbe
  global.window = { lx: { isPlayedStop: false }, i18n: { t: value => value }, app_event: {
    pause: () => { state.isPlay.value = false }, play: () => { state.isPlay.value = true },
    stop() {}, error() {}, picUpdated() {}, lyricUpdated() {},
  } }
  const action = compile('core/player/action.ts', dependencies)
  t.after(async() => {
    action.stop(); playback.cancel()
    await new Promise(resolve => setTimeout(resolve, 5))
    global.window = oldWindow; global.Audio = oldAudio
  })
  return { action, playback, order, voices, resources, probes, list, requests }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)) }

test('invalid radio song is skipped before its host introduction, even with auto-skip disabled and single-loop enabled', async t => {
  const f = actionFixture(t)
  for (const song of f.list) await f.playback.prepare(f.playback.sessionId, songKey(song), '歌前口播', 'voice', () => true)
  f.action.playList('temp', 0)
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/good-second'])
  assert.equal(f.voices[0].plays, 0)
  assert.equal(f.voices[1].plays, 1)
  assert.equal(f.playback.isMusicRejected('kg:bad-first'), true)
})

test('an entirely invalid radio queue stops after each song once without playing placeholders or looping', async t => {
  const f = actionFixture(t, { allShort: true })
  f.action.playList('temp', 0)
  await flush()
  assert.deepEqual(f.resources, [])
  assert.deepEqual(f.requests, ['bad-first', 'bad-second'])
  assert.ok(f.order.some(message => message.includes('均无可用')))
})

test('pause during duration validation holds both the intro and music until resume', async t => {
  const f = actionFixture(t, { hold: true })
  const good = f.list[1]
  await f.playback.prepare(f.playback.sessionId, songKey(good), '歌前口播', 'voice', () => true)
  f.action.playList('temp', 1)
  await flush()
  f.action.pause()
  f.probes[0].onloadedmetadata()
  await flush()
  assert.equal(f.voices[0].plays, 0)
  assert.deepEqual(f.resources, [])
  f.action.play()
  assert.equal(f.voices[0].plays, 1)
  assert.equal(f.resources.length, 1)
})

test('stop during a metadata probe prevents stale audio or host speech from starting', async t => {
  const f = actionFixture(t, { hold: true })
  f.action.playList('temp', 1)
  await flush()
  f.action.stop()
  await flush()
  assert.deepEqual(f.resources, [])
  assert.deepEqual(f.requests, ['good-second'])
})

test('ordinary player mode still permits a legitimate short clip', async t => {
  const f = actionFixture(t)
  f.playback.configure(false)
  f.action.playList('temp', 0)
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/bad-first'])
  assert.equal(f.probes.length, 0)
})

test('manual skip cancels the previous metadata check and a late event cannot reject or play the new song', async t => {
  const f = actionFixture(t, { hold: true })
  f.action.playList('temp', 0)
  await flush()
  const lateOldMetadata = f.probes[0].onloadedmetadata
  f.action.playList('temp', 1)
  await flush()
  lateOldMetadata()
  f.probes[1].onloadedmetadata()
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/good-second'])
  assert.equal(f.playback.isMusicRejected('kg:good-second'), false)
})

test('returning to the same song object cannot let its earlier cancelled URL overwrite the current radio position', async t => {
  const f = actionFixture(t, { hold: true })
  f.action.playList('temp', 1)
  await flush()
  const oldMetadata = f.probes[0].onloadedmetadata
  f.action.playList('temp', 0)
  await flush()
  f.action.playList('temp', 1)
  await flush()
  oldMetadata()
  await flush()
  assert.deepEqual(f.resources, [])
  f.probes.at(-1).onloadedmetadata()
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/good-second'])
})

test('a previously selected mismatched alternate cannot replace the song announced by the radio', async t => {
  const f = actionFixture(t)
  f.list[1].meta.toggleMusicInfo = { id: 'old-wrong-song', source: 'wy', name: '另一首歌', singer: '另一位歌手', meta: {} }
  f.action.playList('temp', 1)
  await flush()
  assert.deepEqual(f.requests, ['good-second'])
  assert.deepEqual(f.resources, ['https://test.invalid/good-second'])
})

test('a one-song radio can skip to a newly appended song without replaying or replacing the current queue', async t => {
  const f = actionFixture(t)
  f.list.splice(0, 1)
  f.action.playList('temp', 0)
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/good-second'])
  f.list.push({ id: 'good-next', source: 'kg', name: '下一首', singer: '歌手', meta: {} })
  await f.action.playNext()
  await flush()
  assert.deepEqual(f.resources, ['https://test.invalid/good-second', 'https://test.invalid/good-next'])
})

test('slow providers on the first platform leave time to try a matching song on another platform', async t => {
  let clock = 100
  t.mock.method(Date, 'now', () => clock)
  const calls = []
  const { online, songs } = musicFixture({
    radioSourcesEnabled: { value: true }, observeRadioSong() {},
    resolveRadioMusicUrl: async(song, _quality, _refresh, _failed, budget) => {
      calls.push({ source: song.source, budget })
      if (song.source === 'kg') { clock += budget; throw new Error('radio_sources_unavailable') }
      return 'managed-full'
    },
  })
  assert.equal(await online.getMusicUrl({ musicInfo: songs[0], isRefresh: true, validateUrl: async () => {} }), 'managed-full')
  assert.deepEqual(calls.map(call => call.source), ['kg', 'wy'])
  assert.ok(calls[0].budget < 65000)
  assert.ok(calls[1].budget > 0)
})

test('each matching alternate keeps a useful probe budget without starving subsequent platforms', async t => {
  let clock = 100
  t.mock.method(Date, 'now', () => clock)
  const calls = []
  const { online, songs, utils } = musicFixture({
    radioSourcesEnabled: { value: true }, observeRadioSong() {},
    resolveRadioMusicUrl: async(song, _quality, _refresh, _failed, budget) => {
      calls.push(song.source)
      if (song.source === 'wy' && budget >= 15000) { clock += 15000; return 'managed-full' }
      clock += budget
      throw new Error('radio_sources_unavailable')
    },
  })
  t.mock.method(utils, 'getOtherSource', async () => { clock += 12000; return songs.slice(1) })
  assert.equal(await online.getMusicUrl({ musicInfo: songs[0], isRefresh: true, validateUrl: async () => {} }), 'managed-full')
  assert.deepEqual(calls, ['kg', 'wy'])
})

test('a sixty-second preview is rejected when the matching song is over three minutes long', async () => {
  const short = probeFixture(60)
  await assert.rejects(validateRadioAudio('preview', undefined, short.create, '03:21'),
    error => error instanceof RadioAudioError && error.reason === 'incomplete_audio')
  const full = probeFixture(200.8)
  await validateRadioAudio('full', undefined, full.create, '03:21')
})


test('radio rejects a cached wrong recording and only saves a matching replacement', async () => {
  const previous = global.window
  global.window = { lx: { apiInitPromise: [Promise.resolve(false)] } }
  try {
    const checked = []
    const { online, songs, saved } = musicFixture({
      radioSourcesEnabled: { value: true }, observeRadioSong() {},
      validateRadioMusicIdentity: async url => {
        checked.push(url)
        if (url === 'cached-placeholder') throw new Error('radio_audio_identity_mismatch')
      },
      resolveRadioMusicUrl: async (_song, _quality, _refresh, failed) => {
        assert.equal(failed, 'cached-placeholder')
        return 'matching-recording'
      },
    })
    assert.equal(await online.getMusicUrl({ musicInfo: songs[0], isRefresh: false, validateUrl: async () => {} }), 'matching-recording')
    assert.deepEqual(checked, ['cached-placeholder', 'matching-recording'])
    assert.deepEqual(saved, ['matching-recording', 'matching-recording'])
  } finally { global.window = previous }
})

test('actual media identity tolerates a soundtrack subtitle and singer alias but rejects different songs and versions', () => {
  const { assertRadioAudioIdentity } = compile('../common/radioIdentity.ts')
  assert.doesNotThrow(() => assertRadioAudioIdentity({ title: '幸福在歌唱 (《阳光女子合唱团》电影幸福版主题曲)', artist: 'A-Lin' }, { name: '幸福在歌唱', singer: 'A-Lin' }))
  assert.doesNotThrow(() => assertRadioAudioIdentity({ title: '跳楼机', artist: '时柏尘' }, { name: '跳楼机', singer: 'LBI利比（时柏尘）' }))
  assert.throws(() => assertRadioAudioIdentity({ title: '自由的你', artist: 'G.E.M.邓紫棋' }, { name: '幸福在歌唱', singer: 'A-Lin' }), /identity_mismatch/)
  assert.throws(() => assertRadioAudioIdentity({ title: '幸福在歌唱', artist: '翻唱歌手' }, { name: '幸福在歌唱', singer: 'A-Lin' }), /identity_mismatch/)
  assert.throws(() => assertRadioAudioIdentity({ title: '幸福在歌唱 (Live)', artist: 'A-Lin' }, { name: '幸福在歌唱', singer: 'A-Lin' }), /identity_mismatch/)
})
