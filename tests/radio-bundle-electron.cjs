// Verify the shipped main + renderer bundles together. Build both before running.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-radio-bundle-'))
fs.mkdirSync(path.join(profile, 'LxDatas'))
fs.writeFileSync(path.join(profile, 'LxDatas/config_v2.json'), JSON.stringify({ setting: { 'mcp.enable': false } }))
app.setName('Radio Bundle Verification')
app.setPath('userData', profile)
app.commandLine.appendSwitch('lx-radio-session')
app.commandLine.appendSwitch('lx-radio-mini')
app.on('window-all-closed', () => {})
let server, played = 0
app.on('web-contents-created', (_event, contents) => contents.on('media-started-playing', () => { played++ }))
function taggedWave(title, artist) {
  const tag = (id, text) => {
    const value = Buffer.from(text + '\0')
    const chunk = Buffer.alloc(8 + value.length + value.length % 2)
    chunk.write(id); chunk.writeUInt32LE(value.length, 4); value.copy(chunk, 8)
    return chunk
  }
  const info = Buffer.concat([Buffer.from('INFO'), tag('INAM', title), tag('IART', artist)])
  const list = Buffer.alloc(8); list.write('LIST'); list.writeUInt32LE(info.length, 4)
  const wave = Buffer.alloc(44)
  wave.write('RIFF'); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(8000, 24)
  wave.writeUInt32LE(8000, 28); wave.writeUInt16LE(1, 32); wave.writeUInt16LE(8, 34)
  wave.write('data', 36); wave.writeUInt32LE(31 * 8000, 40)
  const bytes = Buffer.concat([wave.subarray(0, 36), list, info, wave.subarray(36), Buffer.alloc(31 * 8000, 128)])
  bytes.writeUInt32LE(bytes.length - 8, 4)
  return bytes
}
require('../dist/main.js')
;(async () => {
  await app.whenReady(); app.dock?.hide()
  server = http.createServer((_req, res) => {
    const bytes = taggedWave('旅行的意义', '陈绮贞')
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length })
    res.end(bytes)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let window
  for (let attempt = 0; attempt < 100; attempt++) {
    window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('index.html'))
    if (window && !window.webContents.isLoading() && await window.webContents.executeJavaScript("!!document.querySelector('.mini-radio-shell')")) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(window, 'built radio window must initialize')
  const url = `http://127.0.0.1:${server.address().port}/song`
  const check = song => window.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('winMain_radio_audio_identity',${JSON.stringify({ url, song })}).then(()=>({ok:true})).catch(error=>({ok:false,error:error.message}))`)
  assert.deepEqual(await check({ name: '旅行的意义', singer: '陈绮贞' }), { ok: true }, 'matching media must survive both production builds')
  const wrong = await check({ name: '安静', singer: '周杰伦' })
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /radio_audio_identity_mismatch/)
  assert.equal(played, 0)
  console.log(JSON.stringify({ passed: true, checks: ['bundled main and renderer boot', 'matching media accepted', 'wrong song rejected', 'zero audible playback'] }))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  if (server) await new Promise(resolve => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
})
