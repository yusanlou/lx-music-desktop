// Production renderer + IPC + real HTMLAudio decoding. Audio output is muted.
const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-radio-voice-'))
fs.mkdirSync(path.join(profile, 'LxDatas'))
fs.writeFileSync(path.join(profile, 'LxDatas/config_v2.json'), JSON.stringify({ setting: {
  version: '2.12.6', 'mcp.enable': false, 'common.isAgreePact': true,
} }))
app.setPath('userData', profile)
app.setName('Radio Voice Verification')
app.commandLine.appendSwitch('lx-radio-session')
app.commandLine.appendSwitch('lx-radio-mini')
app.on('window-all-closed', () => {})
app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true))
require('../dist/main.js')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await test()) return; await delay(100) }
  throw new Error('voice verification timed out')
}
function wave() {
  const bytes = Buffer.alloc(44 + 8000 * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(8000, 28); bytes.writeUInt16LE(1, 32)
  bytes.writeUInt16LE(8, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40)
  bytes.fill(128, 44)
  return bytes
}
;(async() => {
  await app.whenReady(); app.dock?.hide()
  let win
  await until(async() => {
    win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'))
    return win && !win.webContents.isLoading() && await win.webContents.executeJavaScript("!!document.querySelector('.mini-radio-shell')")
  })
  const invoke = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const listener = (_event, result) => {
      if (result.requestId !== requestId) return
      clearTimeout(timer); ipcMain.removeListener('winMain_mcp_response', listener)
      if (result.error) reject(new Error(result.error)); else resolve(result.result)
    }
    const timer = setTimeout(() => { ipcMain.removeListener('winMain_mcp_response', listener); reject(new Error(method + ' timed out')) }, 15000)
    ipcMain.on('winMain_mcp_response', listener)
    win.webContents.send('winMain_mcp_invoke', { requestId, method, params })
  })
  await win.webContents.executeJavaScript(`(() => {
    window.voiceVerification = { plays: 0, audio: null };
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      if ((this.src || '').startsWith('data:audio/mpeg')) { window.voiceVerification.plays++; window.voiceVerification.audio = this; }
      return original.apply(this, args);
    };
  })()`)
  const state = await invoke('set_radio_mode', { enabled: true })
  const audioPath = process.env.RADIO_CHAT_TEST_AUDIO
  const bytes = audioPath ? fs.readFileSync(audioPath) : wave()
  const params = { sessionId: state.sessionId, requestId: 'natural', part: 0,
    text: '我们边听边聊。', audioBase64: bytes.toString('base64') }
  assert.equal((await invoke('speak_radio_dialogue', params)).played, true)
  await until(async() => (await invoke('get_radio_state')).phase === 'speaking')
  assert.ok((await invoke('get_radio_state')).musicGain < 0.5)
  await until(async() => await win.webContents.executeJavaScript('window.voiceVerification.audio.currentTime > 0.3'))
  assert.equal((await invoke('speak_radio_dialogue', params)).duplicate, true)
  await until(async() => (await invoke('get_radio_state')).phase === 'idle', 30000)
  const completed = await invoke('get_radio_state')
  assert.equal(completed.dialogueResult.result, 'completed')
  assert.equal(completed.musicGain, 1)
  assert.equal(completed.interjectionCount, 0)
  assert.equal(completed.sessionId, state.sessionId)
  assert.equal(await win.webContents.executeJavaScript('window.voiceVerification.plays'), 1)
  assert.equal((await invoke('speak_radio_dialogue', { ...params, requestId: 'cancel' })).played, true)
  await until(async() => (await invoke('get_radio_state')).phase === 'speaking')
  await invoke('cancel_radio_request', { requestId: 'cancel' })
  await until(async() => (await invoke('get_radio_state')).phase === 'idle')
  assert.equal((await invoke('get_radio_state')).musicGain, 1)
  assert.equal(await win.webContents.executeJavaScript('window.voiceVerification.audio.paused'), true)
  await invoke('set_radio_mode', { enabled: false })
  console.log(JSON.stringify({ passed: true, realHostAudio: !!audioPath,
    checks: ['production voice dispatch', 'real audio decoded and clock advancing', 'duck and restore', 'natural completion', 'idempotent retry', 'cancel restores gain', 'no interjection quota consumed'] }))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
})
