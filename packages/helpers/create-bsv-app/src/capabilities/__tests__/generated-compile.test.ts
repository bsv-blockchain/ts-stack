import { afterAll, beforeAll, describe, expect, test } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { txCore } from '../tx-core'

const ctx = {
  name: 'd',
  network: 'test' as const,
  bsvDir: 'src/bsv',
  stack: {
    frontend: { framework: 'react' as const, variant: 'react-ts' },
    backend: { framework: 'express' as const }
  },
  layout: 'monorepo' as const
}

// Temp dir lives under the package so node resolution finds @bsv/* in node_modules.
const pkgDir = resolve(__dirname, '../../..')
let root: string
let files: Record<string, string>

beforeAll(() => {
  root = mkdtempSync(join(pkgDir, '.tmp-compile-'))
  files = {}
  for (const spec of txCore.files(ctx).shared ?? []) {
    files[spec.path.split('/').pop() as string] = spec.content
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function check(dir: string, sources: Record<string, string>): string[] {
  mkdirSync(dir, { recursive: true })
  const paths = Object.entries(sources).map(([name, content]) => {
    const p = join(dir, name)
    writeFileSync(p, content)
    return p
  })
  const program = ts.createProgram(paths, {
    strict: true,
    noEmit: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    skipLibCheck: true,
    types: []
  })
  return ts.getPreEmitDiagnostics(program).map(d => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    const pos =
      d.file && d.start !== undefined
        ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
        : ''
    return pos + msg
  })
}

describe('emitted tx-core helpers compile', () => {
  test('type-check cleanly under strict TypeScript', () => {
    expect(Object.keys(files).sort()).toEqual(['transactions.ts', 'txUtils.ts'])
    expect(check(join(root, 'clean'), files)).toEqual([])
  })

  test('the check fails on an unknown SDK export', () => {
    const bad = {
      ...files,
      'txUtils.ts':
        `import { completeBoundActionX } from '@bsv/sdk'\nexport const _x = completeBoundActionX\n` +
        files['txUtils.ts']
    }
    const diags = check(join(root, 'bad'), bad)
    expect(diags.length).toBeGreaterThanOrEqual(1)
    expect(diags.some(d => d.includes('completeBoundActionX'))).toBe(true)
  })
})
