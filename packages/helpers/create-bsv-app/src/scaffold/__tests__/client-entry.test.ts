import { jest, describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

jest.mock('../../registry', () => ({
  resolveCapabilities: (_ids: string[]) => ([{
    id: 'mock',
    roles: ['client'],
    files: () => ({ client: [{ path: 'x.ts', content: '// x' }] }),
    glue: () => ({}),
    clientEntry: () => ({ path: 'src/main.tsx', content: '// WIRED\n' }),
    npmDependencies: () => ({}),
    agentsSection: () => '## mock\n'
  }])
}))

let scaffoldNewProject: any
beforeEach(async () => { scaffoldNewProject = (await import('../new-project')).scaffoldNewProject })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-ce-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const cfg = (over: Record<string, unknown> = {}): any => ({
  mode: 'new',
  name: 'demo',
  dir: '.',
  stack: { frontend: { framework: 'react', variant: 'react-ts' } },
  bsvDir: 'src/bsv',
  capabilities: ['mock'],
  glue: true,
  packageManager: 'npm',
  network: 'test',
  ...over
})

describe('clientEntry application (new mode)', () => {
  test('overwrites the client entry (frontend-only → root)', () => {
    scaffoldNewProject(cfg(), dir, { runCommand: () => {} })
    expect(readFileSync(join(dir, 'src/main.tsx'), 'utf8')).toBe('// WIRED\n')
  })
  test('NOT applied when glue is false', () => {
    scaffoldNewProject(cfg({ glue: false }), dir, { runCommand: () => {} })
    // fake runCommand writes nothing, so main.tsx absence proves clientEntry did not write it
    expect(existsSync(join(dir, 'src/main.tsx'))).toBe(false)
  })
})
