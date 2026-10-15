import path from 'node:path'
import nodeProcess from 'node:process'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import http from 'node:http'

// The launcher supplies its trusted checkout; renderer input never supplies paths.
export const radioHostRoot = () => nodeProcess.env.LX_MINIAGENT_ROOT ?? path.resolve(__dirname, '../../miniagent')
export const radioHostConversation = async(operation: 'state' | 'send' | 'cancel', params: Record<string, any> = {}): Promise<any> => {
  try {
    const record = JSON.parse(await fs.promises.readFile(path.join(radioHostRoot(), '.logs/radio-host.json'), 'utf8'))
    if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(record.url) || !/^[a-f0-9]{64}$/.test(record.token)) throw new Error('invalid_record')
    const revision = Number.isInteger(params.revision) ? params.revision : -1
    const suffix = operation === 'state' ? `/state?revision=${revision}` : operation === 'send' ? '/messages' : '/cancel'
    const body = operation === 'state' ? undefined : JSON.stringify(operation === 'send'
      ? { id: params.id, text: params.text, kind: params.kind ?? 'auto', song: params.song } : { id: params.id })
    if (body && Buffer.byteLength(body) > 16000) return { ok: false, error: '消息过长' }
    return await new Promise(resolve => {
      const request = http.request(record.url + suffix, {
        method: body ? 'POST' : 'GET',
        timeout: 2500,
        headers: { Authorization: 'Bearer ' + record.token, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, response => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > 2 * 1024 * 1024) request.destroy(new Error('response_too_large'))
          else chunks.push(chunk)
        })
        response.on('error', () => { resolve({ ok: false, error: '主持人连接中断，请重试。' }) })
        response.on('end', () => {
          try { resolve({ ...JSON.parse(Buffer.concat(chunks).toString('utf8')), instance: record.instance }) } catch { resolve({ ok: false, error: '主持人返回格式不正确。' }) }
        })
      })
      request.on('timeout', () => { request.destroy(new Error('timeout')) })
      request.on('error', () => { resolve({ ok: false, error: '主持人暂未连接，请通过启动电台脚本启动。' }) })
      request.end(body)
    })
  } catch {
    return { ok: false, error: '主持人暂未连接，请通过启动电台脚本启动。' }
  }
}
let saving: Promise<any> = Promise.resolve()
export const radioHostSettings = async(patch?: Record<string, unknown>): Promise<any> => {
  const run = async() => {
    const root = radioHostRoot()
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    if (!fs.existsSync(python) || !fs.existsSync(path.join(root, 'radio.toml'))) return { ok: false, error: '未找到主持人项目，请使用电台启动脚本打开播放器。' }
    if (patch && (typeof patch !== 'object' || Array.isArray(patch))) return { ok: false, error: '配置格式不正确' }
    const body = JSON.stringify(patch ? { patch } : {})
    if (body.length > 60_000) return { ok: false, error: '配置内容过长' }
    return new Promise(resolve => {
      const child = execFile(python, ['-m', 'miniagent', 'host-settings'], { cwd: root, timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) { resolve({ ok: false, error: '主持人配置服务暂时不可用，请确认本地环境已安装。' }); return }
        try { resolve(JSON.parse(stdout)) } catch { resolve({ ok: false, error: '主持人配置返回格式不正确' }) }
      })
      child.stdin?.end(body)
    })
  }
  if (!patch) return run()
  const result = saving.catch(() => {}).then(run)
  saving = result
  return result
}
