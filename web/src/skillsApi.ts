import { ApiError, type SkillSummary } from './api'

export interface ManagedSkill extends SkillSummary {
  path: string
  resourceBase: string
  enabled: boolean
  editable: boolean
}

export type SkillScope = 'user' | 'project'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      let code = `http-${response.status}`
      let message = response.statusText || `请求失败（${response.status}）`
      try {
        const body = await response.json()
        code = body?.error?.code ?? code
        message = body?.error?.message ?? message
      } catch { /* 非 JSON 错误保留 HTTP 状态。 */ }
      throw new ApiError(code, message, response.status)
    }
    if (!response.headers.get('content-type')?.includes('application/json')) {
      throw new Error('当前服务尚未提供技能管理接口，请更新并重启服务。')
    }
    return await response.json() as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('请求超时，请稍后重试。')
    }
    if (error instanceof TypeError) throw new Error('无法连接服务，请检查连接后重试。')
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}

function query(cwd?: string): string {
  return cwd ? `?${new URLSearchParams({ cwd })}` : ''
}

export function listManagedSkills(cwd?: string) {
  return request<{ skills: ManagedSkill[]; directory: string }>(`/api/skills${query(cwd)}`)
}

export function getSkill(name: string, cwd?: string) {
  return request<{ skill: ManagedSkill; body: string; raw: string }>(`/api/skills/${encodeURIComponent(name)}${query(cwd)}`)
}

export function saveSkill(name: string, content: string, options: { cwd?: string; create?: boolean; scope?: SkillScope }) {
  return request<{ skill: ManagedSkill }>(`/api/skills/${encodeURIComponent(name)}`, {
    method: 'PUT', body: JSON.stringify({ ...options, content }),
  })
}

export function setSkillEnabled(name: string, enabled: boolean, cwd?: string) {
  return request<{ skill: ManagedSkill }>(`/api/skills/${encodeURIComponent(name)}/enabled`, {
    method: 'POST', body: JSON.stringify({ cwd, enabled }),
  })
}

export function deleteSkill(name: string, cwd?: string) {
  return request<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}${query(cwd)}`, { method: 'DELETE' })
}

export function importSkills(path: string, scope: SkillScope, cwd?: string) {
  return request<{ skills: ManagedSkill[] }>('/api/skills/import', {
    method: 'POST', body: JSON.stringify({ cwd, path, scope }),
  })
}
