import path from 'node:path'
import nodeProcess from 'node:process'
import fs from 'node:fs'
import { execFile } from 'node:child_process'

// The launcher supplies its trusted checkout; renderer input never supplies paths.
export const radioHostRoot = () => nodeProcess.env.LX_MINIAGENT_ROOT ?? path.resolve(__dirname, '../../miniagent')
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
