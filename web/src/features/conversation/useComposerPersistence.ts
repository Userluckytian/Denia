import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { loadComposer, readComposerText, saveComposer, type ComposerSnapshot } from '../../composerMemory'

interface Options {
  scope: string | null
  snapshot: ComposerSnapshot
  restore: (snapshot: ComposerSnapshot) => void
  onError: (message: string) => void
}

interface Session {
  scope: string
  snapshot: ComposerSnapshot
  baseline: ComposerSnapshot
  ready: boolean
  loaded: boolean
  dirty: boolean
  cancelled: boolean
  restoring: boolean
  loading: Promise<void>
}

function sameSnapshot(a: ComposerSnapshot, b: ComposerSnapshot) {
  return a.text === b.text
    && sameItems(a.images, b.images)
    && sameItems(a.attachments, b.attachments)
    && sameItems(a.quotes, b.quotes)
    && sameItems(a.queue, b.queue)
}

function sameItems<T>(a: T[], b: T[]) {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]))
}

function emptySnapshot(): ComposerSnapshot {
  return { text: '', images: [], attachments: [], quotes: [], queue: [] }
}

export function useComposerPersistence({ scope, snapshot, restore, onError }: Options) {
  const callbacks = useRef({ restore, onError })
  const sessionRef = useRef<Session | null>(null)
  const writes = useRef<Promise<void>>(Promise.resolve())
  const errorReported = useRef(false)
  const [readySession, setReadySession] = useState<Session | null>(null)

  useLayoutEffect(() => {
    callbacks.current = { restore, onError }
  })

  const reportError = useCallback(() => {
    if (errorReported.current) return
    errorReported.current = true
    callbacks.current.onError('输入内容的本地存储不可用，刷新或关闭页面可能丢失草稿和待发送消息。')
  }, [])

  const persist = useCallback((session: Session) => {
    if (!session.loaded && !session.dirty) return writes.current
    const saved = session.snapshot
    const pending = saveComposer(session.scope, saved).catch(reportError)
    writes.current = pending
    return pending
  }, [reportError])

  useLayoutEffect(() => {
    if (scope === null) {
      sessionRef.current = null
      setReadySession(null)
      callbacks.current.restore(emptySnapshot())
      return
    }
    const session: Session = {
      scope,
      snapshot,
      baseline: snapshot,
      ready: false,
      loaded: false,
      dirty: false,
      cancelled: false,
      restoring: false,
      loading: Promise.resolve(),
    }
    sessionRef.current = session
    session.loading = (async () => {
      await writes.current
      if (session.cancelled) return
      let loaded: ComposerSnapshot
      try {
        loaded = await loadComposer(scope)
        if (session.cancelled) return
        session.loaded = true
      } catch {
        reportError()
        // 存储不可读时继续允许编辑，但不能带入上个 scope 的内容。
        loaded = emptySnapshot()
        try {
          loaded.text = readComposerText(scope) ?? ''
        } catch {
          reportError()
        }
      }
      if (session.cancelled) return
      if (!session.dirty) {
        session.snapshot = loaded
        session.restoring = true
        callbacks.current.restore(loaded)
      }
      session.ready = true
      setReadySession(session)
      if (session.dirty) void persist(session)
    })()

    return () => {
      session.cancelled = true
      void persist(session)
    }
    // snapshot 的变化由下一个 effect 处理，不能重新启动加载。
  }, [scope, persist, reportError])

  useLayoutEffect(() => {
    const session = sessionRef.current
    if (!session || session.scope !== scope) return
    if (session.restoring) {
      if (sameSnapshot(snapshot, session.snapshot)) {
        session.restoring = false
        session.baseline = snapshot
        return
      }
      // restore 的状态尚未提交时，props 仍是旧 scope 或初始化的快照。
      if (sameSnapshot(snapshot, session.baseline)) return
      session.restoring = false
    }
    if (sameSnapshot(snapshot, session.snapshot)) return
    session.snapshot = snapshot
    session.dirty = true
    if (session.ready) void persist(session)
  }, [scope, snapshot, persist])

  const flush = useCallback(async () => {
    const session = sessionRef.current
    if (!session) return
    await session.loading
    await persist(session)
  }, [persist])

  useLayoutEffect(() => {
    const onPageHide = () => {
      const session = sessionRef.current
      if (session) void persist(session)
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [persist])

  return {
    ready: scope === null || (readySession !== null && readySession === sessionRef.current && readySession.scope === scope),
    flush,
  }
}
