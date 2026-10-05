import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

/** Check the real installed watcher against an immutable published oracle.
 * The ordinary inputs include negative arrays, brace alternatives, extglobs,
 * dot files, separators and every watcher file type. No advisory payloads. */
export function assertMetroWatcherContract(metroPackagePath) {
  const metroRequire = createRequire(metroPackagePath)
  const commonPath = path.join(
    path.dirname(metroRequire.resolve('metro-file-map/package.json')),
    'src/watchers/common.js'
  )
  const watcherRequire = createRequire(commonPath)
  const common = watcherRequire(commonPath)
  const fixture = JSON.parse(
    fs.readFileSync(new URL('./fixtures/metro-watcher-contract.json', import.meta.url), 'utf8')
  )
  let checked = 0
  for (const { type, dot, globs, expected } of fixture.cases) {
    for (const [index, file] of fixture.files.entries()) {
      assert.equal(
        common.includedByGlob(type, globs, dot, file),
        expected[index],
        `Metro watcher compatibility: ${JSON.stringify({ type, dot, globs, file })}`
      )
      checked++
    }
  }
  assert.equal(checked, 1120)
  for (const [name, value] of Object.entries({
    DELETE_EVENT: 'delete',
    TOUCH_EVENT: 'touch',
    RECRAWL_EVENT: 'recrawl',
    ALL_EVENT: 'all'
  }))
    assert.equal(common[name], value)
  for (const [kind, expected] of [
    ['isSymbolicLink', 'l'],
    ['isDirectory', 'd'],
    ['isFile', 'f']
  ]) {
    const stat = Object.fromEntries(
      ['isSymbolicLink', 'isDirectory', 'isFile'].map(method => [method, () => method === kind])
    )
    assert.equal(common.typeFromStat(stat), expected)
  }
  for (const file of ['a/b.ts', String.raw`a\b.ts`]) {
    assert.equal(common.posixPathMatchesPattern(/\.ts$/, file), true)
    assert.equal(common.posixPathMatchesPattern(/\.js$/, file), false)
  }
  assert.equal(common.posixPathMatchesPattern(/^a\/b\.ts$/, path.join('a', 'b.ts')), true)
  assert.equal(watcherRequire('picomatch/package.json').version, '2.3.2')
  for (const name of ['micromatch', 'braces']) {
    assert.throws(() => watcherRequire.resolve(name), { code: 'MODULE_NOT_FOUND' })
  }
  return { publishedOracle: fixture.oracle, watcherCases: checked, removedDependencyClosure: true }
}
