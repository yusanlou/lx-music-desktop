export const MIN_RADIO_AUDIO_SECONDS = 30
export const RADIO_ENCODER_PADDING_SECONDS = 0.25

export const parseRadioInterval = (interval?: string | null): number | undefined => {
  if (typeof interval !== 'string' || !/^\d{1,3}(?::\d{2}){1,2}$/.test(interval)) return
  const parts = interval.split(':').map(Number)
  if (parts.slice(1).some(value => value >= 60)) return
  return parts.reduce((total, value) => total * 60 + value, 0)
}

/** Leave room for small version/metadata differences, but reject 60/90s previews. */
export const getRadioAudioMinimum = (interval?: string | null): number =>
  Math.max(MIN_RADIO_AUDIO_SECONDS + RADIO_ENCODER_PADDING_SECONDS, (parseRadioInterval(interval) ?? 0) * 0.8)
