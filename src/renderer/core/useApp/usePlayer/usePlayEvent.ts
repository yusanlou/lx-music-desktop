import { onBeforeUnmount } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { musicInfo, playMusicInfo } from '@renderer/store/player/state'
import { setStop, isEmpty, getCurrentTime } from '@renderer/plugins/player'
import { playNext, setMusicUrl } from '@renderer/core/player'
import { setAllStatus } from '@renderer/store/player/action'
import { appSetting } from '@renderer/store/setting'
import { radioPlayback } from '@renderer/core/radio/playback'
import { tempListMeta } from '@renderer/store/list/state'
import { LIST_IDS } from '@common/constants'

const isRadioQueue = () => radioPlayback.enabled && playMusicInfo.listId === LIST_IDS.TEMP &&
  tempListMeta.id?.startsWith('mcp_radio_') === true && !playMusicInfo.isTempPlay

export default () => {
  const t = useI18n()
  let retryNum = 0
  let prevTimeoutId: string | null = null

  let loadingTimeout: NodeJS.Timeout | null = null
  let delayNextTimeout: NodeJS.Timeout | null = null
  let bufferTimeout: NodeJS.Timeout | null = null
  const clearBufferTimeout = () => {
    if (bufferTimeout) clearTimeout(bufferTimeout)
    bufferTimeout = null
  }
  const startLoadingTimeout = () => {
    // console.log('start load timeout')
    clearLoadingTimeout()
    loadingTimeout = setTimeout(() => {
      if (window.lx.isPlayedStop) {
        prevTimeoutId = null
        setAllStatus('')
        return
      }

      // 如果加载超时，则尝试刷新URL
      if (prevTimeoutId == musicInfo.id) {
        prevTimeoutId = null
        void playNext(true)
      } else {
        prevTimeoutId = musicInfo.id
        if (playMusicInfo.musicInfo) setMusicUrl(playMusicInfo.musicInfo, true)
      }
    }, 25000)
  }
  const clearLoadingTimeout = () => {
    if (!loadingTimeout) return
    // console.log('clear load timeout')
    clearTimeout(loadingTimeout)
    loadingTimeout = null
  }

  const clearDelayNextTimeout = () => {
    // console.log(this.delayNextTimeout)
    if (!delayNextTimeout) return
    clearTimeout(delayNextTimeout)
    delayNextTimeout = null
  }
  const addDelayNextTimeout = () => {
    clearDelayNextTimeout()
    delayNextTimeout = setTimeout(() => {
      if (window.lx.isPlayedStop) {
        setAllStatus('')
        return
      }
      void playNext(true)
    }, 5000)
  }

  const handleLoadstart = () => {
    if (window.lx.isPlayedStop) return
    if (isRadioQueue() || appSetting['player.autoSkipOnError']) startLoadingTimeout()
    setAllStatus(t('player__loading'))
  }

  const handleLoadeddata = () => {
    setAllStatus(t('player__loading'))
  }

  const handlePlaying = () => {
    setAllStatus('')
    clearLoadingTimeout()
    clearBufferTimeout()
  }

  const handleEmpied = () => {
    clearDelayNextTimeout()
    clearLoadingTimeout()
    clearBufferTimeout()
  }

  const handleWating = () => {
    setAllStatus(t('player__buffering'))
    if (!isRadioQueue() || bufferTimeout) return
    const currentMusic = playMusicInfo.musicInfo
    const position = radioPlayback.positionId
    bufferTimeout = setTimeout(() => {
      bufferTimeout = null
      if (window.lx.isPlayedStop || !isRadioQueue() || currentMusic !== playMusicInfo.musicInfo || position !== radioPlayback.positionId) return
      if (retryNum >= 2) { void playNext(true); return }
      retryNum++
      window.app_event.setProgress(getCurrentTime())
      if (currentMusic) setMusicUrl(currentMusic, true)
    }, 8000)
  }

  const handleError = (errCode?: number) => {
    if (!musicInfo.id) return
    clearLoadingTimeout()
    clearBufferTimeout()
    if (window.lx.isPlayedStop) return
    if (!isEmpty()) setStop()
    if (playMusicInfo.musicInfo && errCode !== 1 && retryNum < 2) { // 若音频URL无效则尝试刷新2次URL
      // console.log(this.retryNum)
      retryNum++
      setMusicUrl(playMusicInfo.musicInfo, true)
      if (!isRadioQueue()) setAllStatus(t('player__refresh_url'))
      return
    }

    if (isRadioQueue()) {
      void playNext(true)
    } else if (appSetting['player.autoSkipOnError']) {
      if (document.hidden) {
        console.warn('error skip to next')
        void playNext(true)
      } else {
        setAllStatus(t('player__error'))
        setTimeout(addDelayNextTimeout)
      }
    }
  }

  const handleSetPlayInfo = () => {
    retryNum = 0
    prevTimeoutId = null
    clearDelayNextTimeout()
    clearLoadingTimeout()
    clearBufferTimeout()
  }

  // const handlePlayedStop = () => {
  //   clearDelayNextTimeout()
  //   clearLoadingTimeout()
  // }


  window.app_event.on('playerLoadstart', handleLoadstart)
  window.app_event.on('playerLoadeddata', handleLoadeddata)
  window.app_event.on('playerPlaying', handlePlaying)
  window.app_event.on('playerWaiting', handleWating)
  window.app_event.on('playerEmptied', handleEmpied)
  window.app_event.on('playerError', handleError)
  window.app_event.on('musicToggled', handleSetPlayInfo)
  window.app_event.on('pause', clearBufferTimeout)
  window.app_event.on('stop', clearBufferTimeout)

  onBeforeUnmount(() => {
    clearLoadingTimeout()
    clearDelayNextTimeout()
    clearBufferTimeout()
    window.app_event.off('playerLoadstart', handleLoadstart)
    window.app_event.off('playerLoadeddata', handleLoadeddata)
    window.app_event.off('playerPlaying', handlePlaying)
    window.app_event.off('playerWaiting', handleWating)
    window.app_event.off('playerEmptied', handleEmpied)
    window.app_event.off('playerError', handleError)
    window.app_event.off('musicToggled', handleSetPlayInfo)
    window.app_event.off('pause', clearBufferTimeout)
    window.app_event.off('stop', clearBufferTimeout)
  })
}
