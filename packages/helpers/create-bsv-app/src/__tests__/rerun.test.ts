import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'
import { readValidManifest } from '../config/project-manifest'
import type { ProjectManifest } from '../config/project-manifest'
import type { Selection } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-re-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('re-run add flow', () => {
  test('second run reuses the locked framework, unions capabilities, regenerates AGENTS.md', async () => {
    await run(['--dir', dir, '--name', 'demo', '--framework', 'express', '--capabilities', 'wallet-login', '--yes'])
    const first = readValidManifest(dir)
    if (first == null) throw new Error('manifest not written after first run')
    expect(first.stack.backend?.framework).toBe('express')
    expect(existsSync(join(dir, 'src/bsv/loginRoute.ts'))).toBe(true)

    // Injected provider proves: existing manifest is read, framework is reused, capabilities union.
    const provider = async ({ existing }: { existing: ProjectManifest | null }): Promise<Selection> => {
      const existingStack = existing?.stack
      let framework: 'react' | 'express' = 'express'
      if (existingStack?.frontend != null) {
        framework = 'react'
      } else if (existingStack?.backend != null) {
        framework = 'express'
      }
      return {
        appName: existing?.name ?? 'demo',
        network: existing?.network ?? 'test',
        framework,
        capabilityIds: [...(existing?.capabilities ?? []), 'wallet-login']
      }
    }
    await run(['--dir', dir], provider)

    const after = readValidManifest(dir)
    if (after == null) throw new Error('manifest not written after second run')
    expect(after.stack.backend?.framework).toBe('express')
    expect(after.capabilities).toEqual(['wallet-login'])
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('## wallet-login')
  })
})
