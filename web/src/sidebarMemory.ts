const CHILDREN_KEY = 'denia.sidebar-collapsed-children.v1'

export function readCollapsedChildren(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(CHILDREN_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([, collapsed]) => collapsed === true))
  } catch {
    return {}
  }
}

export function writeCollapsedChildren(value: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(CHILDREN_KEY, JSON.stringify(
      Object.fromEntries(Object.entries(value).filter(([, collapsed]) => collapsed === true)),
    ))
  } catch {
    // 禁用存储或配额不足不影响本次页面内的折叠操作。
  }
}

export function restoredSidebarSession(activeId: string | null): string | null {
  if (activeId) return activeId
  try {
    const match = window.location.hash.match(/^#s=([^#]+)$/)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}
