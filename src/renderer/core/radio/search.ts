import music from '@renderer/utils/musicSdk'
import { deduplicationList, toNewMusicInfo } from '@renderer/utils'
import { sources } from '@renderer/store/search/music/state'

/** Radio/API callers own their results; GUI search cancellation is unrelated. */
export const searchRadioMusic = async(text: string, page: number, source: LX.OnlineSource | 'all'): Promise<LX.Music.MusicInfo[]> => {
  if (!text.trim()) return []
  const platforms = source === 'all' ? sources.filter(item => item !== 'all') as LX.OnlineSource[] : [source]
  const results = await Promise.allSettled(platforms.map(async platform => music[platform].musicSearch.search(text, page, 30)))
  const available = results.flatMap(result => result.status === 'fulfilled' && Array.isArray(result.value?.list) ? [result.value] : [])
  if (!available.length) throw new Error('radio_search_unavailable')
  return deduplicationList(available.flatMap(result => result.allPage < page ? [] : result.list).map(toNewMusicInfo))
}
