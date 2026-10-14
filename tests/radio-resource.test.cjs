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

function musicFixture() {
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
  }
  dependencies['./utils'] = compile('core/music/utils.ts', dependencies)
  return { online: compile('core/music/online.ts', dependencies), songs, saved, links }
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

const { RadioPlayback, songKey } = compile('core/radio/playback.ts')
const { validateRadioAudio, RadioAudioError } = compile('core/radio/resource.ts')

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
    './utils': {}, '@renderer/utils/message': { requestMsg: {} }, '@renderer/utils/index': {},
    '@renderer/store/list/action': {}, '@renderer/store/list/state': { tempListMeta: { id: 'mcp_radio_test' } },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } }, '@renderer/core/dislikeList': {},
    '@renderer/core/radio/playback': { radioPlayback: playback, songKey },
    '@renderer/core/radio/resource': { validateRadioAudio }, '@renderer/store/player/volume': { volume: { value: 0.35 }, isMute: { value: false } },
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
