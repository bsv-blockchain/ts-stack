/**
 * Ruling 11: the root entry runs in browsers and React Native, so nothing under `src/` may
 * use Node: no `node:*` or other Node builtin module, no `ws` or `node-datachannel` (those
 * belong to `server/` and the tests), no `Buffer`, no `process`. Its only package import
 * is the `@bsv/sdk` peer dependency, and a relative import must stay inside `src/` (so
 * nothing reaches `server/` that way).
 */
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** Packages the root entry may import: its peer dependency. */
const ALLOWED_PACKAGES = ['@bsv/sdk']
/** Node-only packages of this repository. */
const NODE_PACKAGES = ['ws', 'node-datachannel']

/** Specifiers in `import … from`, `export … from`, `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"\n]+)\1/g

/** Every way `source`, the TypeScript text of `file`, depends on Node, one message each. */
function nodeDependencies(source: string, file: string): string[] {
  const problems: string[] = []
  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    const bare = specifier.split('/')[0]
    const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : bare
    if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
      problems.push(`imports the Node builtin '${specifier}'`)
    } else if (NODE_PACKAGES.includes(pkg)) {
      problems.push(`imports the Node-only package '${specifier}'`)
    } else if (specifier.startsWith('.')) {
      const path = relative(SRC, resolve(dirname(file), specifier))
      if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
        problems.push(`imports '${specifier}', which is outside src/`)
      }
    } else if (!ALLOWED_PACKAGES.includes(pkg)) {
      problems.push(`imports '${specifier}', which is not a dependency of the root entry`)
    }
  }
  if (/\bBuffer\b/.test(source)) problems.push('uses Buffer')
  if (/\bprocess\.[A-Za-z_$]/.test(source)) problems.push('uses process')
  return problems
}

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return typeScriptFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('browser safety of src/ (Ruling 11)', () => {
  it('flags Node builtins, Node-only packages, Buffer, process and unknown packages', () => {
    const file = join(SRC, 'client', 'Sample.ts')
    const check = (source: string): string[] => nodeDependencies(source, file)
    expect(check("import { readFileSync } from 'node:fs'")).toEqual([
      "imports the Node builtin 'node:fs'"
    ])
    expect(check("import { randomBytes } from 'crypto'")).toEqual([
      "imports the Node builtin 'crypto'"
    ])
    expect(check("const p = await import('fs/promises')")).toEqual([
      "imports the Node builtin 'fs/promises'"
    ])
    expect(check("import WebSocket from 'ws'")).toEqual(["imports the Node-only package 'ws'"])
    expect(check("export * from 'node-datachannel/polyfill'")).toEqual([
      "imports the Node-only package 'node-datachannel/polyfill'"
    ])
    expect(check("const qr = require('qrcode')")).toEqual([
      "imports 'qrcode', which is not a dependency of the root entry"
    ])
    expect(check('const b = Buffer.from(bytes)')).toEqual(['uses Buffer'])
    expect(check('if (process.env.DEBUG) log()')).toEqual(['uses process'])
    expect(
      check(
        [
          "import { PublicKey } from '@bsv/sdk'",
          "import type { WalletProtocol } from '@bsv/sdk'",
          "export * from './codec/codes.js'",
          "import { toHex } from '../util/bytes.js'",
          "import { VERSION } from '../index.js'",
          'const view = new Uint8Array(new ArrayBuffer(8))',
          '// one step in the process. Then the next'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('flags relative imports that leave src/, such as server code', () => {
    expect(
      nodeDependencies(
        [
          "import { createRelayServer } from '../../server/relay.js'",
          "import type { RelayLimits } from '../../server/index.js'",
          "const pkg = await import('../../package.json')",
          "export * from '../..'"
        ].join('\n'),
        join(SRC, 'client', 'Sample.ts')
      )
    ).toEqual([
      "imports '../../server/relay.js', which is outside src/",
      "imports '../../server/index.js', which is outside src/",
      "imports '../../package.json', which is outside src/",
      "imports '../..', which is outside src/"
    ])
    expect(nodeDependencies("export * from '../server/index.js'", join(SRC, 'index.ts'))).toEqual([
      "imports '../server/index.js', which is outside src/"
    ])
    // a file named like a parent directory is still inside
    expect(nodeDependencies("import x from './..x.js'", join(SRC, 'index.ts'))).toEqual([])
  })

  it('finds none of them in any file under src/', () => {
    const files = typeScriptFiles(SRC)
    expect(files.length).toBeGreaterThan(20)
    const problems = files.flatMap(file =>
      nodeDependencies(readFileSync(file, 'utf8'), file).map(p => `${relative(ROOT, file)} ${p}`)
    )
    expect(problems).toEqual([])
  })
})
