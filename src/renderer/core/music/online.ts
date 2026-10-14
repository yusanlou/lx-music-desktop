import { updateListMusics } from '@renderer/store/list/action'
import { appSetting } from '@renderer/store/setting'
import { requestMsg } from '@renderer/utils/message'
import {
  saveLyric,
  saveMusicUrl,
  getMusicUrl as getStoreMusicUrl,
} from '@renderer/utils/ipc'
import {
  buildLyricInfo,
  getPlayQuality,
  handleGetOnlineLyricInfo,
  handleGetOnlineMusicUrl,
  handleGetOnlinePicUrl,
  getCachedLyricInfo,
  getOtherSource,
} from './utils'
import { radioSourcesEnabled, resolveRadioMusicUrl, observeRadioSong, validateRadioMusicIdentity } from '@renderer/core/radio/sources'
import { isSameRadioRecording } from '@renderer/core/radio/matching'

/* export const setMusicUrl = ({ musicInfo, type, url }: {
  musicInfo: LX.Music.MusicInfo
  type: LX.Quality
  url: string
}) => {
  saveMusicUrl(musicInfo, type, url)
}

export const setPic = (datas: {
  listId: string
  musicInfo: LX.Music.MusicInfo
  url: string
}) => {
  datas.musicInfo.img = datas.url
  updateMusicInfo({
    listId: datas.listId,
    id: datas.musicInfo.songmid,
    data: { img: datas.url },
    musicInfo: datas.musicInfo,
  })
}
 */


export const getMusicUrl = async({ musicInfo, quality, isRefresh, allowToggleSource = true, onToggleSource = () => {}, validateUrl }: {
  musicInfo: LX.Music.MusicInfoOnline
  quality?: LX.Quality
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
  validateUrl?: (url: string) => Promise<void>
}): Promise<string> => {
  // if (!musicInfo._types[type]) {
  //   // 兼容旧版酷我源搜索列表过滤128k音质的bug
  //   if (!(musicInfo.source == 'kw' && type == '128k')) throw new Error('该歌曲没有可播放的音频')

  //   // return Promise.reject(new Error('该歌曲没有可播放的音频'))
  // }
  const targetQuality = quality ?? getPlayQuality(appSetting['player.playQuality'], musicInfo)
  if (validateUrl) {
    const validateMedia = validateUrl
    validateUrl = async url => {
      await validateRadioMusicIdentity(url, musicInfo)
      await validateMedia(url)
    }
  }
  if (validateUrl && radioSourcesEnabled.value) observeRadioSong(musicInfo, targetQuality)
  // Legacy URLs have no recording provenance and may contain fuzzy matches.
  const cachedUrl = await getStoreMusicUrl(musicInfo, targetQuality, !!validateUrl)
  let failedUrl = isRefresh ? cachedUrl ?? undefined : undefined
  if (cachedUrl && !isRefresh) {
    try {
      await validateUrl?.(cachedUrl)
      return cachedUrl
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message === requestMsg.cancelRequest) throw err
      failedUrl = cachedUrl
    }
  }

  if (validateUrl && radioSourcesEnabled.value) {
    // This route remains usable even when the normal custom API failed to init.
    // Try providers within each platform budget, then matching songs elsewhere.
    const deadline = Date.now() + 65_000
    const attempt = async(song: LX.Music.MusicInfoOnline, budget: number) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('radio_sources_timeout')
      const url = await resolveRadioMusicUrl(song, targetQuality, isRefresh, failedUrl, Math.min(remaining, budget, allowToggleSource ? 20_000 : 65_000))
      await validateUrl(url)
      void saveMusicUrl(song, targetQuality, url, true)
      void saveMusicUrl(musicInfo, targetQuality, url, true)
      return url
    }
    // Bound each platform so a slow catalog cannot starve cross-platform recovery.
    try { return await attempt(musicInfo, allowToggleSource ? 20_000 : 65_000) } catch (error: any) {
      if (!allowToggleSource || error.name === 'AbortError' || error.message === requestMsg.cancelRequest) throw error
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw error
      let timer: ReturnType<typeof setTimeout> | undefined
      const alternatives = await Promise.race([getOtherSource(musicInfo), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('radio_sources_timeout')) }, remaining)
      })]).finally(() => { if (timer) clearTimeout(timer) })
      const tried = new Set([musicInfo.source])
      for (const song of alternatives) {
        if (!isSameRadioRecording(song, musicInfo)) continue
        if (tried.has(song.source)) continue
        tried.add(song.source)
        // Keep failover invisible; this callback only updates internal metadata.
        onToggleSource(song)
        try { return await attempt(song, deadline - Date.now()) } catch (alternateError: any) {
          if (alternateError.name === 'AbortError' || alternateError.message === requestMsg.cancelRequest) throw alternateError
        }
      }
      throw error
    }
  }

  return handleGetOnlineMusicUrl({ musicInfo, quality, onToggleSource, isRefresh, allowToggleSource, validateUrl }).then(({ url, quality: targetQuality, musicInfo: targetMusicInfo, isFromCache }) => {
    if (targetMusicInfo.id != musicInfo.id && !isFromCache) void saveMusicUrl(targetMusicInfo, targetQuality, url, !!validateUrl)
    void saveMusicUrl(musicInfo, targetQuality, url, !!validateUrl)
    return url
  })
}

export const getPicUrl = async({ musicInfo, listId, isRefresh, allowToggleSource = true, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoOnline
  listId?: string | null
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<string> => {
  if (musicInfo.meta.picUrl && !isRefresh) return musicInfo.meta.picUrl
  return handleGetOnlinePicUrl({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(({ url, musicInfo: targetMusicInfo, isFromCache }) => {
    // picRequest = null
    if (listId) {
      musicInfo.meta.picUrl = url
      void updateListMusics([{ id: listId, musicInfo }])
    }
    // savePic({ musicInfo, url, listId })
    return url
  })
}
export const getLyricInfo = async({ musicInfo, isRefresh, allowToggleSource = true, onToggleSource = () => {} }: {
  musicInfo: LX.Music.MusicInfoOnline
  isRefresh: boolean
  allowToggleSource?: boolean
  onToggleSource?: (musicInfo?: LX.Music.MusicInfoOnline) => void
}): Promise<LX.Player.LyricInfo> => {
  if (!isRefresh) {
    const lyricInfo = await getCachedLyricInfo(musicInfo)
    if (lyricInfo) return buildLyricInfo(lyricInfo)
  }

  // lrcRequest = music[musicInfo.source].getLyric(musicInfo)
  return handleGetOnlineLyricInfo({ musicInfo, onToggleSource, isRefresh, allowToggleSource }).then(async({ lyricInfo, musicInfo: targetMusicInfo, isFromCache }) => {
    // lrcRequest = null
    if (isFromCache) return buildLyricInfo(lyricInfo)
    if (targetMusicInfo.id == musicInfo.id) void saveLyric(musicInfo, lyricInfo)
    else void saveLyric(targetMusicInfo, lyricInfo)

    return buildLyricInfo(lyricInfo)
  })
}
