import { afterEach, beforeEach, expect, test } from '@jest/globals'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRootRunner } from '../root-runner'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-runner-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('writes one-command dev/build/install scripts for both apps', () => {
  expect(writeRootRunner('demo', dir, 'pnpm')).toEqual(['package.json', 'scripts/run-apps.mjs'])
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  expect(pkg).toMatchObject({ private: true, scripts: { dev: expect.any(String), build: expect.any(String), 'install:apps': expect.any(String) } })
  const runner = readFileSync(join(dir, 'scripts/run-apps.mjs'), 'utf8')
  expect(runner).toContain('const packageManager = "pnpm"')
  expect(runner).toContain("const apps = ['client', 'server']")
})
