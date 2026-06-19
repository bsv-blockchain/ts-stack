import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../cli'
import { readManifest } from '../manifest'
import type { Manifest, Selection } from '../types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-re-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('re-run add flow', () => {
  test('second run reuses the locked framework, unions capabilities, regenerates AGENTS.md', async () => {
    await run(['--dir', dir, '--name', 'demo', '--framework', 'express', '--capabilities', 'wallet-login', '--yes'])
    const first = readManifest(dir)
    if (first == null) throw new Error('manifest not written after first run')
    expect(first.framework).toBe('express')
    expect(existsSync(join(dir, 'src/bsv/loginRoute.ts'))).toBe(true)

    // Injected provider proves: existing manifest is read, framework is reused, capabilities union.
    const provider = async ({ existing }: { existing: Manifest | null }): Promise<Selection> => ({
      appName: existing?.name ?? 'demo',
      network: existing?.network ?? 'test',
      framework: existing?.framework ?? 'express',
      capabilityIds: [...(existing?.capabilities ?? []), 'wallet-login']
    })
    await run(['--dir', dir], provider)

    const after = readManifest(dir)
    if (after == null) throw new Error('manifest not written after second run')
    expect(after.framework).toBe('express')
    expect(after.capabilities).toEqual(['wallet-login'])
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('## wallet-login')
  })
})
