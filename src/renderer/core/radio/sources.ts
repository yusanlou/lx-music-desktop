import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { rendererInvoke } from '@common/rendererIpc'
import { ref } from '@common/utils/vueTools'
import { toOldMusicInfo } from '@renderer/utils'

export const radioSourcesEnabled = ref(false)
export const validateRadioMusicIdentity = async(url: string, song: { name: string, singer?: string }) => {
  await rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.radio_audio_identity, { url, song: { name: song.name, singer: song.singer } })
}
export const configureRadioSources = async(enabled: boolean) => {
  radioSourcesEnabled.value = enabled
  await rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.radio_sources_configure, enabled)
}
export const observeRadioSong = (musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality) => {
  void rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.radio_sources_observe, {
    source: musicInfo.source, action: 'musicUrl', info: { type: quality, musicInfo: toOldMusicInfo(musicInfo) },
  }).catch(() => {})
}
export const resolveRadioMusicUrl = async(musicInfo: LX.Music.MusicInfoOnline, quality: LX.Quality, refresh: boolean, failedUrl?: string, timeoutMs?: number): Promise<string> => {
  const result = await rendererInvoke<any, { url: string }>(WIN_MAIN_RENDERER_EVENT_NAME.radio_sources_resolve, {
    request: { source: musicInfo.source, action: 'musicUrl', info: { type: quality, musicInfo: toOldMusicInfo(musicInfo) } },
    refresh,
    failedUrl,
    timeoutMs,
  })
  return result.url
}
