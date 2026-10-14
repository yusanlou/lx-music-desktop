import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getProxy } from '../userApi/main'
import { getRadioAudioMinimum } from '@common/radioAudio'
import { type RadioSource, type RadioSourceRequest, type RadioSourceResult } from './pool'
import { validateRadioAudioIdentity } from './identity'

const windows = new Set<Electron.BrowserWindow>()
export const closeSourceProbes = () => {
  for (const window of windows) if (!window.isDestroyed()) window.destroy()
}

// Each attempt is disposable. A hung/failed provider cannot corrupt another
// provider's IPC state or clear the user's normal browser/audio session.
export const probeSource = async(source: RadioSource, request: RadioSourceRequest, timeout: number): Promise<RadioSourceResult> => {
  const channel = `radio_${randomBytes(12).toString('hex')}`
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Reuse one radio-only, in-memory session so long listening sessions don't
      // accumulate one Chromium network context for every disposable probe.
      partition: 'radio-source-probes',
      disableDialogs: true,
      spellcheck: false,
      images: false,
      webgl: false,
      autoplayPolicy: 'document-user-activation-required',
      additionalArguments: [`--lx-user-api-channel=${channel}`],
      preload: process.env.NODE_ENV === 'production' ? path.join(__dirname, 'user-api-preload.js') : path.join(__dirname, '../dist/user-api-preload.js'),
    },
  })
  // eslint-disable-next-line n/no-callback-literal
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => { event.preventDefault() })
  window.webContents.on('will-redirect', event => { event.preventDefault() })
  window.webContents.on('will-attach-webview', event => { event.preventDefault() })
  windows.add(window)
  const listeners: Array<[string, (...args: any[]) => void]> = []
  let rejectDeadline: (error: Error) => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject })
  void deadline.catch(() => {})
  let phase = 'init'
  const timer = setTimeout(() => { rejectDeadline(new Error(`radio_source_${phase}_timeout`)) }, timeout)
  window.on('closed', () => { rejectDeadline(new Error('radio_source_closed')) })
  const wait = async(name: string) => Promise.race([deadline, new Promise<any>((resolve, reject) => {
    const listener = (event: Electron.IpcMainEvent, message: any) => {
      if (event.sender !== window.webContents) return
      if (!message.status) reject(new Error(`radio_source_${name}_failed`))
      else resolve(message.data)
    }
    const fullName = `${channel}_${name}`
    listeners.push([fullName, listener])
    ipcMain.on(fullName, listener)
  })])
  window.webContents.on('render-process-gone', () => { rejectDeadline(new Error('radio_source_crashed')) })
  try {
    const proxy = getProxy()
    await Promise.race([deadline, window.webContents.session.setProxy(proxy.host
      ? { mode: 'fixed_servers', proxyRules: `${proxy.host}:${proxy.port}` }
      : { mode: 'direct' })])
    const initialized = wait('init')
    // Install the rejection observer before awaiting loadURL.
    void initialized.catch(() => {})
    await Promise.race([deadline, window.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; media-src http: https:">'))])
    window.webContents.send(`${channel}_initEnv`, { ...source, proxy })
    const info = await initialized
    const platform = info.sources?.[request.source]
    if (!platform?.actions.includes('musicUrl')) throw new Error('radio_source_unsupported')
    const quality = platform.qualitys.includes(request.info.type) ? request.info.type : platform.qualitys.includes('128k') ? '128k' : platform.qualitys[0]
    if (!quality) throw new Error('radio_source_unsupported')
    phase = 'request'
    const response = wait('response')
    window.webContents.send(`${channel}_request`, { requestKey: channel, data: { ...request, info: { ...request.info, type: quality } } })
    const result = await response
    const url = result.result?.data?.url
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('radio_source_invalid_url')
    // Probe metadata without ever playing audio. Search duration can describe a
    // full song while the actual server returns a 6/30-second placeholder.
    phase = 'audio'
    const minimumDuration = getRadioAudioMinimum(request.info.musicInfo.interval)
    const metadata = window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const audio = new Audio(); audio.preload = 'metadata';
      audio.muted = true; audio.volume = 0; audio.autoplay = false;
      const finish = (error) => { const duration = audio.duration; clearTimeout(timer); audio.onloadedmetadata = audio.ondurationchange = audio.oncanplay = audio.onerror = null;
        audio.pause(); audio.removeAttribute('src'); audio.load(); error ? reject(new Error(error)) : resolve(duration); };
      const check = () => { if (Number.isFinite(audio.duration) && audio.duration > 0) finish(audio.duration <= 30.25 ? 'short_audio' : audio.duration < ${minimumDuration} ? 'incomplete_audio' : null); };
      const timer = setTimeout(() => finish('invalid_audio'), 8000);
      audio.onloadedmetadata = audio.ondurationchange = audio.oncanplay = check;
      audio.onerror = () => finish('invalid_audio'); audio.src = ${JSON.stringify(url)}; audio.load();
    })`)
    const duration = await Promise.race([metadata, deadline])
    if (request.info.musicInfo.name) {
      phase = 'identity'
      await Promise.race([validateRadioAudioIdentity(url, request.info.musicInfo as { name: string, singer?: string }), deadline])
    }
    return { url, type: quality, provider: source.id, duration }
  } finally {
    clearTimeout(timer)
    for (const [name, listener] of listeners) ipcMain.removeListener(name, listener)
    windows.delete(window)
    if (!window.isDestroyed()) window.destroy()
  }
}
