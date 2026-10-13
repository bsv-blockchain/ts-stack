import { describe, expect, test } from '@jest/globals'
import { registry, resolveCapabilities } from '../registry'
import type { Role } from '../types'

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

describe('registry consistency', () => {
  test('ids are unique', () => {
    const ids = registry.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  test('every requires resolves', () => {
    for (const c of registry) {
      for (const r of c.requires ?? []) {
        expect(registry.some(x => x.id === r)).toBe(true)
      }
    }
    expect(() => resolveCapabilities(registry.map(c => c.id))).not.toThrow()
  })
  test('roles cover the keys each capability emits', () => {
    for (const c of registry) {
      const keys = new Set<string>([
        ...Object.keys(c.files(ctx)),
        ...Object.keys(c.glue?.(ctx) ?? {}),
        ...Object.keys(c.npmDependencies(ctx))
      ])
      for (const k of keys) {
        expect(c.roles).toContain(k as Role)
      }
    }
  })
  test('generated files import exactly the sibling helpers they use', () => {
    const files = generatedFiles()
    const exported = new Set(
      files.flatMap(f =>
        [...f.content.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1])
      )
    )
    for (const f of files) {
      const imported = [
        ...f.content.matchAll(/^import \{([^}]+)\} from '\.\/[\w.]+\.js'/gm)
      ].flatMap(m => m[1].split(',').map(s => s.trim().replace(/^type /, '')))
      for (const name of imported) {
        const uses = f.content.match(new RegExp(`\\b${name}\\b`, 'g'))?.length ?? 0
        expect({ file: f.path, name, used: uses > 1 }).toEqual({ file: f.path, name, used: true })
      }
      for (const name of exported) {
        if (!new RegExp(`\\b${name}\\(`).test(f.content)) continue
        const available =
          new RegExp(`function ${name}\\b`).test(f.content) || imported.includes(name)
        expect({ file: f.path, name, available }).toEqual({ file: f.path, name, available: true })
      }
    }
  })
  test('generated files contain no explicit any', () => {
    for (const f of generatedFiles()) {
      expect({ file: f.path, any: /:\s*any\b|<any>|as any\b/.test(f.content) }).toEqual({
        file: f.path,
        any: false
      })
    }
  })
})

function generatedFiles() {
  return registry.flatMap(c => [
    ...Object.values(c.files(ctx)).flat(),
    ...Object.values(c.glue?.(ctx) ?? {}).flat()
  ])
}
