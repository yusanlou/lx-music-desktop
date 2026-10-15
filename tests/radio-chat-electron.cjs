// Real production UI + IPC + local HTTP, without cloud requests or audible playback.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const crypto = require('node:crypto')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-radio-chat-'))
const host = path.join(profile, 'host')
fs.mkdirSync(path.join(profile, 'LxDatas'))
fs.mkdirSync(path.join(host, '.logs'), { recursive: true })
fs.writeFileSync(path.join(profile, 'LxDatas/config_v2.json'), JSON.stringify({ setting: { version: '2.12.6', 'mcp.enable': false, 'common.isAgreePact': true } }))
process.env.LX_MINIAGENT_ROOT = host
app.setPath('userData', profile)
app.setName('Radio Chat Verification')
app.commandLine.appendSwitch('lx-radio-session')
app.commandLine.appendSwitch('lx-radio-mini')
app.on('window-all-closed', () => {})
const token = crypto.randomBytes(32).toString('hex')
const messages = []
let revision = 0, submissions = 0, played = 0, server
app.on('web-contents-created', (_event, contents) => contents.on('media-started-playing', () => { played++ }))
require('../dist/main.js')
async function waitFor(test, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await test()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('chat verification timed out')
}
;(async() => {
  await app.whenReady()
  app.dock?.hide()
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(403); res.end('{}'); return }
    const respond = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.url.startsWith('/state')) {
      const previous = Number(new URL(req.url, 'http://localhost').searchParams.get('revision'))
      respond(previous === revision ? { ok: true, ready: true, revision, unchanged: true }
        : { ok: true, ready: true, revision, messages, programmeStatus: '自动主持运行中' })
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const data = JSON.parse(body)
      if (req.url === '/cancel') {
        const record = messages.find(message => message.id === data.id)
        if (record.status === 'completed') { record.voiceStatus = 'cancelled'; record.voiceDetail = '语音已停止' } else record.status = 'cancelled'
        revision++
        respond({ ok: true, cancelled: true }); return
      }
      submissions++
      const record = { id: data.id, text: data.text, kind: data.kind, status: 'processing', stage: '查歌曲资料', reply: '', song: { name: '当前歌' } }
      messages.push(record); revision++
      respond({ ok: true, message: record }, 202)
      setTimeout(() => {
        if (record.status === 'cancelled') return
        record.status = 'completed'; record.reply = '这首歌的歌词很克制，让情绪留在音乐里。'
        record.voiceStatus = 'speaking'; record.voiceDetail = '主持人正在回复'; revision++
      }, 2000)
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  fs.writeFileSync(path.join(host, '.logs/radio-host.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, token, instance: 'test-instance' }))
  let win
  await waitFor(async() => {
    win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html'))
    return win && !win.webContents.isLoading() && await win.webContents.executeJavaScript("!!document.querySelector('.chat-send:not(:disabled)') || !!document.querySelector('.chat-actions button:not(:disabled)')")
  })
  const run = source => win.webContents.executeJavaScript(source)
  await run(`(() => {
    window.chatAudioPlays = [];
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(...args) {
      window.chatAudioPlays.push(this.currentSrc || this.src || '');
      return original.apply(this, args);
    };
  })()`)
  await run(`(() => {
    const input = document.querySelector('.chat-composer textarea');
    input.value = '聊聊这首歌'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  })()`)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(submissions, 0, 'IME confirmation must not send a message')
  await run(`(() => { const input = document.querySelector('textarea'); input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`)
  await waitFor(() => submissions === 1)
  await waitFor(async() => await run("!!document.querySelector('.chat-pending')"))
  await run(`(() => { const input = document.querySelector('textarea'); input.value = '还能继续输入'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  assert.equal(await run("document.querySelector('textarea').value"), '还能继续输入')
  await run("document.querySelector('.chat-pending button').click()")
  await waitFor(() => messages[0].status === 'cancelled')
  await run("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  await waitFor(() => submissions === 2)
  await waitFor(async() => await run("!!document.querySelector('.chat-reply')"))
  await waitFor(async() => await run("Array.from(document.querySelectorAll('.chat-pending button')).some(button => button.textContent === '停止语音')"))
  await run("Array.from(document.querySelectorAll('.chat-pending button')).find(button => button.textContent === '停止语音').click()")
  await waitFor(() => messages[1].voiceStatus === 'cancelled')
  assert.equal(messages[1].status, 'completed', 'stopping speech must retain the text answer')
  assert.ok(await run("!!document.querySelector('.chat-reply')"))
  const media = await run("window.chatAudioPlays.filter(url => url && !url.includes('Silence02s'))")
  assert.equal(media.length, 0, 'text chat must not start speech or music; the player startup silence is excluded')
  assert.ok(win.getSize()[1] >= 650, 'chat history should expand the mini window')
  const screenshot = await win.webContents.capturePage()
  const output = path.resolve(__dirname, '../.radio-preview/chat-ui.png')
  fs.writeFileSync(output, screenshot.toPNG())
  console.log(JSON.stringify({ passed: true, checks: ['production mini-player UI', 'local HTTP and IPC', 'IME enter', 'input during pending answer', 'cancel', 'reply rendering', 'stop voice keeps text', 'mock transport starts no media'], startupMediaEvents: played, screenshot: output }))
})().catch(error => { console.error(error); process.exitCode = 1 }).finally(async() => {
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  if (server) await new Promise(resolve => server.close(resolve))
  fs.rmSync(profile, { recursive: true, force: true })
  app.exit(process.exitCode || 0)
})
