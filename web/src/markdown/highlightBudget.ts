// Token spans cost much more than source text; oversized blocks stay selectable
// and copyable as plain text without constructing a second, highlighted tree.
const MAX_CODE_UNITS = 64_000
const MAX_LINES = 1_000
const MAX_LINE_UNITS = 2_000

export function withinHighlightBudget(code: string): boolean {
  if (code.length > MAX_CODE_UNITS) return false
  let lines = 1
  let lineStart = 0
  for (let index = 0; index < code.length; index++) {
    if (code.charCodeAt(index) === 10) {
      if (++lines > MAX_LINES) return false
      lineStart = index + 1
    } else if (index - lineStart >= MAX_LINE_UNITS) {
      return false
    }
  }
  return true
}
