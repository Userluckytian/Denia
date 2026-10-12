import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(rootDir, 'node_modules/.shots/skills-management.mjs')
mkdirSync(dirname(output), { recursive: true })
await build({
  entryPoints: [join(rootDir, 'src/components/extensions/SkillsManager.tsx')], outfile: output,
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
w.HTMLDialogElement.prototype.showModal = function () { this.open = true }
w.HTMLDialogElement.prototype.close = function () { this.open = false }
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { SkillsManager } = await import(pathToFileURL(output).href)
const root = createRoot(document.getElementById('root'))
const requests = []
const fixture = (name, source) => ({ name, source, description: `${name} description`, enabled: true, editable: source !== 'builtin', resourceBase: `/skills/${name}`, path: `/skills/${name}/SKILL.md` })
let skills = [fixture('user-tool', 'user-denia'), fixture('project-tool', 'project-denia'), fixture('built-tool', 'builtin')]
let html = false
let failSave = false
globalThis.fetch = async (path, init = {}) => {
  const method = init.method || 'GET'
  const body = init.body ? JSON.parse(init.body) : null
  requests.push({ path, method, body })
  const url = new URL(path, 'http://localhost')
  const name = decodeURIComponent(url.pathname.split('/')[3] || '')
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
  if (html) return new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } })
  if (method === 'PUT') {
    if (failSave) return json({ error: { code: 'invalid', message: '测试保存失败' } }, 400)
    return json({ skill: fixture(name, 'user-denia') })
  }
  if (method === 'DELETE') { skills = skills.filter((skill) => skill.name !== name); return json({ ok: true }) }
  if (method === 'POST') return json({ skill: fixture(name, 'user-denia'), skills: [] })
  if (name) return json({ skill: skills.find((skill) => skill.name === name), raw: `---\nname: ${name}\n---\n\nComplete markdown`, body: 'Complete markdown' })
  return json({ skills, directory: '/skills' })
}
const act = React.act
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const click = async (node) => { assert.ok(node, '目标按钮存在'); await act(async () => { node.click(); await settle() }) }
const button = (text, parent = document) => [...parent.querySelectorAll('button')].find((item) => item.textContent === text)
const input = async (node, value) => {
  await act(async () => {
    const prototype = node.tagName === 'TEXTAREA' ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value)
    node.dispatchEvent(new w.Event('input', { bubbles: true }))
    await settle()
  })
}
const render = async (cwd) => { await act(async () => { root.render(React.createElement(SkillsManager, { cwd })); await settle() }) }
const cards = () => [...document.querySelectorAll('article')]

await render('D:\\project space')
assert.equal(new URL(requests[0].path, 'http://localhost').searchParams.get('cwd'), 'D:\\project space')
assert.equal(cards().length, 3)
await click(button('项目'))
assert.equal(cards().length, 1)
assert.match(cards()[0].textContent, /project-tool/)
await click(button('全部'))
await input(document.querySelector('input[type=search]'), 'user-tool description')
assert.equal(cards().length, 1)
await input(document.querySelector('input[type=search]'), '')
console.log('ok 查询携带 cwd，来源与名称描述搜索过滤生效')

const builtin = cards().find((card) => card.textContent.includes('built-tool'))
assert.equal(button('删除', builtin), undefined)
assert.equal(button('编辑', builtin), undefined)
await click(button('查看', builtin))
assert.equal(document.querySelector('textarea').readOnly, true)
assert.equal(button('保存技能'), undefined)
await click(button('完成'))
console.log('ok 内置技能只读且不显示删除/保存')

await click(button('新建技能'))
const nameInput = document.querySelector('input[aria-label="技能名称 *"]')
await input(nameInput, 'Bad_Name')
assert.equal(button('保存技能').disabled, true)
await input(nameInput, 'new-tool')
assert.match(document.querySelector('textarea').value, /name: new-tool/)
await click(button('保存技能'))
let saved = requests.findLast((request) => request.method === 'PUT')
assert.equal(saved.body.create, true)
assert.equal(saved.body.scope, 'user')
assert.equal(saved.body.cwd, 'D:\\project space')
console.log('ok 新建名称校验、frontmatter 同步与用户作用域保存')

await click(button('编辑', cards()[0]))
assert.match(document.querySelector('textarea').value, /^---/)
await input(document.querySelector('textarea'), '---\nname: user-tool\n---\nEdited body')
failSave = true
await click(button('保存技能'))
assert.match(document.querySelector('dialog').textContent, /测试保存失败/)
assert.match(document.querySelector('textarea').value, /Edited body/)
failSave = false
await click(button('保存技能'))
saved = requests.findLast((request) => request.method === 'PUT')
assert.equal(saved.body.create, false)
assert.match(saved.body.content, /Edited body/)
console.log('ok 编辑使用完整 Markdown；保存失败保留草稿并可重试')

await click(cards()[0].querySelector('[role=switch]'))
assert.equal(requests.findLast((request) => request.method === 'POST').body.enabled, false)
await click(button('删除', cards()[0]))
assert.equal(requests.some((request) => request.method === 'DELETE'), false)
await click(button('删除技能'))
assert.equal(requests.some((request) => request.method === 'DELETE'), true)
assert.equal(cards().length, 2)
console.log('ok 启停发送明确状态，删除必须确认后才请求')

html = true
await render('D:\\another')
assert.match(document.querySelector('[role=alert]').textContent, /当前服务尚未提供技能管理接口，请更新并重启服务。/)
assert.equal(document.body.textContent.includes('还没有技能'), false)
html = false
await click(button('重试'))
assert.equal(cards().length, 2)
console.log('ok SPA HTML 使用友好错误、不冒充空列表，重试恢复')
await act(async () => root.unmount())
dom.window.close()
console.log('Skills management checks passed. Mock HTTP only; no real skills/configuration writes.')
