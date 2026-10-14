import { rendererOn, rendererSend } from '@common/rendererIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { watch, markRaw } from '@common/utils/vueTools'
import { deduplicationList } from '@renderer/utils'
import { search as searchMusic } from '@renderer/store/search/music/action'
import { playMusicInfo, playInfo, isPlay } from '@renderer/store/player/state'
import { setTempList, addListMusics, getListMusicsFromCache } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { playArtist } from '@renderer/store/player/action'
import { playList as corePlayList, setMusicUrl, getNextPlayMusicInfo } from '@renderer/core/player'
import { radioPlayback, songKey } from '@renderer/core/radio/playback'
import { miniRadioMode } from '@renderer/core/radio/mode'
import type { MusicCue } from '@renderer/core/radio/playback'
import { getCurrentTime, getDuration } from '@renderer/plugins/player'
import { getOtherSource } from '@renderer/core/music/utils'
import { getMusicUrl } from '@renderer/core/music'
import { validateRadioAudio } from '@renderer/core/radio/resource'
import { setUserApi } from '@renderer/core/apiSource'
import { LIST_IDS } from '@common/constants'
import { appSetting } from '@renderer/store/setting'
import { sendMcpAction } from '@renderer/utils/ipc'
import { mcp } from '@renderer/store'

/**
 * MCP 桥接方法路由表
 * 主进程无法直接访问渲染进程的能力（搜索、点播、当前歌曲详情），
 * 通过 mcp_invoke 事件转发到这里执行，再回传结果。
 *
 * 新增能力时，只需在此 map 中增加一个方法即可。
 */
const mcpMethodMap: Record<string, (params: any) => Promise<any> | any> = {
  /**
   * 搜索歌曲
   * @param params.keyword 关键词
   * @param params.source 音源，默认聚合搜索 all
   * @param params.page 页码，默认 1
   */
  async search_music({ keyword, source = 'all', page = 1 }: { keyword: string, source?: LX.OnlineSource | 'all', page?: number }) {
    if (!keyword) return []
    const list = await searchMusic(keyword, page, source)
    return list.map(m => ({
      id: m.id,
      name: m.name,
      singer: m.singer,
      album: m.meta.albumName ?? '',
      source: m.source,
      interval: m.interval ?? '',
    }))
  },

  /**
   * 搜索并播放：将搜索结果放入临时列表并播放第一首
   * @param params.keyword 关键词
   * @param params.source 音源，默认 all
   * @param params.limit 最大数量，默认 50
   */
  async search_and_play({ keyword, source = 'all', limit = 50 }: { keyword: string, source?: LX.OnlineSource | 'all', limit?: number }) {
    if (!keyword) throw new Error('keyword is required')
    // searchMusic 内部已完成 toNewMusicInfo + 去重，返回可直接使用的 MusicInfo[]
    const list = await searchMusic(keyword, 1, source)
    if (!list?.length) return { played: false, message: 'no result' }
    const musicList = deduplicationList(list.slice(0, limit)) as LX.Music.MusicInfoOnline[]
    if (!musicList.length) return { played: false, message: 'no result' }
    const listId = `mcp_search_${source}_${keyword}`
    radioPlayback.configure(radioPlayback.enabled)
    await setTempList(listId, musicList)
    corePlayList(LIST_IDS.TEMP, 0)
    return { played: true, count: musicList.length, first: { name: musicList[0].name, singer: musicList[0].singer } }
  },

  /**
   * 播放一组指定歌曲（电台模式底座）：逐首搜索取最佳匹配，汇总进临时列表连播
   * @param params.songs 歌曲数组 [{ name, singer }]
   * @param params.source 音源，默认 all
   */
  async play_songs({ songs, source = 'all', opening }: {
    songs: Array<{ name: string, singer?: string }>
    source?: LX.OnlineSource | 'all'
    opening?: { text: string, song: { name: string, singer?: string }, audioBase64?: string, musicCue?: MusicCue }
  }) {
    if (!songs?.length) throw new Error('songs is required')
    const capturedSession = radioPlayback.sessionId
    const capturedPosition = radioPlayback.positionId
    if (radioPlayback.enabled && !opening) return { played: false, reason: 'opening_required' }
    if (opening && (opening.song.name !== songs[0].name || (opening.song.singer ?? '') !== (songs[0].singer ?? ''))) return { played: false, reason: 'opening_song_mismatch' }
    const matched: LX.Music.MusicInfoOnline[] = []
    const failed: Array<{ name: string, singer?: string }> = []
    for (const song of songs) {
      if (!song?.name) continue
      const keyword = `${song.name} ${song.singer ?? ''}`.trim()
      try {
        const list = await searchMusic(keyword, 1, source)
        if (!list?.length) {
          failed.push(song)
          continue
        }
        // 优先选歌名+歌手都匹配的，否则取第一个结果
        const target = list.find(m =>
          m.name === song.name && (!song.singer || m.singer.includes(song.singer)),
        ) ?? list[0]
        matched.push(target as LX.Music.MusicInfoOnline)
      } catch (err) {
        console.error('play_songs search error:', keyword, err)
        failed.push(song)
      }
    }
    const musicList = deduplicationList(matched) as LX.Music.MusicInfoOnline[]
    if (!musicList.length) return { played: false, matched: 0, failed }
    if (opening && failed.includes(songs[0])) return { played: false, reason: 'opening_song_unavailable', failed }
    if (capturedSession !== radioPlayback.sessionId || capturedPosition !== radioPlayback.positionId) return { played: false, reason: 'stale' }
    if (opening && radioPlayback.enabled) {
      try {
        await getMusicUrl({
          musicInfo: musicList[0],
          validateUrl: async url => {
            if (capturedSession !== radioPlayback.sessionId || capturedPosition !== radioPlayback.positionId) throw new DOMException('Radio queue changed', 'AbortError')
            await validateRadioAudio(url)
          },
        })
      } catch (err: any) {
        return { played: false, reason: err.name === 'AbortError' ? 'stale' : 'opening_song_unavailable', failed: [songs[0]] }
      }
      if (capturedSession !== radioPlayback.sessionId || capturedPosition !== radioPlayback.positionId) return { played: false, reason: 'stale' }
    }
    const listId = `mcp_radio_${Date.now()}`
    radioPlayback.configure(radioPlayback.enabled)
    let openingPrepared = false
    if (opening && radioPlayback.enabled) {
      const sessionId = radioPlayback.sessionId
      openingPrepared = await radioPlayback.prepare(sessionId, songKey(musicList[0]), opening.text,
        opening.audioBase64 ? `data:audio/mpeg;base64,${opening.audioBase64}` : undefined,
        () => radioPlayback.sessionId === sessionId && radioPlayback.positionId === capturedPosition,
        opening.musicCue)
      if (!openingPrepared) return { played: false, reason: 'opening_audio_or_cue_invalid' }
    }
    await setTempList(listId, musicList)
    corePlayList(LIST_IDS.TEMP, 0)
    return {
      played: true,
      openingPrepared,
      matched: musicList.length,
      first: { name: musicList[0].name, singer: musicList[0].singer },
      failed,
    }
  },

  /**
   * 追加一组歌曲到当前电台队列末尾（不打断正在播放的歌）——无限电台续播底座
   * 逐首搜索取最佳匹配，对队列里已有的歌去重后 append 到 TEMP 列表底部。
   * 与 play_songs 的区别：play_songs 覆盖列表并从头播；append_songs 只往后加、当前播放不中断。
   * @param params.songs 歌曲数组 [{ name, singer }]
   * @param params.source 音源，默认 all
   */
  async append_songs({ songs, source = 'all' }: { songs: Array<{ name: string, singer?: string }>, source?: LX.OnlineSource | 'all' }) {
    if (!songs?.length) throw new Error('songs is required')
    const queueId = tempListMeta.id
    // 队列里已有的歌（name+singer 作为去重键），避免续播时重复推荐
    const existing = getListMusicsFromCache(LIST_IDS.TEMP) ?? []
    const existingKeys = new Set(existing.map(m => `${m.name}__${m.singer}`))
    const matched: LX.Music.MusicInfoOnline[] = []
    const failed: Array<{ name: string, singer?: string }> = []
    const skipped: Array<{ name: string, singer?: string }> = []
    for (const song of songs) {
      if (!song?.name) continue
      const keyword = `${song.name} ${song.singer ?? ''}`.trim()
      try {
        const list = await searchMusic(keyword, 1, source)
        if (!list?.length) {
          failed.push(song)
          continue
        }
        const target = list.find(m =>
          m.name === song.name && (!song.singer || m.singer.includes(song.singer)),
        ) ?? list[0]
        const key = `${target.name}__${target.singer}`
        if (existingKeys.has(key)) {
          skipped.push(song)
          continue
        }
        existingKeys.add(key)
        matched.push(target as LX.Music.MusicInfoOnline)
      } catch (err) {
        console.error('append_songs search error:', keyword, err)
        failed.push(song)
      }
    }
    const musicList = deduplicationList(matched) as LX.Music.MusicInfoOnline[]
    if (!musicList.length) return { appended: 0, queueSize: existing.length, skipped, failed }
    if (queueId !== tempListMeta.id) return { appended: 0, reason: 'stale', skipped, failed }
    // 追加到 TEMP 列表底部，当前播放不受影响
    await addListMusics(LIST_IDS.TEMP, musicList, 'bottom')
    const newSize = (getListMusicsFromCache(LIST_IDS.TEMP) ?? []).length
    return {
      appended: musicList.length,
      queueSize: newSize,
      first: { name: musicList[0].name, singer: musicList[0].singer },
      skipped,
      failed,
    }
  },

  /**
   * 播放指定歌手的全部歌曲（复用 store/player/action.ts 的 playArtist）
   * @param params.singer 歌手名
   * @param params.source 音源，默认当前播放源或 wy
   */
  async play_artist({ singer, source }: { singer: string, source?: LX.OnlineSource }) {
    if (!singer) throw new Error('singer is required')
    const playSource = source ?? getCurrentSource() ?? 'wy'
    await playArtist(singer, playSource)
    return { played: true, singer, source: playSource }
  },

  /**
   * 获取当前播放歌曲的完整信息（含 id/source，player_status 里没有）
   */
  get_current_music() {
    const { musicInfo } = playMusicInfo
    if (!musicInfo) return null
    const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
    return {
      id: info.id,
      name: info.name,
      singer: info.singer,
      album: info.meta.albumName ?? '',
      albumName: info.meta.albumName ?? '',
      source: info.source,
      listId: playMusicInfo.listId,
      playIndex: playInfo.playIndex,
    }
  },

  set_radio_mode({ enabled, voiceGain = 1.6, interjectionMusicGain = 1.1, interjectionVoiceGain = 0.9 }: {
    enabled: boolean
    voiceGain?: number
    interjectionMusicGain?: number
    interjectionVoiceGain?: number
  }) {
    radioPlayback.configure(enabled, voiceGain, interjectionMusicGain, interjectionVoiceGain)
    return radioPlayback.status()
  },

  get_radio_state: getRadioState,

  async plan_radio_interjection({
    sessionId, anchor, songId, source, atSeconds, text = '', audioBase64, reason = '',
    volume = 0.16, fadeDownSeconds = 0.8, restoreSeconds = 2,
  }: {
    sessionId: number
    anchor: string
    songId: string
    source: string
    atSeconds: number | null
    text?: string
    audioBase64?: string
    reason?: string
    volume?: number
    fadeDownSeconds?: number
    restoreSeconds?: number
  }) {
    const key = songKey({ id: songId, source })
    const state = await getRadioState()
    if (!state.active || state.sessionId !== sessionId || state.anchor !== anchor || !state.current || songKey(state.current) !== key) return { prepared: false, reason: 'stale' }
    return await radioPlayback.planInterjection(sessionId, key, text,
      audioBase64 ? `data:audio/mpeg;base64,${audioBase64}` : undefined,
      atSeconds === null ? null : { atSeconds, volume, fadeDownSeconds, restoreSeconds },
      () => {
        const current = playMusicInfo.musicInfo ? serializeRadioSong(playMusicInfo.musicInfo) : null
        return !!current && `${radioPlayback.positionId}:${songKey(current)}` === anchor && playMusicInfo.listId === LIST_IDS.TEMP
      }, () => ({ progress: getCurrentTime(), duration: getDuration() }), reason,
    )
  },

  async prepare_radio_intro({ sessionId, anchor, songId, source, text, audioBase64, musicCue }: {
    sessionId: number
    anchor: string
    songId: string
    source: string
    text: string
    audioBase64?: string
    musicCue?: MusicCue
  }) {
    const key = songKey({ id: songId, source })
    const isValid = async() => {
      const state = await getRadioState()
      return state.active && state.sessionId === sessionId && state.anchor === anchor && state.next && songKey(state.next) === key
    }
    if (!await isValid()) return { prepared: false, reason: 'stale' }
    const accepted = await radioPlayback.prepare(sessionId, key, text,
      audioBase64 ? `data:audio/mpeg;base64,${audioBase64}` : undefined,
      () => {
        const current = playMusicInfo.musicInfo ? serializeRadioSong(playMusicInfo.musicInfo) : null
        return !!current && `${radioPlayback.positionId}:${songKey(current)}` === anchor && playMusicInfo.listId === LIST_IDS.TEMP
      },
      musicCue,
    )
    // Recheck the actual next song after decoding: the queue may have changed.
    if (accepted && !await isValid()) {
      radioPlayback.configure(radioPlayback.enabled)
      return { prepared: false, reason: 'stale' }
    }
    return { prepared: accepted, reason: accepted ? undefined : 'audio_or_cue_invalid', songId, text, hasAudio: !!audioBase64, musicCue }
  },

  /**
   * 播放指定列表的指定位置
   * @param params.listId 列表 id
   * @param params.index 位置，默认 0
   */
  play_list({ listId, index = 0 }: { listId: string, index?: number }) {
    corePlayList(listId, index)
    return { played: true, listId, index }
  },

  /**
   * 获取当前播放歌曲可切换的其他音源（换源候选列表）
   * 通过 musicSdk.findMusic 在其他平台搜索同一首歌
   */
  async get_other_source() {
    const { musicInfo } = playMusicInfo
    if (!musicInfo) return { error: 'no current music' }
    const list = await getOtherSource(musicInfo)
    return list.map(m => ({
      id: m.id,
      name: m.name,
      singer: m.singer,
      album: m.meta.albumName ?? '',
      source: m.source,
      interval: m.interval ?? '',
    }))
  },

  /**
   * 给当前播放的歌曲换源：设置 meta.toggleMusicInfo 后重新加载播放
   * @param params.source 目标音源；不传则自动选第一个可用源
   */
  async toggle_source({ source }: { source?: LX.OnlineSource }) {
    const { musicInfo } = playMusicInfo
    if (!musicInfo) return { toggled: false, message: 'no current music' }
    const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
    const otherSource = await getOtherSource(musicInfo)
    if (!otherSource.length) return { toggled: false, message: 'no other source found' }
    // 选定目标源：优先用户指定，否则取第一个（排除当前源）
    const target = source
      ? otherSource.find(m => m.source === source)
      : otherSource.find(m => m.source !== info.source) ?? otherSource[0]
    if (!target) return { toggled: false, message: `source not available: ${source}` }
    // 写入 toggleMusicInfo，播放链路会优先用该源取 URL
    info.meta.toggleMusicInfo = markRaw(target)
    // 强制重新加载当前歌曲的 URL（createGettingUrlId 含 toggleMusicInfo.id，守卫必放行）
    setMusicUrl(musicInfo, true)
    return {
      toggled: true,
      from: info.source,
      to: target.source,
      name: target.name,
      singer: target.singer,
    }
  },

  /**
   * 启用指定的自定义音源（走渲染进程 setUserApi，会加载脚本 + 更新 apiSource + 持久化 common.apiSource）
   * @param params.id 音源 id
   */
  async set_user_api({ id }: { id: string }) {
    if (!id) throw new Error('id is required')
    await setUserApi(id)
    return { enabled: true, id, apiSource: appSetting['common.apiSource'] }
  },
}

const serializeRadioSong = (music: LX.Player.PlayMusicInfo['musicInfo']) => {
  const info = 'progress' in music ? music.metadata.musicInfo : music
  return { id: info.id, source: info.source, name: info.name, singer: info.singer, albumName: info.meta.albumName ?? '' }
}

async function getRadioState() {
  const playback = radioPlayback.status()
  const capturedMusic = playMusicInfo.musicInfo
  const current = capturedMusic ? serializeRadioSong(capturedMusic) : null
  const active = playback.enabled && playMusicInfo.listId === LIST_IDS.TEMP && !playMusicInfo.isTempPlay && tempListMeta.id?.startsWith('mcp_radio_') === true
  const songs = active ? getListMusicsFromCache(LIST_IDS.TEMP) : []
  const next = active ? await getNextPlayMusicInfo() : null
  const unchanged = capturedMusic === playMusicInfo.musicInfo && playback.sessionId === radioPlayback.sessionId && playback.positionId === radioPlayback.positionId
  const remaining = active ? Math.max(0, songs.length - playInfo.playIndex - 1) : 0
  return {
    ...playback,
    viewMode: miniRadioMode.value ? 'mini' : 'full',
    active: active && unchanged,
    playing: unchanged && isPlay.value,
    progress: unchanged ? getCurrentTime() : 0,
    duration: unchanged && Number.isFinite(getDuration()) ? getDuration() : 0,
    current,
    anchor: current ? `${playback.positionId}:${songKey(current)}` : '',
    next: unchanged && next && next.listId === LIST_IDS.TEMP && !next.isTempPlay ? serializeRadioSong(next.musicInfo) : null,
    total: songs.length,
    remaining,
    needRefill: active && songs.length > 0 && remaining <= 3,
    songs: songs.map(serializeRadioSong),
  }
}

/** 获取当前播放歌曲的音源，用于 play_artist 的默认源（本地歌曲无在线源，返回 undefined） */
const getCurrentSource = (): LX.OnlineSource | undefined => {
  const { musicInfo } = playMusicInfo
  if (!musicInfo) return undefined
  const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  const source = info.source
  return source == 'local' ? undefined : source as LX.OnlineSource
}

export default () => {
  // 注册渲染进程桥接 dispatcher：接收主进程转发的调用
  rendererOn<LX.MCP.BridgeCall>(WIN_MAIN_RENDERER_EVENT_NAME.mcp_invoke, ({ params }) => {
    const { requestId, method, params: callParams } = params
    const handler = mcpMethodMap[method]
    const respond = (result?: any, error?: string) => {
      rendererSend<LX.MCP.BridgeResponse>(WIN_MAIN_RENDERER_EVENT_NAME.mcp_response, {
        requestId,
        result,
        error,
      })
    }
    if (!handler) {
      respond(undefined, `unknown method: ${method}`)
      return
    }
    try {
      const ret = handler(callParams)
      if (ret instanceof Promise) {
        ret.then(r => { respond(r) }).catch((err: any) => { respond(undefined, err?.message ?? String(err)) })
      } else {
        respond(ret)
      }
    } catch (err: any) {
      respond(undefined, err?.message ?? String(err))
    }
  })

  // 监听设置开关，启停 MCP 服务
  const handleEnable = async(enable: boolean, port: string, bindLan: boolean) => {
    if (!enable) radioPlayback.configure(false)
    await sendMcpAction({
      action: 'enable',
      data: { enable, port, bindLan },
    }).then((status) => {
      mcp.address = status.address
      mcp.message = status.message
    }).catch((error: any) => {
      mcp.address = ''
      mcp.message = error.message
    })
  }

  watch(() => appSetting['mcp.enable'], enable => {
    void handleEnable(enable, appSetting['mcp.port'], appSetting['mcp.bindLan'])
  })
  watch(() => appSetting['mcp.port'], port => {
    if (!appSetting['mcp.enable']) return
    void handleEnable(appSetting['mcp.enable'], port, appSetting['mcp.bindLan'])
  })
  watch(() => appSetting['mcp.bindLan'], bindLan => {
    if (!appSetting['mcp.enable']) return
    void handleEnable(appSetting['mcp.enable'], appSetting['mcp.port'], bindLan)
  })

  return async() => {
    if (appSetting['mcp.enable']) {
      void handleEnable(true, appSetting['mcp.port'], appSetting['mcp.bindLan'])
    }
  }
}
