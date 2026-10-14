const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const filename = path.resolve(__dirname, '../src/renderer/core/radio/queue.ts')
const runtime = new Module(filename, module)
runtime._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename)
const { selectQueuedRemoval, selectDistinctNextSong } = runtime.exports
const songs = ['past', 'current', 'future'].map(id => ({ id, source: 'kg' }))
const state = { active: true, sessionId: 3, anchor: 'anchor', current: songs[1], songs }
const request = { sessionId: 3, anchor: 'anchor', songId: 'future', source: 'kg' }

test('a single-song loop reports no next recording but a newly appended track is available', () => {
  assert.equal(selectDistinctNextSong(songs[1], { ...songs[1] }), null)
  assert.equal(selectDistinctNextSong(songs[1], songs[2]), songs[2])
  assert.equal(selectDistinctNextSong(songs[1], null), null)
})

test('a radio correction selects only the requested future entry', () => {
  assert.deepEqual(selectQueuedRemoval(state, request), { allowed: true, id: 'future' })
  assert.deepEqual(state.songs, songs)
})
test('old sessions, changed playback positions and ordinary playlists are protected', () => {
  for (const change of [{ sessionId: 2 }, { anchor: 'new-position' }, { active: false }, { current: null }]) {
    assert.equal(selectQueuedRemoval({ ...state, ...change }, request).reason, 'stale')
  }
})
test('the current song and already played entries cannot be removed', () => {
  for (const songId of ['past', 'current']) {
    assert.equal(selectQueuedRemoval(state, { ...request, songId }).reason, 'not_future_song')
  }
})
test('an unavailable song or a different source does not remove another entry', () => {
  assert.equal(selectQueuedRemoval(state, { ...request, source: 'wy' }).reason, 'not_in_queue')
  assert.equal(selectQueuedRemoval(state, { ...request, songId: 'unknown' }).reason, 'not_in_queue')
})
test('ids shared with a different source are rejected because list removal uses only ids', () => {
  const duplicated = { ...state, songs: [...songs, { id: 'current', source: 'wy' }] }
  assert.equal(selectQueuedRemoval(duplicated, { ...request, songId: 'current', source: 'wy' }).reason, 'ambiguous_id')
})
