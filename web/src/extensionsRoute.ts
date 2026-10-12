export type ExtensionTab = 'skills' | 'mcp'

export function extensionTabFromHash(hash: string): ExtensionTab | null {
  if (hash === '#extensions' || hash === '#extensions/skills') return 'skills'
  return hash === '#extensions/mcp' ? 'mcp' : null
}
