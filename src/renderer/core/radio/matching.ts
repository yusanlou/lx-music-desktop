import { MIN_RADIO_AUDIO_SECONDS, parseRadioInterval } from '@common/radioAudio'

interface SongIdentity { name: string, singer?: string }
interface SearchSong { name: string, singer: string, interval?: string | null }
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const title = (value: string) => normalize(value.replace(/\s*[（(](?:原版|完整版|original(?: version)?)[)）]\s*$/i, ''))
const artists = (value: string) => value.normalize('NFKC').split(/[、&/;,，；|]/).filter(Boolean).map(artist => {
  const aliases = [...artist.matchAll(/\(([^)]+)\)/g)].map(match => normalize(match[1]))
  return new Set([normalize(artist.replace(/\([^)]*\)/g, '')), ...aliases].filter(Boolean))
})

/** Keep the requested recording identity; playability is verified separately. */
export const selectRadioSong = <T extends SearchSong>(list: T[], wanted: SongIdentity): T | undefined => {
  const requestedArtists = artists(wanted.singer ?? '')
  const ranked = list.flatMap((song, index) => {
    if (title(song.name) !== title(wanted.name)) return []
    const duration = parseRadioInterval(song.interval)
    if (duration != null && duration <= MIN_RADIO_AUDIO_SECONDS) return []
    const singers = artists(song.singer)
    if (!requestedArtists.every(group => singers.some(other => [...group].some(name => other.has(name))))) return []
    const rank = (duration == null ? 10 : 0) +
      (wanted.singer && normalize(song.singer) !== normalize(wanted.singer) ? 1 : 0) +
      Math.max(0, singers.length - requestedArtists.length)
    return [{ song, rank, index }]
  })
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked[0]?.song
}

/** A fallback must preserve the recording being displayed and announced. */
export const isSameRadioRecording = (candidate: SearchSong, wanted: SearchSong): boolean => {
  if (!selectRadioSong([candidate], wanted)) return false
  const expected = parseRadioInterval(wanted.interval)
  const actual = parseRadioInterval(candidate.interval)
  return expected == null || actual == null || Math.abs(expected - actual) <= 5
}
