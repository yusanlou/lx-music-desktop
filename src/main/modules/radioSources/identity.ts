import { type Readable } from 'node:stream'
import { request } from '@common/utils/request'
import { assertRadioAudioIdentity, type RadioAudioTags, type RadioSongIdentity } from '@common/radioIdentity'

const PREFIX_BYTES = 256 * 1024
const verified = new Map<string, { tags: RadioAudioTags, expires: number }>()

/** Read a bounded file prefix in the main process: media CDNs need not allow CORS. */
export const readRadioAudioTags = async(url: string): Promise<RadioAudioTags> => {
  const response = await request<Readable>(url, {
    needBody: true,
    timeout: 4000,
    retryNum: 0,
    signal: AbortSignal.timeout(4000),
    headers: { Range: `bytes=0-${PREFIX_BYTES - 1}` },
  })
  const stream = response.body
  stream.on('error', () => {})
  try {
    if (response.statusCode !== 200 && response.statusCode !== 206) throw new Error('radio_audio_identity_unavailable')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk).subarray(0, PREFIX_BYTES - length)
      chunks.push(bytes); length += bytes.length
      if (length >= PREFIX_BYTES) break
    }
    const { parseBuffer } = await import('music-metadata')
    // Many formats have no leading tags. Failure to parse a bounded prefix is
    // unknown identity, never proof of matching or a reason to invent a title.
    const metadata = await parseBuffer(Buffer.concat(chunks), {
      mimeType: response.headers['content-type'],
      size: Number(response.headers['content-range']?.split('/').at(-1) || response.headers['content-length']) || undefined,
    }, { skipCovers: true, skipPostHeaders: true }).catch(() => null)
    return metadata ? { title: metadata.common.title, artist: metadata.common.artist, artists: metadata.common.artists } : {}
  } finally { stream.destroy() }
}

export const validateRadioAudioIdentity = async(url: string, wanted: RadioSongIdentity): Promise<void> => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url) || typeof wanted?.name !== 'string' || !wanted.name.trim() ||
    (wanted.singer != null && typeof wanted.singer !== 'string')) throw new Error('radio_audio_identity_invalid_request')
  const cached = verified.get(url)
  let tags = cached && cached.expires > Date.now() ? cached.tags : undefined
  if (!tags) {
    try { tags = await readRadioAudioTags(url) } catch { throw new Error('radio_audio_identity_unavailable') }
    verified.set(url, { tags, expires: Date.now() + 5 * 60_000 })
    if (verified.size > 64) verified.delete(verified.keys().next().value!)
  }
  // Cache tags, not a success verdict: the same bad URL may serve many songs.
  assertRadioAudioIdentity(tags, wanted)
}
