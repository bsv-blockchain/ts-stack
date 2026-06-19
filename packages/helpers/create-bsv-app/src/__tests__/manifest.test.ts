// src/__tests__/manifest.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, manifestFromSelection, mergeCapabilityIds, remainingCapabilityIds } from '../manifest'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-m-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('manifest', () => {
  test('round-trips through disk and preserves framework', () => {
    const m = manifestFromSelection({ appName: 'demo', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
    writeManifest(dir, m)
    expect(readManifest(dir)).toEqual(m)
    expect(readManifest(dir)?.framework).toBe('react')
  })

  test('readManifest returns null when absent', () => {
    expect(readManifest(dir)).toBeNull()
  })

  test('mergeCapabilityIds unions without duplicates, order-stable', () => {
    expect(mergeCapabilityIds(['wallet-login'], ['wallet-login', 'x'])).toEqual(['wallet-login', 'x'])
  })

  test('remainingCapabilityIds excludes installed capabilities', () => {
    const m = manifestFromSelection({ appName: 'demo', network: 'test', framework: 'express', capabilityIds: ['wallet-login'] })
    expect(remainingCapabilityIds(m)).not.toContain('wallet-login')
  })
})
