import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/**
 * 浮层水平夹取:浮层保持原尺寸、仍然贴着锚点 chip,但整块必须落在最近的
 * `.session-layout`(会话窗格)边界内。
 *
 * 为什么需要:输入框里的三个浮层(思考强度 / 模型 / 权限)都是「锚在 chip 上
 * 水平展开固定宽度」。分屏时窗格可能只有 300-500px,展开的一侧就会伸出窗格、
 * 被 `.session-layout` 的 overflow 裁掉 —— 用户看到的是「滑块被截断」。
 * 夹取只在必要时把它向内平移最小距离,形状与视觉关联都不变。
 *
 * 返回的 style 合并到浮层元素上(left/right,极端窄时附带 maxWidth)。
 */
export function useClampedPopover({
  anchorRef,
  popoverRef,
  open,
  align,
  gap = 8,
}: {
  anchorRef: RefObject<HTMLElement | null>
  popoverRef: RefObject<HTMLElement | null>
  open: boolean
  /** 自然对齐方向:left = 与锚点左缘对齐;right = 与锚点右缘对齐。 */
  align: 'left' | 'right'
  /** 与窗格边界的净距。 */
  gap?: number
}): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({})

  useLayoutEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    const popover = popoverRef.current
    if (!anchor || !popover) return
    const bounds: HTMLElement = anchor.closest('.session-layout') ?? document.documentElement

    const measure = () => {
      // 手机上浮层是贴底抽屉(fixed 全宽,见 responsive.css 的 820 段),
      // 不参与夹取 —— 否则 inline left 会把抽屉从底部拉成定宽块。
      if (
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 820px)').matches
      ) {
        setStyle((prev) => (Object.keys(prev).length === 0 ? prev : {}))
        return
      }
      const a = anchor.getBoundingClientRect()
      const b = bounds.getBoundingClientRect()
      const width = popover.offsetWidth
      // 浮层左缘在视口坐标里允许的区间。
      const min = b.left + gap
      const max = b.right - gap - width
      const natural = align === 'right' ? a.right - width : a.left
      // 窗格比浮层还窄(极端):贴左,并把宽度收缩到边界内。
      const tooNarrow = max < min
      const left = tooNarrow ? min : Math.min(Math.max(natural, min), max)
      const next: CSSProperties = {
        left: `${Math.round(left - a.left)}px`,
        right: 'auto',
        maxWidth: tooNarrow ? `${Math.max(0, b.width - gap * 2)}px` : undefined,
      }
      setStyle((prev) =>
        prev.left === next.left && prev.maxWidth === next.maxWidth ? prev : next,
      )
    }

    measure()
    window.addEventListener('resize', measure)
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(bounds)
      // 浮层自身宽度变化(内容/字体变化)也要重算。
      observer.observe(popover)
    }
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [open, align, gap, anchorRef, popoverRef])

  return style
}
