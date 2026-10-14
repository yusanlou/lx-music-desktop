import http from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { getAddress } from '@common/utils/nodejs'
import { sendEvent, sendTaskbarButtonClick } from '@main/modules/winMain'
import { getApiList, importApi, removeApi } from '@main/modules/userApi'
import { mainOn, mainOffAll } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { LIST_IDS } from '@common/constants'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

let status: LX.MCP.Status = {
  status: false,
  message: '',
  address: '',
}

let httpServer: http.Server
let sockets = new Set<Socket>()

/* ------------------------------------------------------------------ *
 * 渲染进程桥接：主进程把无法直接执行的调用（搜索/点播/当前歌曲）转发到渲染进程
 * ------------------------------------------------------------------ */
const pendingCalls = new Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>()

const BRIDGE_TIMEOUT = 30000

const onBridgeResponse = ({ params }: { params: LX.MCP.BridgeResponse }) => {
  const pending = pendingCalls.get(params.requestId)
  if (!pending) return
  pendingCalls.delete(params.requestId)
  clearTimeout(pending.timer)
  if (params.error) pending.reject(new Error(params.error))
  else pending.resolve(params.result)
}

/** 调用渲染进程能力，返回 Promise */
// eslint-disable-next-line @typescript-eslint/promise-function-async
const invokeRenderer = (method: string, params?: any, timeout = BRIDGE_TIMEOUT): Promise<any> => new Promise((resolve, reject) => {
  const requestId = randomUUID()
  const timer = setTimeout(() => {
    pendingCalls.delete(requestId)
    reject(new Error(`renderer invoke timeout: ${method}`))
  }, timeout)
  pendingCalls.set(requestId, { resolve, reject, timer })
  sendEvent<LX.MCP.BridgeCall>(WIN_MAIN_RENDERER_EVENT_NAME.mcp_invoke, { requestId, method, params })
})

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */
const textResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})

// eslint-disable-next-line @typescript-eslint/promise-function-async
const readBody = (req: http.IncomingMessage): Promise<any> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    if (!chunks.length) {
      resolve(undefined)
      return
    }
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
    } catch (err) {
      reject(err)
    }
  })
  req.on('error', reject)
})

const getMyLists = async() => {
  // 内置列表（默认/喜欢/临时）+ 用户自建列表
  const builtin = [
    { id: LIST_IDS.DEFAULT, name: '默认列表', source: '' },
    { id: LIST_IDS.LOVE, name: '我的收藏', source: '' },
    { id: LIST_IDS.TEMP, name: '临时列表', source: '' },
  ]
  const userLists = await global.lx.worker.dbService.getAllUserList()
  const custom = userLists.map((l: LX.List.UserListInfo) => ({ id: l.id, name: l.name, source: l.source ?? '' }))
  return [...builtin, ...custom]
}

/* ------------------------------------------------------------------ *
 * 构建 MCP Server（每个请求新建，采用无状态模式，适合本地单 Agent 场景）
 * ------------------------------------------------------------------ */
const createMcpServer = (): McpServer => {
  const server = new McpServer({ name: 'lx-music', version: '1.0.0' })

  // ---- 播放控制（主进程直达，复用现有 taskbar 按钮链路）----
  server.registerTool('play', { description: '播放当前歌曲' }, async() => {
    sendTaskbarButtonClick('play')
    return textResult('ok')
  })
  server.registerTool('pause', { description: '暂停播放' }, async() => {
    sendTaskbarButtonClick('pause')
    return textResult('ok')
  })
  server.registerTool('toggle_play', { description: '切换播放/暂停' }, async() => {
    // player_status 里可判断当前是否播放中
    if (global.lx.player_status.status === 'playing') sendTaskbarButtonClick('pause')
    else sendTaskbarButtonClick('play')
    return textResult('ok')
  })
  server.registerTool('next', { description: '播放下一首' }, async() => {
    sendTaskbarButtonClick('next')
    return textResult('ok')
  })
  server.registerTool('prev', { description: '播放上一首' }, async() => {
    sendTaskbarButtonClick('prev')
    return textResult('ok')
  })
  server.registerTool('seek', {
    description: '跳转到指定播放进度',
    inputSchema: { offset: z.number().describe('目标进度，单位秒') },
  }, async({ offset }) => {
    if (offset < 0 || offset > global.lx.player_status.duration) return textResult({ error: 'invalid offset' })
    sendTaskbarButtonClick('seek', parseFloat(offset.toFixed(3)))
    return textResult('ok')
  })
  server.registerTool('set_volume', {
    description: '设置音量',
    inputSchema: { volume: z.number().min(0).max(100).describe('音量 0-100') },
  }, async({ volume }) => {
    sendTaskbarButtonClick('volume', volume / 100)
    return textResult('ok')
  })
  server.registerTool('set_mute', {
    description: '设置静音',
    inputSchema: { mute: z.boolean().describe('是否静音') },
  }, async({ mute }) => {
    sendTaskbarButtonClick('mute', mute)
    return textResult('ok')
  })
  server.registerTool('collect', {
    description: '收藏当前播放的歌曲到"我的收藏"',
  }, async() => {
    sendTaskbarButtonClick('collect')
    return textResult('ok')
  })
  server.registerTool('uncollect', {
    description: '取消收藏当前播放的歌曲',
  }, async() => {
    sendTaskbarButtonClick('unCollect')
    return textResult('ok')
  })

  // ---- 状态查询（主进程直达）----
  server.registerTool('get_status', {
    description: '获取当前播放状态（歌名、歌手、专辑、进度、时长、音量、播放态、当前歌词行等）',
  }, async() => {
    return textResult(global.lx.player_status)
  })
  server.registerTool('get_lyric', {
    description: '获取当前播放歌曲的歌词（含原文、翻译、罗马音）',
  }, async() => {
    const s = global.lx.player_status
    return textResult({ lyric: s.lyric, tlyric: s.tlyric, rlyric: s.rlyric, lxlyric: s.lxlyric })
  })

  // ---- 列表（主进程直达 dbService）----
  server.registerTool('get_my_lists', {
    description: '获取"我的列表"（默认/喜欢/自建列表）概览',
  }, async() => {
    return textResult(await getMyLists())
  })
  server.registerTool('get_list_songs', {
    description: '获取指定列表内的歌曲',
    inputSchema: { listId: z.string().describe('列表 id，可从 get_my_lists 获取') },
  }, async({ listId }) => {
    const list = await global.lx.worker.dbService.getListMusics(listId)
    return textResult(list.map((m: LX.Music.MusicInfo) => ({ id: m.id, name: m.name, singer: m.singer, source: m.source })))
  })

  // ---- 搜索/点播/当前歌曲（桥接到渲染进程）----
  server.registerTool('search_music', {
    description: '搜索歌曲，返回歌曲列表（不播放）',
    inputSchema: {
      keyword: z.string().describe('搜索关键词'),
      source: z.enum(['all', 'kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('音源，默认 all 聚合搜索'),
      page: z.number().optional().describe('页码，默认 1'),
    },
  }, async({ keyword, source, page }) => {
    const list = await invokeRenderer('search_music', { keyword, source: source ?? 'all', page: page ?? 1 })
    return textResult(list)
  })
  server.registerTool('search_and_play', {
    description: '搜索歌曲并立即播放（把结果放入临时列表播放第一首）',
    inputSchema: {
      keyword: z.string().describe('搜索关键词'),
      source: z.enum(['all', 'kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('音源，默认 all'),
      limit: z.number().optional().describe('加入播放列表的最大数量，默认 50'),
    },
  }, async({ keyword, source, limit }) => {
    const result = await invokeRenderer('search_and_play', { keyword, source: source ?? 'all', limit: limit ?? 50 })
    return textResult(result)
  })
  server.registerTool('play_songs', {
    description: '播放一组指定歌曲（电台模式）：逐首搜索匹配后汇总进临时列表连续播放。适合 AI 推荐一批歌后自动连播',
    inputSchema: {
      songs: z.array(z.object({
        name: z.string().describe('歌曲名'),
        singer: z.string().optional().describe('歌手名，提供可提高匹配准确度'),
      })).describe('要播放的歌曲列表，按顺序连播'),
      source: z.enum(['all', 'kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('音源，默认 all'),
      opening: z.object({
        text: z.string().min(1).max(200),
        song: z.object({ name: z.string(), singer: z.string().optional() }),
        audioBase64: z.string().max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
        musicCue: z.object({ afterText: z.string().max(200) }).optional(),
      }).optional().describe('已生成的首曲开场语音，绑定首曲，准备完成后再播放'),
    },
  }, async({ songs, source, opening }) => {
    // Allow first-song media checks and fallback sources in addition to searches.
    const timeout = (opening ? 90000 : 30000) + (songs?.length ?? 0) * 6000
    const result = await invokeRenderer('play_songs', { songs, source: source ?? 'all', opening }, timeout)
    return textResult(result)
  })
  server.registerTool('append_songs', {
    description: '追加一组歌曲到当前电台队列末尾，不打断正在播放的歌（无限电台续播）。会对队列已有的歌去重。与 play_songs 区别：play_songs 覆盖列表从头播，append_songs 只往后加',
    inputSchema: {
      songs: z.array(z.object({
        name: z.string().describe('歌曲名'),
        singer: z.string().optional().describe('歌手名，提供可提高匹配准确度'),
      })).describe('要追加的歌曲列表'),
      source: z.enum(['all', 'kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('音源，默认 all'),
    },
  }, async({ songs, source }) => {
    const timeout = 30000 + (songs?.length ?? 0) * 6000
    const result = await invokeRenderer('append_songs', { songs, source: source ?? 'all' }, timeout)
    return textResult(result)
  })
  server.registerTool('play_artist', {
    description: '搜索并播放指定歌手的全部歌曲',
    inputSchema: {
      singer: z.string().describe('歌手名'),
      source: z.enum(['kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('音源，默认取当前播放源'),
    },
  }, async({ singer, source }) => {
    const result = await invokeRenderer('play_artist', { singer, source })
    return textResult(result)
  })
  server.registerTool('play_list', {
    description: '播放指定列表（从指定位置开始）',
    inputSchema: {
      listId: z.string().describe('列表 id'),
      index: z.number().optional().describe('起始位置，默认 0'),
    },
  }, async({ listId, index }) => {
    const result = await invokeRenderer('play_list', { listId, index: index ?? 0 })
    return textResult(result)
  })
  server.registerTool('get_current_music', {
    description: '获取当前播放歌曲的完整信息（含 id、source、所属列表、播放索引）',
  }, async() => {
    const info = await invokeRenderer('get_current_music')
    return textResult(info)
  })

  server.registerTool('set_radio_mode', {
    description: '启停电台预准备与歌曲开场播报；停用时清除缓存并继续当前歌曲',
    inputSchema: {
      enabled: z.boolean(),
      voiceGain: z.number().min(0.5).max(3).optional(),
      interjectionMusicGain: z.number().min(0.5).max(2).optional(),
      interjectionVoiceGain: z.number().min(0.5).max(1).optional(),
    },
  }, async params => textResult(await invokeRenderer('set_radio_mode', params)))
  server.registerTool('get_radio_state', {
    description: '获取电台会话、实际下一首歌曲、已准备解说和队列剩余情况',
  }, async() => textResult(await invokeRenderer('get_radio_state')))
  server.registerTool('prepare_radio_intro', {
    description: '缓存下一首的解说与 MP3；仅在会话和当前歌曲仍匹配时接受，歌曲切换时自动播报',
    inputSchema: {
      sessionId: z.number().int(),
      anchor: z.string(),
      songId: z.string(),
      source: z.string(),
      text: z.string().min(1).max(200),
      audioBase64: z.string().max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
      musicCue: z.object({
        afterText: z.string().max(200),
        volume: z.number().optional(),
        fadeInSeconds: z.number().optional(),
        restoreSeconds: z.number().optional(),
      }).optional(),
    },
  }, async params => textResult(await invokeRenderer('prepare_radio_intro', params, 10000)))

  server.registerTool('plan_radio_interjection', {
    description: '为当前歌曲缓存一次按歌曲秒数执行的插播；atSeconds=null 表示不插播。插播前压低音乐、结束后恢复；过期或剩余时长不足时拒绝。',
    inputSchema: {
      sessionId: z.number().int(),
      anchor: z.string(),
      songId: z.string(),
      source: z.string(),
      atSeconds: z.number().min(0).nullable(),
      text: z.string().max(120).optional(),
      audioBase64: z.string().max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/).optional(),
      volume: z.number().min(0).max(0.5).default(0.16),
      fadeDownSeconds: z.number().min(0.1).max(5).default(0.8),
      restoreSeconds: z.number().min(0.1).max(10).default(2),
      reason: z.string().max(300).optional(),
    },
  }, async params => textResult(await invokeRenderer('plan_radio_interjection', params, 10000)))

  // ---- 换源（桥接到渲染进程）----
  server.registerTool('get_other_source', {
    description: '获取当前播放歌曲可切换的其他音源列表（在其他平台搜索同一首歌，用于换源）',
  }, async() => {
    const list = await invokeRenderer('get_other_source')
    return textResult(list)
  })
  server.registerTool('toggle_source', {
    description: '给当前播放的歌曲换源：切换到其他平台的同一首歌并重新加载播放。不传 source 则自动选择第一个可用源',
    inputSchema: {
      source: z.enum(['kw', 'kg', 'tx', 'wy', 'mg']).optional().describe('目标音源，省略则自动选择'),
    },
  }, async({ source }) => {
    const result = await invokeRenderer('toggle_source', { source })
    return textResult(result)
  })

  // ---- 设置（主进程直达 update_config，会广播到渲染进程生效）----
  server.registerTool('get_settings', {
    description: '读取播放器设置（不传 keys 返回全部；传 keys 返回指定项，如 ["player.volume","player.togglePlayMethod"]）',
    inputSchema: {
      keys: z.array(z.string()).optional().describe('要读取的设置键数组，省略则返回全部'),
    },
  }, async({ keys }) => {
    const all = global.lx.appSetting
    if (!keys?.length) return textResult(all)
    const result: Record<string, unknown> = {}
    for (const k of keys) result[k] = (all as unknown as Record<string, unknown>)[k]
    return textResult(result)
  })
  server.registerTool('update_settings', {
    description: '修改播放器设置（传入键值对，如 {"player.volume":0.5}）。可控制音质、播放模式、倍速、桌面歌词、音效均衡器等所有设置项',
    inputSchema: {
      setting: z.record(z.string(), z.any()).describe('要修改的设置键值对'),
    },
  }, async({ setting }) => {
    global.lx.event_app.update_config(setting as Partial<LX.AppSetting>)
    return textResult('ok')
  })
  server.registerTool('set_play_mode', {
    description: '设置播放模式',
    inputSchema: {
      mode: z.enum(['listLoop', 'random', 'list', 'singleLoop', 'none']).describe('listLoop=列表循环, random=随机, list=顺序, singleLoop=单曲循环, none=禁用切歌'),
    },
  }, async({ mode }) => {
    global.lx.event_app.update_config({ 'player.togglePlayMethod': mode })
    return textResult('ok')
  })

  // ---- 自定义音源管理（主进程直达 userApi 模块）----
  server.registerTool('get_user_api_list', {
    description: '获取已导入的自定义音源列表（含 id、名称、版本、作者、描述）',
  }, async() => {
    return textResult(getApiList())
  })
  server.registerTool('import_user_api', {
    description: '导入一个自定义音源脚本（LX Music 音源 JS 脚本全文，需含 @name/@version 等头部注释）。导入后可用 set_user_api 启用',
    inputSchema: {
      script: z.string().describe('音源脚本的完整 JS 文本内容'),
    },
  }, async({ script }) => {
    if (!script?.trim()) return textResult({ error: 'script is empty' })
    const result = await importApi(script)
    return textResult({ imported: result.apiInfo, total: result.apiList.length })
  })
  server.registerTool('set_user_api', {
    description: '启用指定的自定义音源（传音源 id，可从 get_user_api_list 获取）。启用后该源生效用于取播放链接',
    inputSchema: {
      id: z.string().describe('要启用的音源 id'),
    },
  }, async({ id }) => {
    // 走渲染进程 setUserApi：加载脚本 + 更新 apiSource + 持久化 common.apiSource
    const result = await invokeRenderer('set_user_api', { id })
    return textResult(result)
  })
  server.registerTool('remove_user_api', {
    description: '删除指定的自定义音源（传音源 id 数组）。删除操作不可逆，建议调用前向用户确认',
    inputSchema: {
      ids: z.array(z.string()).describe('要删除的音源 id 数组'),
    },
  }, async({ ids }) => {
    const list = await removeApi(ids)
    return textResult({ remaining: list.length, list })
  })

  return server
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
const handleStartServer = async(port: number, ip: string) => new Promise<void>((resolve, reject) => {
  httpServer = http.createServer((req, res): void => {
    const url = req.url ?? '/'
    // CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id',
        'Access-Control-Expose-Headers': 'mcp-session-id',
      })
      res.end()
      return
    }
    if (!url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found, use POST /mcp' }))
      return
    }
    void handleMcpRequest(req, res)
  })

  httpServer.on('error', error => {
    console.log(error)
    reject(error)
  })
  httpServer.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  httpServer.on('listening', () => {
    const addr = httpServer.address()
    if (!addr) {
      reject(new Error('address is null'))
      return
    }
    resolve()
  })
  httpServer.listen(port, ip)
})

/** 处理单个 MCP 请求（无状态模式：每请求新建 server + transport） */
const handleMcpRequest = async(req: http.IncomingMessage, res: http.ServerResponse) => {
  // GET/DELETE 在无状态模式下不支持会话流
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'method not allowed, use POST' }))
    return
  }
  let body: any
  try {
    body = await readBody(req)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid json body' }))
    return
  }
  const server = createMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  } catch (err) {
    console.error('MCP request error:', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal error' }))
    }
  }
}

const handleStopServer = async() => new Promise<void>((resolve, reject) => {
  if (!httpServer) {
    resolve()
    return
  }
  httpServer.close((err) => {
    if (err) reject(err)
    else resolve()
  })
  for (const socket of sockets) socket.destroy()
  sockets.clear()
})

/* ------------------------------------------------------------------ *
 * 对外接口（供 rendererEvent/mcp.ts 调用）
 * ------------------------------------------------------------------ */
export const startServer = async(port: number, bindLan: boolean): Promise<LX.MCP.Status> => {
  if (status.status) await stopServer()
  await handleStartServer(port, bindLan ? '0.0.0.0' : '127.0.0.1').then(() => {
    // 仅在服务成功启动后注册桥接响应监听，避免端口占用等失败时残留监听器
    mainOn<LX.MCP.BridgeResponse>(WIN_MAIN_RENDERER_EVENT_NAME.mcp_response, onBridgeResponse)
    status.status = true
    status.message = ''
    let address = ['127.0.0.1']
    if (bindLan) address = [...address, ...getAddress()]
    status.address = address.map(a => `http://${a}:${port}/mcp`).join(', ')
  }).catch(err => {
    console.log(err)
    status.status = false
    status.message = err.message
    status.address = ''
  })
  return status
}

export const stopServer = async(): Promise<LX.MCP.Status> => {
  // mcp_response 为 MCP 专用事件名，mainOn 注册的是匿名包装器，用 mainOffAll 才能正确移除
  mainOffAll(WIN_MAIN_RENDERER_EVENT_NAME.mcp_response)
  if (!status.status) {
    status.status = false
    status.message = ''
    status.address = ''
    return status
  }
  await handleStopServer().then(() => {
    status.status = false
    status.message = ''
    status.address = ''
  }).catch(err => {
    console.log(err)
    status.message = err.message
  })
  return status
}

export const getStatus = (): LX.MCP.Status => status
