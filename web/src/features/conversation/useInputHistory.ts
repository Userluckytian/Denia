import { useCallback, useEffect, useMemo } from 'react'
import * as api from '../../api'
import type { SessionEnvelope } from '../../generated/core'

type Direction = 'up' | 'down'
type HistoryPage = Pick<api.SessionPageResponse, 'events' | 'hasMoreBefore'>
type PageLoader = (
  sessionId: string,
  options: { limit: number; before?: number },
  signal: AbortSignal,
) => Promise<HistoryPage>

const HISTORY_LIMIT = 50
const PAGE_LIMIT = 100
const MAX_PAGES = 5

export function collectInputHistory(events: readonly SessionEnvelope[]): string[] {
  const history: string[] = []
  for (const event of events) {
    if (event.type !== 'user-message' || event.injected || !event.text.trim()) continue
    if (history.at(-1) !== event.text) history.push(event.text)
  }
  return history.slice(-HISTORY_LIMIT)
}

export class InputHistory {
  private entries: string[] = []
  private index: number | null = null
  private draft = ''
  private generation = 0
  private controller: AbortController | null = null

  constructor(
    private readonly sessionId: string | null | undefined,
    private readonly loadPage: PageLoader = api.getSessionPage,
  ) {}

  resetBrowse(): void {
    this.index = null
    this.draft = ''
  }

  clear(): void {
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.entries = []
    this.resetBrowse()
  }

  navigate(direction: Direction, current: string): string | null {
    if (!this.entries.length) return null
    if (direction === 'up') {
      if (this.index === null) {
        this.draft = current
        this.index = this.entries.length - 1
      } else if (this.index > 0) {
        this.index--
      } else {
        return null
      }
      return this.entries[this.index]
    }
    if (this.index === null) return null
    if (this.index < this.entries.length - 1) {
      this.index++
      return this.entries[this.index]
    }
    const draft = this.draft
    this.resetBrowse()
    return draft
  }

  async refresh(): Promise<boolean> {
    // 回退后旧快照不再可信,请求期间也不能浏览已删除的消息。
    this.clear()
    if (!this.sessionId) return true
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    let events: SessionEnvelope[] = []
    let before: number | undefined
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await this.loadPage(this.sessionId, { limit: PAGE_LIMIT, before }, controller.signal)
        if (generation !== this.generation || controller.signal.aborted) return false
        if (data.events.length === 0) break
        events = [...data.events, ...events]
        if (collectInputHistory(events).length >= HISTORY_LIMIT || !data.hasMoreBefore) break
        const oldest = data.events[0].seq
        if (before !== undefined && oldest >= before) break
        before = oldest
      }
      this.entries = collectInputHistory(events)
      return true
    } catch {
      return false
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}

export function useInputHistory({ sessionId }: { sessionId: string | null | undefined }) {
  const history = useMemo(() => new InputHistory(sessionId), [sessionId])
  const refresh = useCallback(() => history.refresh(), [history])
  const resetBrowse = useCallback(() => history.resetBrowse(), [history])
  const navigate = useCallback((direction: Direction, current: string) => (
    history.navigate(direction, current)
  ), [history])

  useEffect(() => {
    void history.refresh()
    return () => history.clear()
  }, [history])

  return { navigate, resetBrowse, refresh }
}
