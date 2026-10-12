import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'denia-sidebar-memory-'))
try {
  const output = join(dir, 'memory.mjs')
  await build({ entryPoints: [join(root, 'src/sidebarMemory.ts')], outfile: output, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
  let stored = null
  globalThis.window = { localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value } }, location: { hash: '#s=child%201' } }
  const { readCollapsedChildren, writeCollapsedChildren, restoredSidebarSession } = await import(pathToFileURL(output).href)
  assert.deepEqual(readCollapsedChildren(), {})
  writeCollapsedChildren({ parent: true, expanded: false })
  assert.deepEqual(readCollapsedChildren(), { parent: true }, '刷新后保留收起状态')
  writeCollapsedChildren({})
  assert.deepEqual(readCollapsedChildren(), {}, '全部展开清除收起记忆')
  stored = '{bad'
  assert.deepEqual(readCollapsedChildren(), {})
  stored = '[true]'
  assert.deepEqual(readCollapsedChildren(), {})
  stored = '{"a":true,"b":"true","c":false}'
  assert.deepEqual(readCollapsedChildren(), { a: true })
  assert.equal(restoredSidebarSession(null), 'child 1', '初始化识别待恢复会话，不触发祖先展开')
  assert.equal(restoredSidebarSession('current'), 'current')
  window.location.hash = '#s=%'
  assert.equal(restoredSidebarSession(null), null)
  window.localStorage.getItem = () => { throw new Error('blocked') }
  window.localStorage.setItem = () => { throw new Error('quota') }
  assert.deepEqual(readCollapsedChildren(), {})
  assert.doesNotThrow(() => writeCollapsedChildren({ parent: true }))
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8')
  assert.ok(app.includes('useState(readCollapsedChildren)'))
  assert.ok(app.includes('activeId === revealedSessionRef.current'), '同会话推送不覆盖折叠状态')
  console.log('ok sidebar collapse persistence, restore, expand-all and storage failures')
} finally { rmSync(dir, { recursive: true, force: true }) }
