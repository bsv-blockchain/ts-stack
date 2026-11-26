import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const requestedOutput = process.argv[2] ?? 'dist'
assert.ok(
  requestedOutput === 'build' || requestedOutput === 'dist',
  'Expected build or dist output'
)
const output = path.resolve(requestedOutput === 'build' ? 'build' : 'dist')
const html = await readFile(path.join(output, 'index.html'), 'utf8')
const scripts = Array.from(
  html.matchAll(/<script\s[^>]*\bsrc="([^"]+)"/g),
  match => match[1]
).filter(source => !/^(?:[a-z]+:|\/\/)/i.test(source))

assert.ok(scripts.length > 0, 'The application must reference a bundled entry script')
await Promise.all(
  scripts.map(async source => {
    const pathname = new URL(source, 'https://ui-build.invalid/').pathname
    const file = path.join(output, pathname)
    assert.ok(file.startsWith(output + path.sep), 'The script must resolve inside the build')
    const info = await stat(file)
    assert.ok(info.isFile() && info.size > 0, `Missing bundled script ${source}`)
  })
)
