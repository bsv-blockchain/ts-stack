// src/scaffold/__tests__/workspace.test.ts
import { describe, expect, test } from '@jest/globals'
import { workspaceFiles } from '../workspace'

describe('workspaceFiles', () => {
  test('npm: single package.json with workspaces', () => {
    const files = workspaceFiles('demo', 'npm')
    expect(files.map(f => f.path)).toEqual(['package.json'])
    const pkg = JSON.parse(files[0].content)
    expect(pkg).toEqual({ name: 'demo', private: true, workspaces: ['client', 'server'] })
  })
  test('pnpm: package.json + pnpm-workspace.yaml listing client/server', () => {
    const files = workspaceFiles('demo', 'pnpm')
    expect(files.map(f => f.path).sort()).toEqual(['package.json', 'pnpm-workspace.yaml'])
    const wsFile = files.find(f => f.path === 'pnpm-workspace.yaml')
    expect(wsFile).toBeDefined()
    const ws = wsFile?.content ?? ''
    expect(ws).toContain('client')
    expect(ws).toContain('server')
    const pkgFile = files.find(f => f.path === 'package.json')
    expect(pkgFile).toBeDefined()
    const pkg = JSON.parse(pkgFile?.content ?? '{}')
    expect(pkg).toEqual({ name: 'demo', private: true })
  })
})
