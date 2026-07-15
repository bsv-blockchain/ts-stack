import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectExistingProject } from '../detect'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-detect-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writePackage (relative: string, pkg: object): void {
  const target = join(dir, relative)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), JSON.stringify(pkg))
}

describe('detectExistingProject', () => {
  test('detects a root React package for add mode', () => {
    writePackage('', { name: 'react-app', dependencies: { react: '^19.0.0' } })
    expect(detectExistingProject(dir)).toMatchObject({
      name: 'react-app',
      stack: { frontend: { framework: 'react' } },
      targets: { client: '' }
    })
  })

  test('detects legacy frontend/backend package directories', () => {
    writePackage('frontend', { dependencies: { react: '^19.0.0' } })
    writePackage('backend', { dependencies: { express: '^5.0.0' } })
    expect(detectExistingProject(dir)).toMatchObject({
      stack: { frontend: { framework: 'react' }, backend: { framework: 'express' } },
      targets: { client: 'frontend', server: 'backend' }
    })
  })

  test('rejects an ambiguous root package containing both app roles', () => {
    writePackage('', { dependencies: { react: '^19.0.0', express: '^5.0.0' } })
    expect(() => detectExistingProject(dir)).toThrow(/cannot infer separate client\/server targets/i)
  })
})
