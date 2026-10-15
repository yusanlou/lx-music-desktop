const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../src/renderer/core/radio/playback.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const runtime = new Module(filename, module)
runtime._compile(compiled, filename)
const { RadioPlayback } = runtime.exports
const queueFile = path.resolve(__dirname, '../src/renderer/core/radio/queue.ts')
const queueRuntime = new Module(queueFile, module)
queueRuntime._compile(ts.transpileModule(fs.readFileSync(queueFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, queueFile)

const matchingFile = path.resolve(__dirname, '../src/renderer/core/radio/matching.ts')
const commonFile = path.resolve(__dirname, '../src/common/radioAudio.ts')
const commonRuntime = new Module(commonFile, module)
commonRuntime._compile(ts.transpileModule(fs.readFileSync(commonFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, commonFile)
const matchingRuntime = new Module(matchingFile, module)
matchingRuntime.require = name => name === '@common/radioAudio' ? commonRuntime.exports : require(name)
matchingRuntime._compile(ts.transpileModule(fs.readFileSync(matchingFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, matchingFile)

function fixture(audioDuration = 8) {
  const audios = []
  const playback = new RadioPlayback(() => {
    const audio = {
      plays: 0, pauses: 0,
      duration: audioDuration, currentTime: 0,
      play() { this.plays++; return Promise.resolve() },
      pause() { this.pauses++ },
      removeAttribute() {},
      load() { queueMicrotask(() => this.oncanplay?.()) },
    }
    audios.push(audio)
    return audio
  }, () => Date.now())
  playback.configure(true)
  return { playback, audios }
}
async function prepare(playback, key = 'wy:next') {
  assert.equal(await playback.prepare(playback.sessionId, key, '下一首的故事', 'data:audio/mpeg;base64,abc', () => true, { afterText: '下一首的故事' }), true)
}

test('chat speech ducks music smoothly, restores it and keeps programme quotas and prepared intros', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture(8)
  await prepare(playback)
  playback.updateSong(20, 300, true)
  const session = playback.sessionId
  assert.equal((await playback.speakDialogue(session, 'chat', 0, '慢慢听。', 'audio', () => true)).played, true)
  assert.equal(playback.allowsMusic, true)
  assert.equal(audios[1].plays, 0)
  t.mock.timers.tick(300)
  assert.ok(playback.musicGain < 1 && playback.musicGain > 0.22)
  t.mock.timers.tick(350)
  assert.equal(audios[1].plays, 1)
  assert.equal(playback.status().speechKind, 'dialogue')
  assert.equal(playback.status().dialogueRequestId, 'chat')
  audios[1].onended()
  t.mock.timers.tick(1600)
  assert.equal(playback.musicGain, 1)
  assert.equal(playback.sessionId, session)
  assert.equal(playback.status().interjectionCount, 0)
  assert.deepEqual(playback.status().preparedKeys, ['wy:next'])
  assert.equal((await playback.speakDialogue(session, 'chat', 0, '重试', 'audio', () => true)).duplicate, true)
  assert.equal(audios.length, 2)
  playback.cancel()
})

test('chat waits for formal host and respects cancellation during audio load', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture(8)
  await prepare(playback)
  playback.beforeSong('wy:next', () => {})
  assert.equal((await playback.speakDialogue(playback.sessionId, 'chat', 0, '回答', 'audio', () => true)).reason, 'busy')
  playback.songChanged()
  let valid = true
  const loading = playback.speakDialogue(playback.sessionId, 'cancelled', 0, '回答', 'audio', () => valid)
  valid = false
  assert.equal((await loading).reason, 'stale')
  assert.equal(audios[1].plays, 0)
  await playback.speakDialogue(playback.sessionId, 'active', 0, '回答', 'audio', () => true)
  t.mock.timers.tick(650)
  assert.equal(audios[2].plays, 1)
  playback.cancelDialogue('different')
  assert.equal(playback.status().dialogueRequestId, 'active')
  playback.cancelDialogue('active')
  assert.equal(audios[2].onended, null)
  t.mock.timers.tick(1600)
  assert.equal(playback.musicGain, 1)
  playback.cancel()
})

test('chat yields to scheduled interjections and cannot survive a new programme', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback } = fixture(8)
  playback.updateSong(20, 300, true)
  await playback.planInterjection(playback.sessionId, 'wy:current', '插播', 'audio',
    { atSeconds: 30, volume: 0.2, fadeDownSeconds: 0.5, restoreSeconds: 1 }, () => true, () => ({ progress: 20, duration: 300 }))
  assert.equal((await playback.speakDialogue(playback.sessionId, 'chat', 0, '回答', 'audio', () => true)).reason, 'busy')
  playback.cancel()
  const oldSession = playback.sessionId
  const loading = playback.speakDialogue(oldSession, 'late', 0, '回答', 'audio', () => true)
  playback.configure(true)
  assert.equal((await loading).reason, 'stale')
  assert.equal(playback.musicGain, 1)
  playback.cancel()
})

test('paused chat resumes the voice and audio errors restore music without skipping songs', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture(8)
  playback.updateSong(20, 300, true)
  await playback.speakDialogue(playback.sessionId, 'pause', 0, '继续聊。', 'audio', () => true)
  t.mock.timers.tick(650)
  assert.equal(audios[0].plays, 1)
  assert.equal(playback.pause(), true)
  assert.equal(playback.resume(), true)
  assert.equal(audios[0].plays, 2)
  audios[0].onerror()
  t.mock.timers.tick(1600)
  assert.equal(playback.musicGain, 1)
  assert.equal(playback.status().dialogueResult.result, 'audio_failed')
  assert.equal(playback.status().interjectionCount, 0)
  assert.equal(playback.musicStarted, true)
  playback.cancel()
})

test('diagnostic speech restores music without advancing songs or consuming host cues', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture(3)
  assert.equal((await playback.announceProgress('正在查歌曲资料。', 'data:audio/mpeg;base64,SUQz')).played, true)
  t.mock.timers.tick(250)
  assert.equal(audios[0].plays, 1)
  assert.equal(playback.status().speechKind, 'progress')
  audios[0].onended()
  t.mock.timers.tick(500)
  assert.equal(playback.musicGain, 1)
  assert.equal(playback.musicStarted, false)
  assert.equal(playback.status().interjectionCount, 0)
  assert.deepEqual(playback.status().recentSpeech, [])
  assert.equal((await playback.announceProgress('另一条日志。', 'audio')).played, false)
  playback.cancel()
})

test('formal opening preempts diagnostic audio without losing prepared speech', async(t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture(3)
  await prepare(playback)
  await playback.announceProgress('正在查歌曲资料。', 'audio')
  t.mock.timers.tick(250)
  let started = 0
  assert.equal(playback.beforeSong('wy:next', () => { started++ }), true)
  assert.equal(playback.status().speechKind, 'intro')
  assert.equal(audios[1].onended, null)
  assert.equal(started, 0)
  audios[0].onended()
  assert.equal(started, 1)
  playback.cancel()
})

test('diagnostic speech rejects long audio and paused or speaking playback', async() => {
  const { playback } = fixture()
  assert.equal((await playback.announceProgress('正在查资料。', 'audio')).reason, 'stale_or_too_long')
  playback.pause()
  assert.equal((await playback.announceProgress('正在查资料。', 'audio')).played, false)
  playback.resume()
  await prepare(playback)
  playback.beforeSong('wy:next', () => {})
  assert.equal((await playback.announceProgress('正在查资料。', 'audio')).played, false)
  playback.cancel()
})

test('intro sentence cue starts music once at normal volume, regardless of old duck settings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  const gains = []
  playback.setMusicGainHandler(gain => gains.push(gain))
  await playback.prepare(playback.sessionId, 'wy:next', '故事。一起听。', 'audio', () => true,
    { afterText: '故事。', volume: 0.15, fadeInSeconds: 1, restoreSeconds: 2 })
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  const audio = audios[0]
  audio.duration = 20
  audio.currentTime = 5
  audio.ontimeupdate()
  assert.equal(starts, 0)
  audio.currentTime = 9
  audio.ontimeupdate()
  assert.equal(starts, 1)
  assert.equal(playback.status().musicStarted, true)
  t.mock.timers.tick(1000)
  assert.equal(gains.at(-1), 1)
  audio.ontimeupdate()
  audio.onended()
  assert.equal(starts, 1)
  t.mock.timers.tick(2000)
  assert.equal(gains.at(-1), 1)
})

test('pausing blocks the intro cue and skipping rejects late cues', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await playback.prepare(playback.sessionId, 'wy:next', '前。后。', 'audio', () => true,
    { afterText: '前。', volume: 0.2, fadeInSeconds: 1, restoreSeconds: 2 })
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  const audio = audios[0]
  audio.duration = 20; audio.currentTime = 12
  playback.pause()
  audio.ontimeupdate()
  assert.equal(starts, 0)
  playback.resume()
  audio.ontimeupdate()
  assert.equal(starts, 1)
  playback.pause()
  t.mock.timers.tick(1000)
  assert.equal(playback.musicGain, 1)
  const lateCue = audio.ontimeupdate
  playback.songChanged()
  lateCue()
  assert.equal(starts, 1)
  assert.equal(playback.musicGain, 1)
})

test('disabling radio during an intro keeps normal volume without replaying the song', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await playback.prepare(playback.sessionId, 'wy:next', '前。后。', 'audio', () => true,
    { afterText: '', volume: 0.2, fadeInSeconds: 1, restoreSeconds: 2 })
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  audios[0].duration = 10; audios[0].currentTime = 0.1
  audios[0].ontimeupdate()
  t.mock.timers.tick(300)
  assert.equal(playback.musicGain, 1)
  playback.configure(false)
  t.mock.timers.tick(4000)
  assert.equal(starts, 1)
  assert.equal(playback.musicGain, 1)
})

test('music starts once, after the ready introduction finishes', async () => {
  const { playback, audios } = fixture()
  await prepare(playback)
  let starts = 0
  assert.equal(playback.beforeSong('wy:next', () => starts++), true)
  assert.equal(starts, 0)
  audios[0].onended()
  assert.equal(starts, 1)
  assert.equal(playback.beforeSong('wy:next', () => starts++), false)
})
test('skipping cancels the old intro and its late completion cannot start an old song', async () => {
  const { playback, audios } = fixture()
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  const lateEnd = audios[0].onended
  playback.cancel()
  lateEnd()
  assert.equal(starts, 0)
  assert.equal(playback.status().phase, 'idle')
})
test('pause and resume operate on the introduction without starting music', async () => {
  const { playback, audios } = fixture()
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  assert.equal(playback.pause(), true)
  assert.equal(playback.status().phase, 'paused')
  assert.equal(playback.resume(), true)
  assert.equal(audios[0].plays, 2)
  assert.equal(starts, 0)
  playback.cancel()
})
test('a decoding error skips the intro; an error during pause stays paused', async () => {
  const { playback, audios } = fixture()
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  playback.pause()
  audios[0].onerror()
  assert.equal(starts, 0)
  playback.resume()
  await Promise.resolve()
  assert.equal(starts, 1)
})
test('a stale session and a changed target after loading reject prefetch', async () => {
  const { playback } = fixture()
  const oldSession = playback.sessionId
  playback.configure(true)
  assert.equal(await playback.prepare(oldSession, 'wy:next', '稿件', undefined, () => true), false)
  let valid = true
  const pending = playback.prepare(playback.sessionId, 'wy:next', '稿件', 'audio', () => valid)
  valid = false
  assert.equal(await pending, false)
  assert.deepEqual(playback.status().preparedKeys, [])
})
test('an unprepared song starts immediately; disabling radio continues a speaking song', async () => {
  const { playback } = fixture()
  assert.equal(playback.beforeSong('wy:missing', () => {}), false)
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  playback.configure(false)
  assert.equal(starts, 1)
  assert.equal(playback.status().enabled, false)
})
test('three songs use their own intros and receive music only after each announcement', async () => {
  const { playback, audios } = fixture()
  const order = []
  for (const song of ['one', 'two', 'three']) {
    await prepare(playback, `wy:${song}`)
    playback.beforeSong(`wy:${song}`, () => order.push(`music:${song}`))
    order.push(`intro:${song}`)
    audios.at(-1).onended()
  }
  assert.deepEqual(order, ['intro:one', 'music:one', 'intro:two', 'music:two', 'intro:three', 'music:three'])
})

test('a missing audio readiness event rejects preparation after a bounded wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const playback = new RadioPlayback(() => ({ load() {}, pause() {}, removeAttribute() {} }))
  playback.configure(true)
  const pending = playback.prepare(playback.sessionId, 'wy:next', '稿件', 'audio', () => true)
  t.mock.timers.tick(5001)
  assert.equal(await pending, false)
  assert.equal(playback.beforeSong('wy:next', () => {}), false)
})
test('a missing speech completion event cannot block music indefinitely', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { playback } = fixture()
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  t.mock.timers.tick(90001)
  assert.equal(starts, 1)
  assert.equal(playback.status().phase, 'idle')
})
test('exiting radio during a paused introduction preserves the user pause', async () => {
  const { playback } = fixture()
  await prepare(playback)
  let starts = 0
  playback.beforeSong('wy:next', () => starts++)
  playback.pause()
  playback.configure(false)
  assert.equal(starts, 0)
  assert.equal(playback.status().enabled, false)
})

test('default intro plays with normal music from the start', async () => {
  const { playback, audios } = fixture()
  await playback.prepare(playback.sessionId, 'wy:one', '片头', 'audio', () => true)
  let starts = 0
  playback.beforeSong('wy:one', () => starts++)
  assert.equal(starts, 1)
  assert.equal(playback.musicGain, 1)
  audios[0].onended()
  assert.equal(starts, 1)
})

test('voice boost is applied before the first intro frame and still respects volume and mute', async () => {
  const { playback, audios } = fixture()
  playback.configure(true, 1.6)
  playback.setVolume(0.35, false)
  await prepare(playback)
  let firstVolume
  audios[0].play = () => { firstVolume = audios[0].volume; return Promise.resolve() }
  playback.beforeSong('wy:next', () => {})
  assert.equal(firstVolume, 0.35 * 1.6)
  playback.setVolume(0.8, true)
  assert.equal(audios[0].volume, 1)
  assert.equal(audios[0].muted, true)
  playback.setVolume(0, false)
  assert.equal(audios[0].volume, 0)
  playback.cancel()
})

test('completed interjection exposes its end position and allows a later second model cue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  const session = playback.sessionId
  const plan = { atSeconds: 100, volume: 0.16, fadeDownSeconds: 1, restoreSeconds: 2 }
  const clock = () => ({ progress: 10, duration: 300 })
  assert.equal((await playback.planInterjection(session, 'wy:first', '第一句喔。', 'audio', plan, () => true, clock)).prepared, true)
  playback.updateSong(99, 300, true)
  t.mock.timers.tick(1000)
  playback.updateSong(108, 300, true)
  audios[0].onended()
  t.mock.timers.tick(2000)
  assert.equal(playback.status().interjectionCount, 1)
  assert.equal(playback.status().lastInterjectionProgress, 108)
  assert.equal((await playback.planInterjection(session, 'wy:first', '太密。', 'audio', { ...plan, atSeconds: 140 }, () => true,
    () => ({ progress: 110, duration: 300 }))).prepared, false)
  assert.equal((await playback.planInterjection(session, 'wy:first', '换个角度。', 'audio', { ...plan, atSeconds: 200 }, () => true,
    () => ({ progress: 110, duration: 300 }))).prepared, true)
  playback.pause(); playback.resume()
  assert.equal(playback.status().recentSpeech.length, 1)
  playback.songChanged()
  assert.equal(playback.status().interjectionCount, 0)
  assert.equal(playback.status().lastInterjectionProgress, null)
  playback.cancel()
})

test('interjection mix raises music by ten percent and lowers voice by ten percent without changing openings', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  playback.configure(true, 1.6, 1.1, 0.9)
  playback.setVolume(0.35, false)
  await interjection(playback)
  playback.updateSong(39, 100, true)
  t.mock.timers.tick(1000)
  assert.equal(playback.musicGain, 0.2 * 1.1)
  assert.equal(audios[0].volume, 0.35 * 1.6 * 0.9)
  playback.setVolume(0.8, false)
  assert.equal(audios[0].volume, 0.9)
  audios[0].onended()
  t.mock.timers.tick(2000)
  assert.equal(playback.musicGain, 1)
  await prepare(playback)
  playback.beforeSong('wy:next', () => {})
  assert.equal(audios[1].volume, 1)
  playback.cancel()
})

async function interjection(playback, atSeconds = 40, valid = () => true, clock = () => ({ progress: 10, duration: 100 })) {
  return playback.planInterjection(playback.sessionId, 'wy:one', '歌中的一句话', 'audio',
    { atSeconds, volume: 0.2, fadeDownSeconds: 1, restoreSeconds: 2 }, valid, clock)
}

test('interjection follows song progress, ducks before speech and restores smoothly without restarting music', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  playback.setVolume(0.35, false)
  assert.equal((await interjection(playback)).prepared, true)
  playback.updateSong(38, 100, true)
  assert.equal(audios[0].plays, 0)
  playback.updateSong(39, 100, true)
  assert.equal(playback.status().phase, 'ducking')
  assert.equal(audios[0].plays, 0)
  t.mock.timers.tick(1000)
  assert.equal(audios[0].plays, 1)
  assert.equal(audios[0].volume, 0.35)
  assert.equal(playback.musicGain, 0.2)
  assert.equal(playback.status().speechKind, 'interjection')
  audios[0].onended()
  assert.equal(playback.status().phase, 'restoring')
  t.mock.timers.tick(1000)
  assert.ok(playback.musicGain > 0.2 && playback.musicGain < 1)
  t.mock.timers.tick(1000)
  assert.equal(playback.musicGain, 1)
  playback.updateSong(39, 100, true)
  assert.equal(audios[0].plays, 1)
})

test('pause during ducking cannot start speech and resume completes the fade', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await interjection(playback)
  playback.updateSong(39, 100, true)
  t.mock.timers.tick(300)
  playback.pause()
  const gain = playback.musicGain
  t.mock.timers.tick(5000)
  assert.equal(audios[0].plays, 0)
  assert.equal(playback.musicGain, gain)
  playback.resume()
  t.mock.timers.tick(750)
  assert.equal(audios[0].plays, 1)
  playback.cancel()
})

test('skipping during ducking rejects the late fade, and seeking beyond a cue skips it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await interjection(playback)
  playback.updateSong(39, 100, true)
  playback.songChanged()
  t.mock.timers.tick(3000)
  assert.equal(audios[0].plays, 0)
  assert.equal(playback.musicGain, 1)
  await interjection(playback)
  playback.updateSong(60, 100, true)
  assert.equal(audios[1].plays, 0)
  assert.equal(playback.status().interjectionResult, 'missed')
})

test('late, stale or too-long interjections never interrupt music; model can choose no interjection', async () => {
  const { playback, audios } = fixture()
  assert.equal((await interjection(playback, 11)).prepared, false)
  assert.equal((await interjection(playback, 95)).prepared, false)
  assert.equal((await interjection(playback, 40, () => false)).reason, 'stale')
  assert.equal(audios.every(audio => audio.plays === 0), true)
  assert.equal((await playback.planInterjection(playback.sessionId, 'wy:one', '', undefined, null,
    () => true, () => ({ progress: 10, duration: 100 }))).reason, 'declined')
  assert.equal(playback.status().interjectionDecided, true)
  assert.equal(playback.musicGain, 1)
})

test('decode failure during an interjection restores gain and never calls a song continuation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await interjection(playback)
  playback.updateSong(39, 100, true)
  t.mock.timers.tick(1000)
  audios[0].onerror()
  t.mock.timers.tick(2000)
  assert.equal(playback.musicGain, 1)
  assert.equal(playback.status().phase, 'idle')
})

test('a paused error before speech restores on resume without speaking an empty audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  await interjection(playback)
  playback.updateSong(39, 100, true)
  playback.pause()
  audios[0].onerror()
  playback.resume()
  await Promise.resolve()
  t.mock.timers.tick(2000)
  assert.equal(audios[0].plays, 0)
  assert.equal(playback.musicGain, 1)
})

test('newer decisions supersede in-flight decode and volume/mute changes remain effective during speech', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const { playback, audios } = fixture()
  const old = interjection(playback)
  const newer = interjection(playback, 50)
  assert.equal((await old).reason, 'stale')
  assert.equal((await newer).prepared, true)
  playback.updateSong(49, 100, true)
  t.mock.timers.tick(1000)
  playback.setVolume(0.6, true)
  assert.equal(audios[1].volume, 0.6)
  assert.equal(audios[1].muted, true)
  assert.equal(playback.musicGain, 0.2)
  audios[1].onended()
  t.mock.timers.tick(2000)
  assert.equal(playback.musicGain, 1)
})

function urlFixture() {
  const actionFile = path.resolve(__dirname, '../src/renderer/core/player/action.ts')
  const song = { id: 'one', source: 'wy', meta: {} }
  const state = { isPlay: { value: true }, playMusicInfo: { musicInfo: song } }
  const resources = []
  let resolveUrl
  let empty = true
  const dependencies = {
    '@renderer/plugins/player': { isEmpty: () => empty, setResource: url => resources.push(url) },
    '@renderer/store/player/state': state,
    '@renderer/store/player/action': { setAllStatus() {} },
    '@renderer/store/setting': { appSetting: { 'player.autoSkipOnError': false } },
    '../music/index': { getMusicUrl: () => new Promise(resolve => { resolveUrl = resolve }) },
    './utils': {}, '@renderer/utils/message': { requestMsg: {} }, '@renderer/utils/index': {},
    '@renderer/store/list/action': {}, '@renderer/store/list/state': {}, '@common/constants': {},
    '@renderer/core/dislikeList': {}, '@renderer/core/radio/playback': { radioPlayback: { allowsMusic: true } },
    '@renderer/store/player/volume': {},
    '@renderer/core/radio/resource': {},
    '@renderer/core/radio/matching': matchingRuntime.exports,
    '@renderer/core/radio/sources': { configureRadioSources: async () => {} },
  }
  const action = new Module(actionFile, module)
  action.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `missing fixture dependency: ${name}`)
    return dependencies[name]
  }
  action._compile(ts.transpileModule(fs.readFileSync(actionFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, actionFile)
  return { action: action.exports, song, state, resources, resolve: url => resolveUrl(url), setEmpty: value => { empty = value } }
}

test('normal-volume opening cannot discard the in-flight music URL just because speech marks UI playing', async () => {
  const previousWindow = global.window
  global.window = { lx: { isPlayedStop: false }, app_event: { error() {} }, i18n: { t: text => text } }
  try {
    const fixture = urlFixture()
    fixture.action.setMusicUrl(fixture.song)
    await new Promise(resolve => setImmediate(resolve))
    fixture.resolve('https://music.example/one.mp3')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(fixture.resources, ['https://music.example/one.mp3'])
    const stale = urlFixture()
    stale.action.setMusicUrl(stale.song)
    await new Promise(resolve => setImmediate(resolve))
    stale.state.playMusicInfo.musicInfo = { id: 'other', meta: {} }
    stale.resolve('https://music.example/old.mp3')
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(stale.resources, [])
  } finally {
    global.window = previousWindow
  }
})

function radioBridgeFixture({ missingFirst = false, invalidFirstAudio = false, firstResults } = {}) {
  const { playback, audios } = fixture()
  playback.configure(true, 1.6)
  playback.setVolume(0.35, false)
  const order = []
  const first = { id: 'first', source: 'wy', name: '晴天', singer: '周杰伦', meta: {} }
  const second = { id: 'second', source: 'wy', name: '后来', singer: '刘若英', meta: {} }
  const tempListMeta = { id: '' }
  let dispatcher, respond
  const dependencies = {
    '@common/rendererIpc': {
      rendererOn: (_event, handler) => { dispatcher = handler },
      rendererSend: (_event, response) => respond(response),
    },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
    '@common/utils/vueTools': { watch() {}, markRaw: value => value },
    '@renderer/utils': { deduplicationList: list => list },
    '@renderer/core/radio/search': { searchRadioMusic: async keyword => {
      if (keyword.includes('晴天')) return missingFirst ? [] : firstResults ?? [first]
      return [second]
    } },
    '@renderer/store/player/state': { playMusicInfo: {}, playInfo: {}, isPlay: { value: false } },
    '@renderer/store/list/action': { setTempList: async id => { order.push('queue'); tempListMeta.id = id } },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/action': {},
    '@renderer/core/player': { playList() {
      order.push('play')
      playback.songChanged()
      assert.equal(playback.beforeSong('wy:first', () => order.push('music')), true)
      order.push('voice')
    } },
    '@renderer/core/radio/playback': { radioPlayback: playback, songKey: song => `${song.source}:${song.id}` },
    '@renderer/core/radio/mode': { miniRadioMode: { value: false } },
    '@renderer/core/radio/queue': queueRuntime.exports,
    '@renderer/core/radio/matching': matchingRuntime.exports,
    '@renderer/core/radio/hostSettings': { getHostSettings: async () => ({ ok: false }) },
    '@renderer/core/radio/sources': { configureRadioSources: async () => {} },
    '@renderer/core/music': { getMusicUrl: async() => {
      if (invalidFirstAudio) throw new Error('short_audio')
      return 'validated-first-song'
    } },
    '@renderer/core/radio/resource': {},
    '@renderer/plugins/player': {}, '@renderer/core/music/utils': {}, '@renderer/core/apiSource': {},
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/setting': { appSetting: {} }, '@renderer/utils/ipc': {}, '@renderer/store': {},
  }
  const file = path.resolve(__dirname, '../src/renderer/core/useApp/useMcp.ts')
  const bridge = new Module(file, module)
  bridge.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `missing bridge dependency: ${name}`)
    return dependencies[name]
  }
  bridge._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, file)
  bridge.exports.default()
  return {
    playback, audios, order,
    invoke(params) {
      return new Promise(resolve => {
        respond = resolve
        dispatcher({ params: { requestId: 'test', method: 'play_songs', params } })
      })
    },
  }
}
const openingSongs = [{ name: '晴天', singer: '周杰伦' }, { name: '后来', singer: '刘若英' }]
const firstOpening = { text: '开场。进歌。', song: openingSongs[0], audioBase64: 'SUQz', musicCue: { afterText: '开场。' } }

test('MCP queue startup consumes the prepared first opening before entering music', async () => {
  const { invoke, audios, order, playback } = radioBridgeFixture()
  const response = await invoke({ songs: openingSongs, opening: firstOpening })
  assert.equal(response.error, undefined)
  assert.equal(response.result.openingPrepared, true)
  assert.deepEqual(order, ['queue', 'play', 'voice'])
  assert.equal(audios[0].plays, 1)
  assert.equal(audios[0].volume, 0.35 * 1.6)
  assert.equal(playback.musicGain, 1)
  audios[0].currentTime = 4.1
  audios[0].ontimeupdate()
  assert.equal(order.at(-1), 'music')
  playback.cancel()
})

test('MCP refuses to start radio without opening or attach a missing first song story to another song', async () => {
  for (const missingFirst of [false, true]) {
    const { invoke, order, playback } = radioBridgeFixture({ missingFirst })
    const response = await invoke({ songs: openingSongs, ...(missingFirst ? { opening: firstOpening } : {}) })
    assert.equal(response.result.played, false)
    assert.equal(response.result.reason, missingFirst ? 'no_matching_song' : 'opening_required')
    assert.deepEqual(order, [])
    playback.cancel()
  }
})

test('a failed first-song audio preflight returns to the agent without starting another song under the old opening', async () => {
  const { invoke, order, playback } = radioBridgeFixture({ invalidFirstAudio: true })
  const response = await invoke({ songs: openingSongs, opening: firstOpening })
  assert.equal(response.result.played, false)
  assert.equal(response.result.reason, 'opening_song_unavailable')
  assert.deepEqual(response.result.failed, [openingSongs[0]])
  assert.deepEqual(order, [])
  playback.cancel()
})


test('radio never substitutes a DJ version under an opening written for the original song', async () => {
  const { invoke, order, playback } = radioBridgeFixture({ firstResults: [
    { id: 'first', source: 'wy', name: '晴天 (DJ版)', singer: '周杰伦', interval: '04:00', meta: {} },
  ] })
  const response = await invoke({ songs: openingSongs, opening: firstOpening })
  assert.equal(response.result.played, false)
  assert.deepEqual(order, [])
  playback.cancel()
})


test('song matching accepts artist aliases while excluding covers, similar names and preview metadata', () => {
  const pick = matchingRuntime.exports.selectRadioSong
  const song = (id, name, singer, interval = '03:21') => ({ id, name, singer, interval })
  const wanted = { name: '跳楼机', singer: 'LBI利比' }
  const original = song('original', '跳楼机', 'LBI利比（时柏尘）')
  const list = [song('dj', '跳楼机 (DJ版)', 'LBI利比'), song('speed', '跳楼机 (1.1x)', 'LBI利比'),
    song('cover', '跳楼机', '其他歌手'), song('preview', '跳楼机', 'LBI利比', '00:30'), original]
  assert.equal(pick(list, wanted), original)
  assert.equal(pick([song('wrong', '晴天', '周杰伦翻唱')], { name: '晴天', singer: '周杰伦' }), undefined)
  assert.equal(pick(list.slice(0, 4), wanted), undefined)
  assert.equal(pick([original], { name: '跳楼机', singer: '时柏尘' }), original)
  const live = song('live', '跳楼机 (Live)', 'LBI利比')
  assert.equal(pick([original, live], { name: '跳楼机 (Live)', singer: 'LBI利比' }), live)
})


test('live host volume preserves playing speech, prepared audio and the radio session', async () => {
  const { playback, audios } = fixture()
  playback.setVolume(.3, false)
  await prepare(playback)
  playback.songChanged()
  playback.beforeSong('wy:next', () => {})
  const session = playback.sessionId, position = playback.positionId
  const plays = audios[0].plays
  playback.updateSettings({ 'speech.voice_gain': 2, 'radio.interjection_voice_gain': .8 })
  assert.equal(audios[0].volume, .6)
  assert.equal(audios[0].plays, plays)
  assert.equal(playback.sessionId, session)
  assert.equal(playback.positionId, position)
  assert.equal(playback.status().introduction, '下一首的故事')
  playback.cancel()
})


test('setting interjection count to zero cancels a pending cue without resetting the song', async () => {
  const { playback, audios } = fixture()
  playback.updateSong(10, 100, true)
  assert.equal((await interjection(playback)).prepared, true)
  const session = playback.sessionId, position = playback.positionId
  playback.updateSettings({ 'host.regular_interjections': 0 })
  assert.equal(playback.status().scheduledInterjection, null)
  playback.updateSong(40, 100, true)
  assert.equal(audios[0].plays, 0)
  assert.equal(playback.musicGain, 1)
  assert.equal(playback.sessionId, session)
  assert.equal(playback.positionId, position)
  playback.cancel()
})
