import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../../.github/workflows/desktop-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const trigger = text.split('\non:\n')[1]?.split('\npermissions:')[0]
assert.ok(trigger)
assert.deepEqual([...trigger.matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]), ['workflow_dispatch'])
assert.ok(text.indexOf('pnpm --dir web build') < text.indexOf('cargo build --locked'))
assert.ok(text.includes('--target x86_64-pc-windows-msvc'))
assert.ok(text.includes('target/x86_64-pc-windows-msvc/release/denia-desktop.exe'))
assert.ok(text.includes('--frozen-lockfile'))
assert.ok(text.includes("'--target', $env:GITHUB_SHA"))
assert.ok(text.includes('needs: windows'))
assert.ok(text.includes('contents: write'))
assert.ok(text.includes('SHA256SUMS.txt'))
assert.ok(!text.includes('--clobber'))
assert.ok(!text.includes('${{ inputs.tag }}', text.indexOf('run: |')), 'Tag must be passed through environment, not shell interpolation')
console.log('PASS manual desktop release trigger, locked builds, artifact paths and safe publication contract')
