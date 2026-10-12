import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(rootDir, 'node_modules/.shots/mcp-management.mjs')
mkdirSync(dirname(output), { recursive: true })
await build({
  entryPoints: [join(rootDir, 'src/components/settings/McpSettings.tsx')], outfile: output,
  bundle: true, format: 'esm', platform: 'node', jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' }, logLevel: 'silent',
})
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' })
const w = dom.window
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'localStorage', 'navigator']) {
  Object.defineProperty(globalThis, key, { value: key === 'window' ? w : w[key], configurable: true })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { McpSettings } = await import(pathToFileURL(output).href)
const root = createRoot(document.getElementById('root'))
const requests = []
const args = ['file with spaces', 'a"quoted"value', 'C:\\folder space\\file', '--api-key', 'fixture-api-value', '--token=fixture-token-value', '--password', 'fixture-password-value', '--secret=fixture-secret-value', '--authorization', 'fixture-auth-value']
const server = (id, status, extra = {}) => ({
  id, status, transport: 'stdio', command: 'npx', args: [], envKeys: ['PRIVATE_KEY'], headerKeys: [], enabled: status !== 'disabled', tools: [], ...extra,
})
const snapshot = {
  servers: [
    server('local-tools', 'connected', { args }),
    server('remote-tools', 'error', { transport: 'http', command: '', url: 'https://fixture-user:fixture-pass@example.test/mcp?api_key=fixture-query-value&mode=safe' }),
    server('paused-tools', 'disabled'),
  ], toolCount: 0,
}
globalThis.fetch = async (path, init = {}) => {
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(init.body) : null
  requests.push({ path, method, body })
  assert.ok(path === '/api/mcp' || path === '/api/mcp/servers', '仅允许模拟 MCP 路由')
  return new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json' } })
}
const act = React.act
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const click = async (node) => { assert.ok(node, '目标按钮存在'); await act(async () => { node.click(); await settle() }) }
const button = (text, parent = document) => [...parent.querySelectorAll('button')].find((item) => item.textContent === text)
const input = async (node, value) => {
  assert.ok(node, '目标输入存在')
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new w.Event('input', { bubbles: true }))
    await settle()
  })
}
const cards = () => [...document.querySelectorAll('li')].filter((node) => node.querySelector('h3'))
try {
  await act(async () => { root.render(React.createElement(McpSettings, { notify: () => {} })); await settle() })
  assert.equal(cards().length, 3)
  const cardText = cards().map((card) => card.textContent).join(' ')
  const titles = [...document.querySelectorAll('[title]')].map((node) => node.title).join(' ')
  for (const secret of ['fixture-api-value', 'fixture-token-value', 'fixture-password-value', 'fixture-secret-value', 'fixture-auth-value', 'fixture-user', 'fixture-pass', 'fixture-query-value']) {
    assert.equal(cardText.includes(secret), false, '卡片正文不泄露测试凭据')
    assert.equal(titles.includes(secret), false, '悬浮标题不泄露测试凭据')
  }
  assert.match(cardText, /••••/)
  assert.match(titles, /••••/)
  assert.match(cardText, /mode=safe/)
  console.log('ok 命令敏感参数与 URL 凭据在卡片正文及 title 中脱敏')

  await input(document.querySelector('input[type=search]'), 'local-tools')
  assert.equal(cards().length, 1)
  assert.match(cards()[0].textContent, /local-tools/)
  await input(document.querySelector('input[type=search]'), 'example.test')
  assert.equal(cards().length, 1)
  assert.match(cards()[0].textContent, /remote-tools/)
  await input(document.querySelector('input[type=search]'), '')
  const select = document.querySelector('select')
  for (const [status, id] of [['connected', 'local-tools'], ['error', 'remote-tools'], ['disabled', 'paused-tools']]) {
    await act(async () => { select.value = status; select.dispatchEvent(new w.Event('change', { bubbles: true })); await settle() })
    assert.equal(cards().length, 1)
    assert.match(cards()[0].textContent, new RegExp(id))
  }
  await act(async () => { select.value = 'all'; select.dispatchEvent(new w.Event('change', { bubbles: true })); await settle() })
  console.log('ok 名称、地址搜索与全部连接状态筛选生效')

  await click(button('编辑', cards().find((card) => card.textContent.includes('local-tools'))))
  const dialog = document.querySelector('[role=dialog]')
  assert.ok(dialog)
  const argsInput = [...dialog.querySelectorAll('input')].find((node) => node.value === JSON.stringify(args))
  assert.ok(argsInput, '参数使用 JSON 数组完整回填')
  assert.deepEqual(JSON.parse(argsInput.value), args)
  assert.ok([...dialog.querySelectorAll('textarea')].every((node) => node.value === ''), '不回填敏感环境变量')
  await click(button('保存', dialog))
  const saved = requests.findLast((request) => request.method === 'PUT')
  assert.ok(saved)
  assert.equal(saved.body.preserveSecrets, true)
  assert.deepEqual(saved.body.server.args, args)
  assert.deepEqual(saved.body.server.env, {})
  assert.deepEqual(saved.body.server.headers, {})
  assert.equal(requests.some((request) => request.path.startsWith('/api/settings')), false)
  console.log('ok 编辑请求 preserveSecrets=true，敏感字段不回填，空格/引号/反斜杠参数往返保真')
  console.log('MCP management checks passed. Mock HTTP only; no real configuration writes.')
} finally {
  await act(async () => root.unmount())
  dom.window.close()
}
