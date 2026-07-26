import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ProjectConfig } from '../../config/model'
import type { RunCommand } from '../base-scaffolder'
import { installProject } from '../install'

let targetDir: string

beforeEach(() => {
  targetDir = mkdtempSync(join(tmpdir(), 'create-bsv-app-install-'))
})

afterEach(() => {
  rmSync(targetDir, { recursive: true, force: true })
})

function config(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    mode: 'new',
    name: 'demo',
    dir: targetDir,
    starter: 'custom',
    stack: {},
    targets: {},
    bsvDir: 'src/bsv',
    capabilities: [],
    glue: false,
    install: true,
    packageManager: 'npm',
    network: 'test',
    ...overrides
  }
}

function packageDirectory(relativePath = ''): string {
  const directory = join(targetDir, relativePath)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{}')
  return directory
}

test.each([
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm']
] as const)('uses the package manager selected by %s', (lockfile, expectedManager) => {
  const directory = packageDirectory('client')
  writeFileSync(join(directory, lockfile), '')
  const calls: Array<{ command: string; cwd?: string }> = []
  const runCommand: RunCommand = (command, _arguments, options) => {
    calls.push({ command, cwd: options?.cwd })
  }

  expect(
    installProject(
      config({
        packageManager: expectedManager === 'npm' ? 'yarn' : 'npm',
        targets: { client: 'client' }
      }),
      targetDir,
      runCommand
    )
  ).toEqual([directory])
  expect(calls).toEqual([{ command: expectedManager, cwd: directory }])
})

describe('candidate selection', () => {
  test('uses the configured manager for a root package without a lockfile', () => {
    packageDirectory()
    const calls: string[] = []

    expect(
      installProject(config({ packageManager: 'yarn' }), targetDir, command => {
        calls.push(command)
      })
    ).toEqual([targetDir])
    expect(calls).toEqual(['yarn'])
  })

  test('deduplicates root targets and includes repository starter roots', () => {
    packageDirectory()
    const calls: string[] = []

    expect(
      installProject(
        config({
          starter: 'brc102-frontend',
          targets: { client: '' }
        }),
        targetDir,
        command => {
          calls.push(command)
        }
      )
    ).toEqual([targetDir])
    expect(calls).toEqual(['npm'])
  })

  test('does nothing when installation is disabled', () => {
    expect(
      installProject(config({ install: false }), targetDir, () => {
        throw new Error('runCommand must not be called')
      })
    ).toEqual([])
  })
})
