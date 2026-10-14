/**
 * 会话分屏:状态形状与路由纯逻辑。
 *
 * 分屏由两个窗格组成:主窗格(全局 activeId,侧栏高亮、URL、右侧面板都以它
 * 为准)与副窗格(secondaryId)。副窗格在主窗格左侧还是右侧由拖放落点决定
 * (side);focus 记录注意力窗格 —— 侧栏点击会话替换的是焦点窗格,而不是
 * "永远替换主窗格",否则用户在右窗格工作、点侧栏却把左窗格换掉了。
 *
 * 这一层保持纯函数:App 只把结果套到 state 上,逻辑本身可在 node 里单测
 * (见 scripts/check-split-view.mjs),不必启浏览器。
 */

export type SplitSide = 'left' | 'right'

export type PaneSlot = 'primary' | 'secondary'

export interface SplitState {
  /** 副窗格显示的会话 id。 */
  secondaryId: string
  /** 副窗格相对主窗格的位置。 */
  side: SplitSide
  /** 焦点窗格:侧栏点击的落点与窗格高亮的依据。 */
  focus: PaneSlot
}

/** 一次分屏视图的完整描述(activeId + 副窗格)。 */
export interface SplitView {
  primaryId: string | null
  split: SplitState | null
}

/** 侧栏会话行拖拽携带的 MIME(自定义类型:文件拖拽走 files,互不打扰)。 */
export const SESSION_DRAG_MIME = 'application/x-denia-session'

/** 分割比例:两侧各留 1/4 以上,不让任何一侧被拖没。 */
export const SPLIT_MIN_RATIO = 0.25
export const SPLIT_MAX_RATIO = 0.75
export const DEFAULT_SPLIT_RATIO = 0.5

/** 分割比例的持久化键(全局一份,不按会话分 —— 与面板宽度同语义)。 */
const SPLIT_RATIO_KEY = 'denia.split-ratio'

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO
  return Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio))
}

/** 从指针位置换算分割比例(0-1,相对分屏容器左边界)。 */
export function ratioFromPointer(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return DEFAULT_SPLIT_RATIO
  return clampSplitRatio((clientX - left) / width)
}

export function readSplitRatio(): number {
  try {
    const raw = window.localStorage.getItem(SPLIT_RATIO_KEY)
    if (!raw) return DEFAULT_SPLIT_RATIO
    return clampSplitRatio(Number.parseFloat(raw))
  } catch {
    return DEFAULT_SPLIT_RATIO
  }
}

export function writeSplitRatio(ratio: number): void {
  try {
    window.localStorage.setItem(SPLIT_RATIO_KEY, String(clampSplitRatio(ratio)))
  } catch {
    /* 隐私模式等存储不可用:仅失去持久化,不影响交互 */
  }
}

/** 某一侧当前是哪个窗格。未分屏时副窗格默认视作在右侧。 */
export function slotAtSide(view: SplitView, side: SplitSide): PaneSlot {
  const secondarySide = view.split?.side ?? 'right'
  return secondarySide === side ? 'secondary' : 'primary'
}

/** 窗格当前显示的会话 id。 */
export function sessionInSlot(view: SplitView, slot: PaneSlot): string | null {
  if (slot === 'primary') return view.primaryId
  return view.split?.secondaryId ?? null
}

/** 移动焦点(点击窗格时调用)。 */
export function focusSlot(view: SplitView, slot: PaneSlot): SplitView {
  if (view.split === null || view.split.focus === slot) return view
  return { ...view, split: { ...view.split, focus: slot } }
}

/**
 * 把会话放到某一侧(拖放落点)。
 *
 * - 未分屏:与主会话不同则进入分屏,副窗格出现在落点一侧;
 * - 已分屏:落到哪一侧就替换哪一侧;拖的是对侧会话则两个窗格互换;
 * - 拖的会话已在落点这一侧:只把焦点移过去。
 */
export function dropSessionOnSide(view: SplitView, id: string, side: SplitSide): SplitView {
  const primaryId = view.primaryId
  // 没有主会话时"分屏"没有意义:拖入直接成为主会话。
  if (primaryId === null) return { primaryId: id, split: null }

  if (view.split === null) {
    if (id === primaryId) return view
    return { ...view, split: { secondaryId: id, side, focus: 'secondary' } }
  }

  const target = slotAtSide(view, side)
  if (id === sessionInSlot(view, target)) {
    return focusSlot(view, target)
  }
  const otherSlot: PaneSlot = target === 'primary' ? 'secondary' : 'primary'
  if (id === sessionInSlot(view, otherSlot)) {
    // 拖到对侧的会话:两个窗格互换(副窗格停留在它原来的那一侧)。
    return {
      primaryId: view.split.secondaryId,
      split: { ...view.split, secondaryId: primaryId, focus: target },
    }
  }
  if (target === 'primary') {
    return { primaryId: id, split: { ...view.split, focus: 'primary' } }
  }
  return { ...view, split: { ...view.split, secondaryId: id, focus: 'secondary' } }
}

/**
 * 侧栏点击一个会话。
 *
 * 未分屏就是普通切换;分屏时:点击已在屏上的会话只移动焦点,其余替换
 * 焦点窗格 —— 用"当前注意力在哪"决定落点,而不是让主窗格独占所有点击。
 */
export function openSessionInView(view: SplitView, id: string): SplitView {
  const primaryId = view.primaryId
  if (view.split === null || primaryId === null) {
    return { primaryId: id, split: null }
  }
  if (id === primaryId) return focusSlot(view, 'primary')
  if (id === view.split.secondaryId) return focusSlot(view, 'secondary')
  if (view.split.focus === 'secondary') {
    return { ...view, split: { ...view.split, secondaryId: id } }
  }
  return { ...view, primaryId: id }
}

/** 退出分屏:保留主窗格会话,回到单窗格。 */
export function exitSplit(view: SplitView): SplitView {
  if (view.split === null) return view
  return { primaryId: view.primaryId, split: null }
}

/**
 * 列表变化后校正分屏:任一侧的会话不存在(被删除/被其他实例删掉)或主
 * 会话退场,就退出分屏而不是留一个指向空气的窗格。
 */
export function reconcileSplit(view: SplitView, isAlive: (id: string) => boolean): SplitView {
  if (view.split === null) return view
  const primaryId = view.primaryId
  if (primaryId === null || !isAlive(primaryId)) return { ...view, split: null }
  if (!isAlive(view.split.secondaryId)) return { ...view, split: null }
  return view
}
