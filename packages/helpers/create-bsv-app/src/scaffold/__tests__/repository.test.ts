import { afterEach, beforeEach, describe, expect, test } from '@jest/globals'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scaffoldRepositoryStarter } from '../repository'
import { getStarter } from '../../starters'
import type { RunCommand } from '../base-scaffolder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-repo-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('scaffoldRepositoryStarter', () => {
  test('uses a shallow, ref-pinned clone and records source provenance', () => {
    const starter = getStarter('meter')
    if (starter === undefined) throw new Error('missing starter')
    const calls: Array<{ command: string, args: string[], cwd: string }> = []
    const run: RunCommand = (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd })
      mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true })
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n')
      writeFileSync(join(dir, '.git', 'refs', 'heads', 'master'), '5434b1eb9d30fd45e220d50d117af56d8ea71b16\n')
    }
    const source = scaffoldRepositoryStarter(starter, dir, run)
    expect(calls).toEqual([{
      command: 'git',
      args: ['clone', '--depth', '1', '--branch', 'master', '--single-branch', 'https://github.com/p2ppsr/meter.git', dir],
      cwd: process.cwd()
    }])
    expect(source).toEqual({ id: 'meter', kind: 'repository', repository: 'https://github.com/p2ppsr/meter.git', ref: 'master', commit: '5434b1eb9d30fd45e220d50d117af56d8ea71b16' })
    expect(existsSync(join(dir, '.git'))).toBe(false)
  })
})
