// src/scaffold/__tests__/express-skeleton.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expressSkeletonScaffolder, scaffolderFor, viteScaffolder } from '../base-scaffolder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-exp-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('expressSkeletonScaffolder', () => {
  test('writes a runnable express-ts skeleton', () => {
    expressSkeletonScaffolder.scaffold({ kind: 'backend', target: { framework: 'express' } }, dir, { packageManager: 'npm', runCommand: () => { throw new Error('should not run a command') } })
    expect(existsSync(join(dir, 'src/index.ts'))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toHaveProperty('express')
    expect(readFileSync(join(dir, 'src/index.ts'), 'utf8')).toContain("from 'express'")
    expect(existsSync(join(dir, 'tsconfig.json'))).toBe(true)
  })
})

describe('scaffolderFor', () => {
  test('selects vite for react and the skeleton for express', () => {
    expect(scaffolderFor('react')).toBe(viteScaffolder)
    expect(scaffolderFor('express')).toBe(expressSkeletonScaffolder)
  })
})
