export interface RadioSongIdentity { name: string, singer?: string }
export interface RadioAudioTags { title?: string, artist?: string, artists?: string[] }

const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const title = (text: string) => normalize(text.replace(/\s*[（(](?:原版|完整版|original(?: version)?|《[^》]+》[^)）]*)[)）]\s*$/i, ''))
const artists = (text: string) => text.normalize('NFKC').split(/[、&/;,，；|]/).filter(Boolean).map(artist => {
  const aliases = [...artist.matchAll(/\(([^)]+)\)/g)].map(match => normalize(match[1]))
  return new Set([normalize(artist.replace(/\([^)]*\)/g, '')), ...aliases].filter(Boolean))
})

/** Explicit media tags outrank provider/search claims. Untagged files remain unknown. */
export const assertRadioAudioIdentity = (tags: RadioAudioTags, wanted: RadioSongIdentity) => {
  if (tags.title?.trim() && title(tags.title) !== title(wanted.name)) throw new Error('radio_audio_identity_mismatch')
  const taggedArtists = tags.artists?.filter(Boolean)
  const actual = taggedArtists?.length ? taggedArtists.join('、') : tags.artist
  if (actual?.trim() && wanted.singer?.trim()) {
    const singers = artists(actual)
    if (!artists(wanted.singer).every(group => singers.some(other => [...group].some(name => other.has(name))))) {
      throw new Error('radio_audio_identity_mismatch')
    }
  }
}
