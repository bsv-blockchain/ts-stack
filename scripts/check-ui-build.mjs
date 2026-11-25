import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve(process.argv[2] ?? 'dist')
const html = await readFile(path.join(output, 'index.html'), 'utf8')
const scripts = Array.from(
  html.matchAll(/<script\s[^>]*\bsrc="([^"]+)"/g),
  match => match[1]
).filter(source => !/^(?:[a-z]+:|\/\/)/i.test(source))

assert.ok(scripts.length > 0, 'The application must reference a bundled entry script')
for (const source of scripts) {
  const pathname = new URL(source, 'https://ui-build.invalid/').pathname
  const file = path.join(output, pathname)
  assert.ok(file.startsWith(output + path.sep), 'The script must resolve inside the build')
  assert.ok((await stat(file)).size > 0, `Missing bundled script ${source}`)
}
