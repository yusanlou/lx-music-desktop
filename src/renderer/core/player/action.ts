import { isEmpty, setPause, setPlay, setResource, setStop } from '@renderer/plugins/player'
import { isPlay, playedList, playInfo, playMusicInfo, tempPlayList, musicInfo as _musicInfo } from '@renderer/store/player/state'
import {
  getList,
  clearPlayedList,
  clearTempPlayeList,
  setPlayMusicInfo,
  addPlayedList,
  setMusicInfo,
  setAllStatus,
  removeTempPlayList,
  setPlayListId,
  removePlayedList,
} from '@renderer/store/player/action'
import { appSetting } from '@renderer/store/setting'
import { getMusicUrl, getPicPath, getLyricInfo } from '../music/index'
import { filterList } from './utils'
import { requestMsg } from '@renderer/utils/message'
import { getRandom } from '@renderer/utils/index'
import { addListMusics, removeListMusics } from '@renderer/store/list/action'
import { loveList, tempListMeta } from '@renderer/store/list/state'
import { LIST_IDS } from '@common/constants'
import { addDislikeInfo } from '@renderer/core/dislikeList'
import { radioPlayback, songKey } from '@renderer/core/radio/playback'
import { validateRadioAudio } from '@renderer/core/radio/resource'
import { isSameRadioRecording } from '@renderer/core/radio/matching'
import { volume, isMute } from '@renderer/store/player/volume'
// import { checkMusicFileAvailable } from '@renderer/utils/music'

let gettingUrlId = ''
let resourceAbort: AbortController | null = null
const cancelResourceProbe = () => {
  resourceAbort?.abort()
  resourceAbort = null
  gettingUrlId = ''
}
const isRadioQueue = () => radioPlayback.enabled && playMusicInfo.listId === LIST_IDS.TEMP &&
  !playMusicInfo.isTempPlay && tempListMeta.id?.startsWith('mcp_radio_') === true
const requestedRadioNext = (): LX.Player.PlayMusicInfo | null => {
  if (!isRadioQueue() || !radioPlayback.requestedNextKey) return null
  const target = getList(LIST_IDS.TEMP).find(song => songKey('progress' in song ? song.metadata.musicInfo : song) === radioPlayback.requestedNextKey)
  return target ? { musicInfo: target, listId: LIST_IDS.TEMP, isTempPlay: false } : null
}
const createGettingUrlId = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  const tInfo = 'progress' in musicInfo ? musicInfo.metadata.musicInfo.meta.toggleMusicInfo : musicInfo.meta.toggleMusicInfo
  return `${musicInfo.id}_${tInfo?.id ?? ''}`
}
const createDelayNextTimeout = (delay: number) => {
  let timeout: NodeJS.Timeout | null
  const clearDelayNextTimeout = () => {
    // console.log(this.timeout)
    if (timeout) {
      clearTimeout(timeout)
      timeout = null
    }
  }

  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    timeout = setTimeout(() => {
      timeout = null
      if (window.lx.isPlayedStop) return
      console.warn('delay next timeout timeout', delay)
      void playNext(true)
    }, delay)
  }

  return {
    clearDelayNextTimeout,
    addDelayNextTimeout,
  }
}
const { addDelayNextTimeout, clearDelayNextTimeout } = createDelayNextTimeout(5000)
const { addDelayNextTimeout: addLoadTimeout, clearDelayNextTimeout: clearLoadTimeout } = createDelayNextTimeout(100000)

/**
 * 检查音乐信息是否已更改
 */
const diffCurrentMusicInfo = (curMusicInfo: LX.Music.MusicInfo | LX.Download.ListItem): boolean => {
  // return curMusicInfo !== playMusicInfo.musicInfo || isPlay.value
  // Opening speech also marks the UI playing while the music URL is loading.
  // Only a loaded music resource makes that play flag invalidate a pending URL.
  return gettingUrlId != createGettingUrlId(curMusicInfo) || curMusicInfo.id != playMusicInfo.musicInfo?.id || (isPlay.value && !isEmpty())
}

let cancelDelayRetry: (() => void) | null = null
const delayRetry = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false,
  validateUrl?: (url: string) => Promise<void>): Promise<string | null> => {
  // if (cancelDelayRetry) cancelDelayRetry()
  return new Promise<string | null>((resolve, reject) => {
    const time = getRandom(2, 6)
    setAllStatus(window.i18n.t('player__getting_url_delay_retry', { time }))
    const tiemout = setTimeout(() => {
      getMusicPlayUrl(musicInfo, isRefresh, true, validateUrl).then((result) => {
        cancelDelayRetry = null
        resolve(result)
      }).catch(async(err: any) => {
        cancelDelayRetry = null
        reject(err)
      })
    }, time * 1000)
    cancelDelayRetry = () => {
      clearTimeout(tiemout)
      cancelDelayRetry = null
      resolve(null)
    }
  })
}
const getMusicPlayUrl = async(musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh = false, isRetryed = false,
  validateUrl?: (url: string) => Promise<void>): Promise<string | null> => {
  // this.musicInfo.url = await getMusicPlayUrl(targetSong, type)
  setAllStatus(window.i18n.t('player__getting_url'))
  if (appSetting['player.autoSkipOnError']) addLoadTimeout()

  // const type = getPlayType(appSetting['player.highQuality'], musicInfo)
  let toggleMusicInfo = ('progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo).meta.toggleMusicInfo
  if (validateUrl && toggleMusicInfo && !isSameRadioRecording(toggleMusicInfo, 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo)) toggleMusicInfo = null

  return (toggleMusicInfo ? getMusicUrl({
    musicInfo: toggleMusicInfo,
    isRefresh,
    allowToggleSource: false,
    validateUrl,
  }) : Promise.reject(new Error('not found'))).catch(async(err: any) => {
    if (err.name === 'AbortError' || err.message === requestMsg.cancelRequest) throw err
    return getMusicUrl({
      musicInfo,
      isRefresh,
      validateUrl,
      onToggleSource(mInfo) {
        if (diffCurrentMusicInfo(musicInfo)) return
        setAllStatus(window.i18n.t('toggle_source_try'))
      },
    })
  }).then(url => {
    if (window.lx.isPlayedStop || diffCurrentMusicInfo(musicInfo)) return null

    return url
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  }).catch(err => {
    // console.log('err', err.message)
    if (err.name === 'AbortError' || window.lx.isPlayedStop ||
      diffCurrentMusicInfo(musicInfo) ||
      err.message == requestMsg.cancelRequest) return null

    if (err.message == requestMsg.tooManyRequests) return delayRetry(musicInfo, isRefresh, validateUrl)

    // Radio already checked each source. Do not repeat the same placeholder URLs.
    if (validateUrl) throw err

    if (!isRetryed) return getMusicPlayUrl(musicInfo, isRefresh, true)

    throw err
  })
}

export const setMusicUrl = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, isRefresh?: boolean, onReady?: (url: string) => void) => {
  if (!radioPlayback.allowsMusic) return
  // if (appSetting['player.autoSkipOnError']) addLoadTimeout()
  if (!diffCurrentMusicInfo(musicInfo)) return
  if (cancelDelayRetry) cancelDelayRetry()
  cancelResourceProbe()
  const request = new AbortController()
  resourceAbort = request
  const radio = isRadioQueue()
  const sessionId = radioPlayback.sessionId
  const positionId = radioPlayback.positionId
  const validateUrl = radio ? async(url: string) => {
    if ((radioPlayback.enabled && radioPlayback.sessionId !== sessionId) || radioPlayback.positionId !== positionId) request.abort()
    await validateRadioAudio(url, request.signal, undefined, 'progress' in musicInfo ? musicInfo.metadata.musicInfo.interval : musicInfo.interval)
  } : undefined
  gettingUrlId = createGettingUrlId(musicInfo)
  void getMusicPlayUrl(musicInfo, isRefresh, false, validateUrl).then((url) => {
    if (!url || request.signal.aborted || playMusicInfo.musicInfo !== musicInfo) return
    if (onReady) onReady(url)
    else setResource(url)
  }).catch((err: any) => {
    if (request.signal.aborted || playMusicInfo.musicInfo !== musicInfo) return
    console.log(err)
    if (radio && isRadioQueue() && radioPlayback.sessionId === sessionId) {
      const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
      radioPlayback.rejectMusic(songKey(info), '没有可用的完整歌曲音频')
      resetRandomNextMusicInfo()
      skipUnavailableRadioSong(musicInfo)
      return
    }
    setAllStatus(err.message)
    window.app_event.error()
    if (appSetting['player.autoSkipOnError']) addDelayNextTimeout()
  }).finally(() => {
    if (musicInfo === playMusicInfo.musicInfo && resourceAbort === request) {
      gettingUrlId = ''
      resourceAbort = null
      clearLoadTimeout()
    }
  })
}

// 恢复上次播放的状态
const handleRestorePlay = async(restorePlayInfo: LX.Player.SavedPlayInfo) => {
  const musicInfo = playMusicInfo.musicInfo
  if (!musicInfo) return

  setImmediate(() => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    window.app_event.setProgress(appSetting['player.isSavePlayTime'] ? restorePlayInfo.time : 0, restorePlayInfo.maxTime)
    window.app_event.pause()
  })


  void getPicPath({ musicInfo, listId: playMusicInfo.listId }).then((url: string) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id || url == _musicInfo.pic) return
    setMusicInfo({ pic: url })
    window.app_event.picUpdated()
  }).catch(_ => _)

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    window.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setAllStatus(window.i18n.t('lyric__load_error'))
  })

  if (appSetting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList({ ...playMusicInfo as LX.Player.PlayMusicInfo })
}


// 处理音乐播放
const handlePlay = () => {
  cancelResourceProbe()
  radioPlayback.songChanged()
  window.lx.isPlayedStop &&= false

  resetRandomNextMusicInfo()
  if (window.lx.restorePlayInfo) {
    void handleRestorePlay(window.lx.restorePlayInfo)
    window.lx.restorePlayInfo = null
    return
  }
  const musicInfo = playMusicInfo.musicInfo

  if (!musicInfo) return

  setStop()
  window.app_event.pause()

  clearDelayNextTimeout()
  clearLoadTimeout()


  if (appSetting['player.togglePlayMethod'] == 'random' && !playMusicInfo.isTempPlay) addPlayedList({ ...(playMusicInfo as LX.Player.PlayMusicInfo) })

  const startSong = () => {
    if (playMusicInfo.musicInfo !== musicInfo || window.lx.isPlayedStop) return
    window.app_event.pause()
    setMusicUrl(musicInfo)
  }
  const info = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  if (isRadioQueue()) {
    if (radioPlayback.isMusicRejected(songKey(info))) {
      skipUnavailableRadioSong(musicInfo)
      return
    }
    // The real music URL must be valid before announcing this song.
    setMusicUrl(musicInfo, false, url => {
      const startValidatedSong = () => {
        if (playMusicInfo.musicInfo !== musicInfo || window.lx.isPlayedStop) return
        setResource(url)
      }
      radioPlayback.setVolume(volume.value, isMute.value)
      if (!radioPlayback.beforeSong(songKey(info), startValidatedSong)) startValidatedSong()
      else if (!radioPlayback.isPaused) window.app_event.play()
    })
  } else {
    radioPlayback.cancel()
    startSong()
  }

  void getPicPath({ musicInfo, listId: playMusicInfo.listId }).then((url: string) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id || url == _musicInfo.pic) return
    setMusicInfo({ pic: url })
    window.app_event.picUpdated()
  }).catch(_ => _)

  void getLyricInfo({ musicInfo }).then((lyricInfo) => {
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setMusicInfo({
      lrc: lyricInfo.lyric,
      tlrc: lyricInfo.tlyric,
      lxlrc: lyricInfo.lxlyric,
      rlrc: lyricInfo.rlyric,
      rawlrc: lyricInfo.rawlrcInfo.lyric,
    })
    window.app_event.lyricUpdated()
  }).catch((err) => {
    console.log(err)
    if (musicInfo.id != playMusicInfo.musicInfo?.id) return
    setAllStatus(window.i18n.t('lyric__load_error'))
  })
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param id 歌曲id
 */
export const playListById = (listId: string, id: string) => {
  const prevListId = playInfo.playerListId
  setPlayListId(listId)
  // pause()
  const musicInfo = getList(listId).find(m => m.id == id)
  if (!musicInfo) return
  setPlayMusicInfo(listId, musicInfo)
  if (appSetting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  handlePlay()
}

/**
 * 播放列表内歌曲
 * @param listId 列表id
 * @param index 播放的歌曲位置
 */
export const playList = (listId: string, index: number) => {
  const prevListId = playInfo.playerListId
  setPlayListId(listId)
  // pause()
  setPlayMusicInfo(listId, getList(listId)[index])
  if (appSetting['player.isAutoCleanPlayedList'] || prevListId != listId) clearPlayedList()
  clearTempPlayeList()
  handlePlay()
}

const handleToggleStop = () => {
  stop()
  setTimeout(() => {
    setPlayMusicInfo(null, null)
  })
}

const randomNextMusicInfo = {
  info: null as LX.Player.PlayMusicInfo | null,
  // index: -1,
}

const playableRadioIndex = (list: Array<LX.Music.MusicInfo | LX.Download.ListItem>, index: number, wrap: boolean) => {
  for (let attempts = 0; attempts < list.length && index < list.length; attempts++, index++) {
    const song = list[index]
    if (!radioPlayback.isMusicRejected(songKey('progress' in song ? song.metadata.musicInfo : song))) return index
    if (wrap && index === list.length - 1) index = -1
  }
  return -1
}
export const resetRandomNextMusicInfo = () => {
  if (randomNextMusicInfo.info) {
    randomNextMusicInfo.info = null
    // randomNextMusicInfo.index = -1
  }
}

export const getNextPlayMusicInfo = async(): Promise<LX.Player.PlayMusicInfo | null> => {
  const requested = requestedRadioNext()
  if (requested) return requested
  if (tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = tempPlayList[0]
    return playMusicInfo
  }

  if (playMusicInfo.musicInfo == null) return null

  if (randomNextMusicInfo.info && !isRadioQueue()) return randomNextMusicInfo.info

  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) return null
  const currentList = getList(currentListId)

  if (playedList.length && !isRadioQueue()) { // 普通播放保留历史前进，电台按队列播放
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) return playedList[index]
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) return null
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = isRadioQueue() ? 'listLoop' : appSetting['player.togglePlayMethod']
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      return null
  }
  if (nextIndex >= 0 && isRadioQueue()) nextIndex = playableRadioIndex(filteredList, nextIndex, togglePlayMethod !== 'list')
  if (nextIndex < 0) return null

  const nextPlayMusicInfo = {
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  }

  if (togglePlayMethod == 'random') {
    randomNextMusicInfo.info = nextPlayMusicInfo
    // randomNextMusicInfo.index = nextIndex
  }
  return nextPlayMusicInfo
}

const handlePlayNext = (playMusicInfo: LX.Player.PlayMusicInfo) => {
  // pause()
  setPlayMusicInfo(playMusicInfo.listId, playMusicInfo.musicInfo, playMusicInfo.isTempPlay)
  handlePlay()
}
const skipUnavailableRadioSong = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => {
  // Pick a different remaining track even in single-loop/random mode.
  const list = getList(LIST_IDS.TEMP)
  const index = list.findIndex(song => song.id === musicInfo.id)
  const ordered = appSetting['player.togglePlayMethod'] === 'list'
    ? list.slice(index + 1) : [...list.slice(index + 1), ...list.slice(0, index)]
  const next = ordered.find(song => !radioPlayback.isMusicRejected(songKey('progress' in song ? song.metadata.musicInfo : song)))
  if (next) handlePlayNext({ listId: LIST_IDS.TEMP, musicInfo: next, isTempPlay: false })
  else {
    stop()
    setAllStatus('本期歌曲暂时均无可用的完整音频，请更换歌单或音源')
  }
}
/**
 * 下一曲
 * @param isAutoToggle 是否自动切换
 * @returns
 */
export const playNext = async(isAutoToggle = false): Promise<void> => {
  const requested = requestedRadioNext()
  cancelResourceProbe()
  radioPlayback.songChanged()
  if (requested) {
    handlePlayNext(requested)
    return
  }
  console.log('skip next', isAutoToggle)
  if (tempPlayList.length) { // 如果稍后播放列表存在歌曲则直接播放改列表的歌曲
    const playMusicInfo = tempPlayList[0]
    removeTempPlayList(0)
    handlePlayNext(playMusicInfo)
    console.log('play temp list')
    return
  }

  if (playMusicInfo.musicInfo == null) {
    handleToggleStop()
    console.log('musicInfo empty')
    return
  }

  // console.log(playInfo.playerListId)
  const currentListId = playInfo.playerListId
  if (!currentListId) {
    handleToggleStop()
    console.log('currentListId empty')
    return
  }
  const currentList = getList(currentListId)

  if (playedList.length && !isRadioQueue()) { // 普通播放保留历史前进，电台按队列播放
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) + 1; index < playedList.length; index++) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index < playedList.length) {
      handlePlayNext(playedList[index])
      console.log('play played list')
      return
    }
  }
  if (randomNextMusicInfo.info && !isRadioQueue()) {
    handlePlayNext(randomNextMusicInfo.info)
    return
  }
  // const isCheckFile = findNum > 2 // 针对下载列表，如果超过两次都碰到无效歌曲，则过滤整个列表内的无效歌曲
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: true,
  })

  if (!filteredList.length) {
    handleToggleStop()
    console.log('filtered list empty')
    return
  }
  // let currentIndex: number = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex

  let togglePlayMethod = isRadioQueue() ? 'listLoop' : appSetting['player.togglePlayMethod']
  if (!isAutoToggle) {
    switch (togglePlayMethod) {
      case 'list':
      case 'singleLoop':
      case 'none':
        togglePlayMethod = 'listLoop'
    }
  }
  switch (togglePlayMethod) {
    case 'listLoop':
      nextIndex = playerIndex === filteredList.length - 1 ? 0 : playerIndex + 1
      break
    case 'random':
      nextIndex = getRandom(0, filteredList.length)
      break
    case 'list':
      nextIndex = playerIndex === filteredList.length - 1 ? -1 : playerIndex + 1
      break
    case 'singleLoop':
      break
    default:
      nextIndex = -1
      console.log('stop toggle play', togglePlayMethod, isAutoToggle)
      return
  }
  if (nextIndex >= 0 && isRadioQueue()) nextIndex = playableRadioIndex(filteredList, nextIndex, togglePlayMethod !== 'list')
  if (nextIndex < 0) {
    console.log('next index empty')
    return
  }

  handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

/**
 * 上一曲
 */
export const playPrev = async(isAutoToggle = false): Promise<void> => {
  radioPlayback.songChanged()
  if (playMusicInfo.musicInfo == null) {
    handleToggleStop()
    return
  }

  const currentListId = playInfo.playerListId
  if (!currentListId) {
    handleToggleStop()
    return
  }
  const currentList = getList(currentListId)

  if (playedList.length) {
    let currentId: string
    if (playMusicInfo.isTempPlay) {
      const musicInfo = currentList[playInfo.playerPlayIndex]
      if (musicInfo) currentId = musicInfo.id
    } else {
      currentId = playMusicInfo.musicInfo.id
    }
    // 从已播放列表移除播放列表已删除的歌曲
    let index
    for (index = playedList.findIndex(m => m.musicInfo.id === currentId) - 1; index > -1; index--) {
      const playMusicInfo = playedList[index]
      const currentId = playMusicInfo.musicInfo.id
      if (playMusicInfo.listId == currentListId && !currentList.some(m => m.id === currentId)) {
        removePlayedList(index)
        continue
      }
      break
    }

    if (index > -1) {
      handlePlayNext(playedList[index])
      return
    }
  }

  // const isCheckFile = findNum > 2
  let { filteredList, playerIndex } = await filterList({ // 过滤已播放歌曲
    listId: currentListId,
    list: currentList,
    playedList,
    playerMusicInfo: currentList[playInfo.playerPlayIndex],
    isNext: false,
  })
  if (!filteredList.length) {
    handleToggleStop()
    return
  }

  // let currentIndex = filteredList.indexOf(currentList[playInfo.playerPlayIndex])
  if (playerIndex == -1 && filteredList.length) playerIndex = 0
  let nextIndex = playerIndex
  if (!playMusicInfo.isTempPlay) {
    let togglePlayMethod = appSetting['player.togglePlayMethod']
    if (!isAutoToggle) {
      switch (togglePlayMethod) {
        case 'list':
        case 'singleLoop':
        case 'none':
          togglePlayMethod = 'listLoop'
      }
    }
    switch (togglePlayMethod) {
      case 'random':
        nextIndex = getRandom(0, filteredList.length)
        break
      case 'listLoop':
      case 'list':
        nextIndex = playerIndex === 0 ? filteredList.length - 1 : playerIndex - 1
        break
      case 'singleLoop':
        break
      default:
        nextIndex = -1
        return
    }
    if (nextIndex < 0) return
  }

  handlePlayNext({
    musicInfo: filteredList[nextIndex],
    listId: currentListId,
    isTempPlay: false,
  })
}

/**
 * 恢复播放
 */
export const play = () => {
  window.lx.isPlayedStop &&= false
  if (radioPlayback.resume()) {
    if (radioPlayback.musicStarted && !isEmpty()) setPlay()
    window.app_event.play()
    return
  }
  if (playMusicInfo.musicInfo == null) return
  if (isEmpty()) {
    if (createGettingUrlId(playMusicInfo.musicInfo) != gettingUrlId) setMusicUrl(playMusicInfo.musicInfo)
    return
  }
  setPlay()
}

/**
 * 暂停播放
 */
export const pause = () => {
  if (radioPlayback.pause()) {
    if (radioPlayback.musicStarted) setPause()
    window.app_event.pause()
    return
  }
  setPause()
  if (isEmpty()) window.app_event.pause()
}

/**
 * 停止播放
 */
export const stop = () => {
  cancelResourceProbe()
  radioPlayback.cancel()
  setStop()
  setTimeout(() => {
    window.app_event.stop()
  })
}

/**
 * 播放、暂停播放切换
 */
export const togglePlay = () => {
  window.lx.isPlayedStop &&= false
  if (isPlay.value) {
    pause()
  } else {
    play()
  }
}

/**
 * 收藏当前播放的歌曲
 */
export const collectMusic = () => {
  if (!playMusicInfo.musicInfo) return
  void addListMusics(loveList.id, ['progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo : playMusicInfo.musicInfo])
}

/**
 * 取消收藏当前播放的歌曲
 */
export const uncollectMusic = () => {
  if (!playMusicInfo.musicInfo) return
  void removeListMusics({ listId: loveList.id, ids: ['progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo.id : playMusicInfo.musicInfo.id] })
}

/**
 * 不喜欢当前播放的歌曲
 */
export const dislikeMusic = async() => {
  if (!playMusicInfo.musicInfo) return
  const minfo = 'progress' in playMusicInfo.musicInfo ? playMusicInfo.musicInfo.metadata.musicInfo : playMusicInfo.musicInfo
  await addDislikeInfo([{ name: minfo.name, singer: minfo.singer }])
  await playNext(true)
}
