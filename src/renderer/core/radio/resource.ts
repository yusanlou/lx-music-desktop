import { getRadioAudioMinimum, MIN_RADIO_AUDIO_SECONDS, RADIO_ENCODER_PADDING_SECONDS } from '@common/radioAudio'
export { MIN_RADIO_AUDIO_SECONDS } from '@common/radioAudio'

/** Validate music media silently; never apply this limit to the host's speech. */

export class RadioAudioError extends Error {
  constructor(readonly reason: 'short_audio' | 'incomplete_audio' | 'unavailable', readonly duration?: number) {
    super(reason === 'incomplete_audio' ? `电台音频仅 ${duration!.toFixed(2)} 秒，疑似不完整试听片段` : reason === 'short_audio' ? `电台音频仅 ${duration!.toFixed(2)} 秒，疑似试听或占位音频` : '电台音频无法确认有效时长')
  }
}

export const validateRadioAudio = async(url: string, signal?: AbortSignal,
  createAudio: () => HTMLAudioElement = () => new Audio(), expectedInterval?: string | null): Promise<void> => {
  if (signal?.aborted) throw new DOMException('Radio audio probe cancelled', 'AbortError')
  const audio = createAudio()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      audio.onloadedmetadata = audio.ondurationchange = audio.oncanplay = audio.onerror = null
      signal?.removeEventListener('abort', abort)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
      finish(audio.duration <= MIN_RADIO_AUDIO_SECONDS + RADIO_ENCODER_PADDING_SECONDS
        ? new RadioAudioError('short_audio', audio.duration) : audio.duration < getRadioAudioMinimum(expectedInterval)
          ? new RadioAudioError('incomplete_audio', audio.duration) : undefined)
    }
    const abort = () => { finish(new DOMException('Radio audio probe cancelled', 'AbortError')) }
    const timer = setTimeout(() => { finish(new RadioAudioError('unavailable')) }, 8000)
    audio.autoplay = false
    audio.muted = true
    audio.volume = 0
    // Metadata-only media loads do not require the CDN to opt into CORS.
    audio.preload = 'metadata'
    audio.onloadedmetadata = audio.ondurationchange = audio.oncanplay = check
    audio.onerror = () => { finish(new RadioAudioError('unavailable')) }
    signal?.addEventListener('abort', abort, { once: true })
    audio.src = url
    audio.load()
  })
}
