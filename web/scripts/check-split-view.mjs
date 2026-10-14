// Split view routing: drop placement, sidebar click routing, exit and
// reconciliation are pure functions — verify them without a browser.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { build } from 'esbuild'

const web = fileURLToPath(new URL('..', import.meta.url))
const outDir = join(web, 'node_modules', '.shots')
mkdirSync(outDir, { recursive: true })
const bundle = join(outDir, 'split-view.mjs')
await build({
  entryPoints: [join(web, 'src/splitView.ts')],
  outfile: bundle, bundle: true, format: 'esm', platform: 'node',
  logLevel: 'silent',
})

// readSplitRatio / writeSplitRatio 走 window.localStorage:node 里给最小桩。
const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
  },
}

const {
  DEFAULT_SPLIT_RATIO,
  SESSION_DRAG_MIME,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  clampSplitRatio,
  dropSessionOnSide,
  exitSplit,
  openSessionInView,
  ratioFromPointer,
  readSplitRatio,
  reconcileSplit,
  sessionInSlot,
  slotAtSide,
  writeSplitRatio,
} = await import(pathToFileURL(bundle).href)

const check = (name, fn) => { fn(); console.log(`ok   ${name}`) }

const single = { primaryId: 'a', split: null }
const splitRight = { primaryId: 'a', split: { secondaryId: 'b', side: 'right', focus: 'secondary' } }
const splitLeft = { primaryId: 'a', split: { secondaryId: 'b', side: 'left', focus: 'primary' } }

check('未分屏时副窗格默认视作在右侧', () => {
  assert.equal(slotAtSide(single, 'right'), 'secondary')
  assert.equal(slotAtSide(single, 'left'), 'primary')
})
check('分屏位置决定左右归属', () => {
  assert.equal(slotAtSide(splitLeft, 'left'), 'secondary')
  assert.equal(slotAtSide(splitLeft, 'right'), 'primary')
  assert.equal(sessionInSlot(splitLeft, 'secondary'), 'b')
  assert.equal(sessionInSlot(splitLeft, 'primary'), 'a')
})
check('拖入新会话进入分屏,落在拖入的一侧', () => {
  assert.deepEqual(dropSessionOnSide(single, 'c', 'right'), {
    primaryId: 'a',
    split: { secondaryId: 'c', side: 'right', focus: 'secondary' },
  })
  assert.equal(dropSessionOnSide(single, 'c', 'left').split.side, 'left')
})
check('拖入自己不改动', () => {
  assert.equal(dropSessionOnSide(single, 'a', 'right'), single)
  assert.equal(dropSessionOnSide(splitRight, 'b', 'right').primaryId, 'a')
})
check('已分屏:落到哪侧替换哪侧', () => {
  const toPrimary = dropSessionOnSide(splitRight, 'c', 'left')
  assert.equal(toPrimary.primaryId, 'c')
  assert.equal(toPrimary.split.secondaryId, 'b')
  const toSecondary = dropSessionOnSide(splitRight, 'c', 'right')
  assert.equal(toSecondary.primaryId, 'a')
  assert.equal(toSecondary.split.secondaryId, 'c')
})
check('拖到对侧已有会话 → 交换两窗格', () => {
  const next = dropSessionOnSide(splitRight, 'b', 'left')
  assert.equal(next.primaryId, 'b')
  assert.equal(next.split.secondaryId, 'a')
  assert.equal(next.split.side, 'right')
  assert.equal(next.split.focus, 'primary')
})
check('拖到它已在的一侧 → 只移动焦点', () => {
  const next = dropSessionOnSide(splitRight, 'b', 'right')
  assert.equal(next.primaryId, 'a')
  assert.equal(next.split.secondaryId, 'b')
  assert.equal(next.split.focus, 'secondary')
})
check('未分屏时点击会话即切换主会话', () => {
  assert.deepEqual(openSessionInView(single, 'c'), { primaryId: 'c', split: null })
})
check('分屏时点击屏上会话只移动焦点,不改变布局', () => {
  const toPrimary = openSessionInView(splitRight, 'a')
  assert.equal(toPrimary.split.focus, 'primary')
  assert.equal(toPrimary.primaryId, 'a')
  const toSecondary = openSessionInView(splitLeft, 'b')
  assert.equal(toSecondary.split.focus, 'secondary')
  assert.equal(toSecondary.split.secondaryId, 'b')
})
check('分屏时点击新会话替换焦点窗格', () => {
  const secondaryFocus = openSessionInView(splitRight, 'c')
  assert.equal(secondaryFocus.primaryId, 'a')
  assert.equal(secondaryFocus.split.secondaryId, 'c')
  const primaryFocus = openSessionInView(splitLeft, 'c')
  assert.equal(primaryFocus.primaryId, 'c')
  assert.equal(primaryFocus.split.secondaryId, 'b')
})
check('退出分屏保留主窗格', () => {
  assert.deepEqual(exitSplit(splitRight), { primaryId: 'a', split: null })
  assert.equal(exitSplit(single), single)
})
check('会话消失时校正分屏', () => {
  assert.equal(reconcileSplit(splitRight, (id) => id === 'a').split, null)
  assert.equal(reconcileSplit(splitRight, (id) => id === 'b').split, null)
  assert.equal(reconcileSplit(splitRight, () => true), splitRight)
  assert.equal(reconcileSplit(single, () => false), single)
})
check('比例钳制与指针换算', () => {
  assert.equal(clampSplitRatio(0.1), SPLIT_MIN_RATIO)
  assert.equal(clampSplitRatio(0.9), SPLIT_MAX_RATIO)
  assert.equal(clampSplitRatio(Number.NaN), DEFAULT_SPLIT_RATIO)
  assert.equal(ratioFromPointer(300, 100, 400), 0.5)
  assert.equal(ratioFromPointer(100, 100, 0), DEFAULT_SPLIT_RATIO)
})
check('比例持久化往返', () => {
  writeSplitRatio(0.42)
  assert.equal(readSplitRatio(), 0.42)
  writeSplitRatio(2)
  assert.equal(readSplitRatio(), SPLIT_MAX_RATIO)
})
check('拖拽 MIME 与文件拖拽区分', () => {
  assert.equal(SESSION_DRAG_MIME, 'application/x-denia-session')
})
console.log('split view suites passed')
