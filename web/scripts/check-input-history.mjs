import assert from 'node:assert/strict'
import { createRequire, Module } from 'node:module'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const web = fileURLToPath(new URL('..', import.meta.url))
const result = await build({
  absWorkingDir: web,
  entryPoints: ['src/features/conversation/useInputHistory.ts'],
  bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
  external: ['react'],
  plugins: [{ name: 'offline-api', setup(plugin) {
    plugin.onResolve({ filter: /^\.\.\/\.\.\/api$/ }, () => ({ path: 'api', namespace: 'mock' }))
    plugin.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      contents: 'export function getSessionPage() { throw new Error("Unexpected real API call"); }',
    }))
  } }],
})
const require = createRequire(new URL('../package.json', import.meta.url))
const bundled = new Module(`${web}/input-history-test.cjs`)
bundled.require = require
bundled._compile(result.outputFiles[0].text, bundled.id)
const { InputHistory, collectInputHistory } = bundled.exports
const user = (seq, text, injected = false) => ({ seq, time: seq, type: 'user-message', text, injected })
const page = events => ({ events, hasMoreBefore: false })

assert.deepEqual(collectInputHistory([
  user(1, 'one'), user(2, 'one'), user(3, 'injected', true),
  { seq: 4, type: 'command', text: '/clear' },
  { seq: 5, type: 'assistant-message', text: 'assistant' },
  user(6, '  '), user(7, 'two\nlines'), user(8, 'one'),
]), ['one', 'two\nlines', 'one'])
assert.equal(collectInputHistory(Array.from({ length: 80 }, (_, i) => user(i, `${i}`))).length, 50)

let server = [user(1, 'first'), user(2, 'second'), user(3, 'third')]
const history = new InputHistory('session', async () => page(server))
assert.equal(history.navigate('up', 'draft'), null)
assert.equal(await history.refresh(), true)
assert.equal(history.navigate('down', 'draft'), null)
assert.equal(history.navigate('up', 'draft\nmultiline'), 'third')
assert.equal(history.navigate('up', 'third'), 'second')
assert.equal(history.navigate('up', 'second'), 'first')
assert.equal(history.navigate('up', 'first'), null)
assert.equal(history.navigate('down', 'first'), 'second')
assert.equal(history.navigate('down', 'second'), 'third')
assert.equal(history.navigate('down', 'third'), 'draft\nmultiline')
assert.equal(history.navigate('down', 'draft\nmultiline'), null)
history.navigate('up', '')
assert.equal(history.navigate('down', 'third'), '')
history.navigate('up', 'old draft')
history.resetBrowse()
assert.equal(history.navigate('up', 'edited draft'), 'third')
assert.equal(history.navigate('down', 'third'), 'edited draft')

server = [user(1, 'first')]
await history.refresh()
assert.equal(history.navigate('up', ''), 'first')
assert.equal(history.navigate('up', ''), null)
server.push(user(4, 'after rewind'))
await history.refresh()
assert.equal(history.navigate('up', ''), 'after rewind')
const restored = new InputHistory('session', async () => page(server))
await restored.refresh()
assert.equal(restored.navigate('up', ''), 'after rewind')

const requests = []
const paged = new InputHistory('paged', async (id, options) => {
  requests.push({ id, ...options })
  return requests.length === 1
    ? { events: [user(101, 'new')], hasMoreBefore: true }
    : page([user(1, 'old')])
})
await paged.refresh()
assert.deepEqual(requests, [
  { id: 'paged', limit: 100, before: undefined },
  { id: 'paged', limit: 100, before: 101 },
])
assert.equal(paged.navigate('up', ''), 'new')
assert.equal(paged.navigate('up', ''), 'old')
let count = 0
const capped = new InputHistory('capped', async () => ({
  events: [user(1000 - ++count, 'injected', true)], hasMoreBefore: true,
}))
await capped.refresh()
assert.equal(count, 5)
count = 0
const fifty = new InputHistory('fifty', async () => {
  count++
  return { events: Array.from({ length: 60 }, (_, i) => user(i + 1, `${i}`)), hasMoreBefore: true }
})
await fifty.refresh()
assert.equal(count, 1)
for (let i = 59; i >= 10; i--) assert.equal(fifty.navigate('up', ''), `${i}`)
assert.equal(fifty.navigate('up', ''), null)

const pending = []
const racing = new InputHistory('race', (_id, _options, signal) => new Promise(resolve => {
  pending.push({ resolve, signal })
}))
const oldRefresh = racing.refresh()
const newRefresh = racing.refresh()
assert.equal(pending[0].signal.aborted, true)
pending[1].resolve(page([user(1, 'current')]))
assert.equal(await newRefresh, true)
pending[0].resolve(page([user(2, 'stale')]))
assert.equal(await oldRefresh, false)
assert.equal(racing.navigate('up', ''), 'current')
const clearing = racing.refresh()
assert.equal(racing.navigate('up', ''), null)
racing.clear()
pending[2].resolve(page([user(3, 'disposed')]))
assert.equal(await clearing, false)
assert.equal(racing.navigate('up', ''), null)

let fail = false
const failing = new InputHistory('fail', async () => {
  if (fail) throw new Error('offline')
  return page([user(1, 'removed')])
})
await failing.refresh()
fail = true
assert.equal(await failing.refresh(), false)
assert.equal(failing.navigate('up', ''), null)
const empty = new InputHistory(null, async () => { throw new Error('No session must not load') })
assert.equal(await empty.refresh(), true)
assert.equal(empty.navigate('up', ''), null)
console.log('input history: filtering, navigation, draft recovery, refresh/rewind, pagination and stale-request checks passed')
