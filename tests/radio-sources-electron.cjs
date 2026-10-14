// Real Chromium/preload integration. Run after build:renderer-scripts.
const { app, ipcMain, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const ts = require('typescript')
process.env.NODE_ENV = 'production'
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-radio-source-test-'))
app.setPath('userData', profile)
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
function compile(relative, dependencies = {}) {
  const file = path.resolve(__dirname, '../src/main/modules/radioSources', relative)
  const runtime = new Module(path.resolve(__dirname, '../dist/radio-source-test.cjs'), module)
  runtime.filename = runtime.id
  runtime.paths = module.paths
  runtime.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)
  runtime._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, runtime.filename)
  return runtime.exports
}
function wave(seconds) {
  const size = seconds * 8000
  const buffer = Buffer.alloc(44 + size, 128)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(8000, 28)
  buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write('data', 36)
  buffer.writeUInt32LE(size, 40)
  return buffer
}
function taggedWave(seconds, title, artist) {
  const chunk = (name, value) => {
    const text = Buffer.from(value + '\0', 'utf8')
    const bytes = Buffer.alloc(8 + text.length + (text.length % 2))
    bytes.write(name); bytes.writeUInt32LE(text.length, 4); text.copy(bytes, 8)
    return bytes
  }
  const tags = Buffer.concat([Buffer.from('INFO'), chunk('INAM', title), chunk('IART', artist)])
  const header = Buffer.alloc(8); header.write('LIST'); header.writeUInt32LE(tags.length, 4)
  const audio = wave(seconds)
  const result = Buffer.concat([audio.subarray(0, 36), header, tags, audio.subarray(36)])
  result.writeUInt32LE(result.length - 8, 4)
  return result
}
let server
app.whenReady().then(async () => {
  app.dock?.hide()
  let broken = false, escaped = 0, updates = 0, played = 0
  ipcMain.on('userApi_init', () => { escaped++ })
  ipcMain.on('userApi_response', () => { escaped++ })
  ipcMain.on('userApi_showUpdateAlert', () => { updates++ })
  app.on('web-contents-created', (_event, contents) => contents.on('media-started-playing', () => { played++ }))
  server = http.createServer((req, res) => {
    if (req.url !== '/no-cors') res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.url === '/old' && broken) { res.writeHead(503); res.end(); return }
    const duration = req.url === '/no-cors' ? 201 : req.url === '/minute-preview' ? 60 : req.url === '/short' ? 6 : req.url === '/preview' ? 30 : 31
    const bytes = req.url === '/wrong-song' ? taggedWave(297, '自由的你', 'G.E.M.邓紫棋') : req.url === '/right-song' ? taggedWave(279, '幸福在歌唱', 'A-Lin') : wave(duration)
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Content-Length', bytes.length)
    res.end(bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const identity = compile('identity.ts', { '@common/radioIdentity': compile('../../../common/radioIdentity.ts'), '@common/utils/request': { request: async (url, options) => {
    const response = await fetch(url, { headers: options.headers, signal: options.signal })
    return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: require('node:stream').Readable.fromWeb(response.body) }
  } } })
  const { probeSource, closeSourceProbes } = compile('runtime.ts', { '../userApi/main': { getProxy: () => ({ host: '', port: '' }) }, '@common/radioAudio': compile('../../../common/radioAudio.ts'), './identity': identity })
  const { RadioSourcePool } = compile('pool.ts')
  const request = { source: 'kg', action: 'musicUrl', info: { type: '128k', musicInfo: { songmid: 'song' } } }
  const provider = (id, route, init = true) => ({ id, name: id, script: `/* @name ${id} */
    lx.on(lx.EVENT_NAMES.request, async () => ${JSON.stringify(base + route)});
    lx.send(lx.EVENT_NAMES.updateAlert, {log: 'must stay silent'});
    ${init ? `lx.send(lx.EVENT_NAMES.inited, {sources: {kg: {type: 'music', actions: ['musicUrl'], qualitys: ['128k']}}});` : ''}` })
  const pool = new RadioSourcePool(probeSource)
  pool.configure(true)
  pool.merge([provider('init-timeout', '/full', false), provider('short', '/short'), provider('preview', '/preview'), provider('old', '/old'), provider('backup', '/full')])
  await assert.rejects(probeSource(pool.sources[0], request, 500), /timeout/)
  pool.sources.shift()
  const initial = await pool.resolve(request)
  assert.equal(initial.provider, 'old')
  broken = true
  pool.reject(initial.url)
  assert.equal((await pool.resolve(request, true)).provider, 'backup')
  const noCors = await probeSource(provider('no-cors', '/no-cors'), request, 3000)
  assert.equal(noCors.duration, 201)
  await assert.rejects(probeSource(provider('minute-preview', '/minute-preview'),
    { ...request, info: { ...request.info, musicInfo: { ...request.info.musicInfo, interval: '03:21' } } }, 3000), /incomplete_audio/)
  await assert.rejects(probeSource(provider('wrong-song', '/wrong-song'),
    { ...request, info: { ...request.info, musicInfo: { name: '幸福在歌唱', singer: 'A-Lin', interval: '04:39' } } }, 5000), /identity_mismatch/)
  const identityRequest = { ...request, info: { ...request.info, musicInfo: { name: '幸福在歌唱', singer: 'A-Lin', interval: '04:39' } } }
  const identityPool = new RadioSourcePool(probeSource)
  identityPool.configure(true); identityPool.merge([provider('wrong', '/wrong-song'), provider('right', '/right-song')])
  assert.equal((await identityPool.resolve(identityRequest)).provider, 'right')
  assert.equal(identityPool.status().lastResolution.attempts[0].reason, 'radio_audio_identity_mismatch')
  await assert.rejects(identity.validateRadioAudioIdentity(base + '/right-song', { name: '自由的你', singer: 'G.E.M.邓紫棋' }), /identity_mismatch/)
  assert.equal(escaped, 0); assert.equal(updates, 0); assert.equal(played, 0)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  assert.equal(ipcMain.eventNames().filter(name => String(name).startsWith('radio_')).length, 0)
  const pending = probeSource(provider('cancelled', '/full', false), request, 20_000)
  setTimeout(closeSourceProbes, 100)
  await assert.rejects(pending, /closed/)
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  console.log(JSON.stringify({ passed: true, cases: ['init timeout', '6s placeholder', '30s preview', '31s song', 'active provider HTTP503 failover', 'no global IPC/update alerts', 'full audio without CORS headers', '60s preview rejected using song duration', 'mismatched media tags rejected', 'wrong song provider falls through to matching song', 'same URL rechecked against each requested song', 'zero audio plays', 'window/listener cleanup', 'cancelled probe cleanup'] }))
  if (process.env.LX_RADIO_LIVE_CANDIDATES) {
    const candidates = JSON.parse(fs.readFileSync(process.env.LX_RADIO_LIVE_CANDIDATES, 'utf8'))
    const liveRequest = { source: 'wy', action: 'musicUrl', info: { type: '128k', musicInfo: {
      songmid: 190449, name: '吻别', singer: '张学友', source: 'wy', interval: '05:02', albumName: '吻别',
      types: [{ type: '128k' }], _types: { '128k': {} }, typeUrl: {},
    } } }
    const evidence = []
    const picks = candidates
    for (const candidate of picks) {
      const started = Date.now()
      try {
        await probeSource(candidate, liveRequest, 18_000)
        evidence.push({ name: candidate.name, passed: true, elapsedMs: Date.now() - started })
      } catch (error) {
        evidence.push({ name: candidate.name, passed: false, reason: error.message, elapsedMs: Date.now() - started })
      }
      console.log(JSON.stringify(evidence.at(-1)))
    }
    const output = process.env.LX_RADIO_LIVE_EVIDENCE
    if (output) fs.writeFileSync(output, JSON.stringify(evidence, null, 2))
  }
}).catch(error => {
  console.error(error); process.exitCode = 1
}).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
})
