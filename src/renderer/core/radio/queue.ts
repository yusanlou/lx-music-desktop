interface Song { id: string, source: string }
interface QueueState {
  active: boolean
  sessionId: number
  anchor: string
  current: Song | null
  songs: Song[]
}
interface Removal { sessionId: number, anchor: string, songId: string, source: string }

/** A one-song loop has no distinct next recording to introduce. */
export function selectDistinctNextSong<T extends Song>(current: Song | null, next: T | null): T | null {
  return current && next && current.id === next.id && current.source === next.source ? null : next
}

/** A correction may remove a future entry only in the captured radio position. */
export function selectQueuedRemoval(state: QueueState, request: Removal) {
  if (!state.active || state.sessionId !== request.sessionId || state.anchor !== request.anchor || !state.current) {
    return { allowed: false as const, reason: 'stale' }
  }
  const current = state.songs.findIndex(song => song.id === state.current!.id && song.source === state.current!.source)
  const target = state.songs.findIndex(song => song.id === request.songId && song.source === request.source)
  if (target < 0) return { allowed: false as const, reason: 'not_in_queue' }
  if (current < 0 || target <= current) return { allowed: false as const, reason: 'not_future_song' }
  // The underlying list API removes by id, so ambiguous ids are unsafe.
  if (state.songs.filter(song => song.id === state.songs[target].id).length !== 1) {
    return { allowed: false as const, reason: 'ambiguous_id' }
  }
  return { allowed: true as const, id: state.songs[target].id }
}
