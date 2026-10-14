const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function compile(relative, dependencies) {
  const file = path.resolve(__dirname, '../src/renderer', relative)
  const m = new Module(file, module)
  m.require = name => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
    return dependencies[name]
  }
  m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
  return m.exports
}
function fixture(search) {
  const dependencies = {
    '@common/utils/vueTools': { markRaw: value => value },
    '@renderer/utils/musicSdk': { __esModule: true, default: { kw: { musicSearch: { search } } } },
    '@renderer/utils': { deduplicationList: value => value, toNewMusicInfo: value => value },
    '@common/utils/common': { similar: () => 1, sortInsert: (items, value) => items.push(value) },
    './state': { sources: ['all', 'kw'], maxPages: {}, listInfos: { all: { limit: 30 }, kw: { limit: 30 } } },
    '@renderer/store/search/music/state': { sources: ['all', 'kw'] },
  }
  // Use the actual search binding used by the MCP caller, including before the fix.
  const binding = /import \{ (\w+) as searchMusic \} from '([^']+)'/.exec(fs.readFileSync(path.resolve(__dirname, '../src/renderer/core/useApp/useMcp.ts'), 'utf8'))
  const module = compile(binding[2].replace('@renderer/', '') + '.ts', dependencies)
  return module[binding[1]]
}

test('concurrent radio queries retain their own songs when the newer query finishes first', async () => {
  const previous = global.window; global.window = { i18n: { t: value => value } }
  const pending = {}
  try {
    const search = fixture(keyword => new Promise(resolve => { pending[keyword] = resolve }))
    const first = search('旅行的意义 陈绮贞', 1, 'all')
    const second = search('安静 周杰伦', 1, 'all')
    pending['安静 周杰伦']({ source: 'kw', list: [{ name: '安静', singer: '周杰伦' }], allPage: 1, total: 1, limit: 30 })
    pending['旅行的意义 陈绮贞']({ source: 'kw', list: [{ name: '旅行的意义', singer: '陈绮贞' }], allPage: 1, total: 1, limit: 30 })
    assert.equal((await first)[0]?.name, '旅行的意义')
    assert.equal((await second)[0]?.name, '安静')
  } finally { global.window = previous }
})

test('radio reports a failed search service distinctly from a successful empty search', async () => {
  await assert.rejects(fixture(async () => { throw new Error('private provider failure') })('旅行的意义', 1, 'all'), /radio_search_unavailable/)
  assert.deepEqual(await fixture(async () => ({ source: 'kw', list: [], allPage: 1 }))('不存在的歌曲', 1, 'all'), [])
})
