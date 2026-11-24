import { describe, expect, test } from '@jest/globals'
import { registry, resolveCapabilities } from '../registry'
import type { Role } from '../types'
import { EXPLICIT_ANY } from './helpers/explicit-any'
import * as versions from '../capabilities/versions'
import { OWNED_PACKAGES } from '../capabilities/versions'

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
        const id = typeof r === 'string' ? r : r.id
        expect(registry.some(x => x.id === id)).toBe(true)
        // a requirement scoped to a role the capability never emits would never apply
        if (typeof r !== 'string') expect(c.roles).toContain(r.role)
      }
    }
    for (const layout of ['frontend-only', 'backend-only', 'monorepo'] as const)
      expect(() =>
        resolveCapabilities(
          registry.map(c => c.id),
          { layout }
        )
      ).not.toThrow()
  })
  test('every @bsv package a capability depends on is owned, with its range from versions.ts', () => {
    const ranges = new Set<unknown>(Object.values(versions).filter(v => typeof v === 'string'))
    for (const c of registry) {
      for (const deps of Object.values(c.npmDependencies(ctx))) {
        for (const [name, range] of Object.entries(deps ?? {})) {
          if (!name.startsWith('@bsv/')) continue
          expect(OWNED_PACKAGES.has(name)).toBe(true)
          expect(ranges.has(range)).toBe(true)
        }
      }
    }
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
  test.each([
    'const x: any[] = []',
    'Array<any>',
    'Promise<any>',
    'Record<string, any>',
    'v as any',
    'type X = any',
    'function f<T extends any>() {}'
  ])('the explicit-any check catches %j', code => {
    expect(EXPLICIT_ANY.test(code)).toBe(true)
  })
  test('generated files contain no explicit any', () => {
    for (const f of generatedFiles()) {
      expect({
        file: f.path,
        any: EXPLICIT_ANY.test(f.content)
      }).toEqual({
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
