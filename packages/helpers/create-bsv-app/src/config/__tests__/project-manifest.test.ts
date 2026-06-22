// src/config/__tests__/project-manifest.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestFromConfig, readProjectManifest, writeProjectManifest, mergeCapabilityIds, remainingCapabilityIds, readValidManifest } from '../project-manifest'
import type { ProjectConfig } from '../model'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-m-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const config: ProjectConfig = {
  mode: 'new',
  name: 'demo',
  dir: '.',
  stack: { frontend: { framework: 'react', variant: 'react-ts' }, backend: { framework: 'express' } },
  bsvDir: 'src/bsv',
  capabilities: ['wallet-login'],
  glue: false,
  packageManager: 'npm',
  network: 'test'
}

describe('project manifest', () => {
  test('manifestFromConfig keeps stack/name/network/bsvDir/capabilities and sets version 1', () => {
    expect(manifestFromConfig(config)).toEqual({ version: 1, name: 'demo', network: 'test', stack: config.stack, bsvDir: 'src/bsv', capabilities: ['wallet-login'] })
  })

  test('round-trips through disk', () => {
    const m = manifestFromConfig(config)
    writeProjectManifest(dir, m)
    expect(readProjectManifest(dir)).toEqual(m)
  })

  test('readProjectManifest returns null when absent', () => {
    expect(readProjectManifest(dir)).toBeNull()
  })
})

describe('manifest ops', () => {
  test('mergeCapabilityIds unions without duplicates, order-stable', () => {
    expect(mergeCapabilityIds(['a'], ['a', 'b'])).toEqual(['a', 'b'])
  })

  test('mergeCapabilityIds with empty existing returns added', () => {
    expect(mergeCapabilityIds([], ['wallet-login'])).toEqual(['wallet-login'])
  })

  test('remainingCapabilityIds excludes capabilities already in manifest', () => {
    const m = manifestFromConfig(config)
    expect(remainingCapabilityIds(m, ['wallet-login', 'x'])).toEqual(['x'])
  })

  test('remainingCapabilityIds returns all when none installed', () => {
    const empty = manifestFromConfig({ ...config, capabilities: [] })
    expect(remainingCapabilityIds(empty, ['wallet-login', 'x'])).toEqual(['wallet-login', 'x'])
  })

  test('readValidManifest returns null when file absent', () => {
    expect(readValidManifest(dir)).toBeNull()
  })

  test('readValidManifest returns manifest for a valid file', () => {
    const m = manifestFromConfig(config)
    writeProjectManifest(dir, m)
    expect(readValidManifest(dir)).toEqual(m)
  })

  test('readValidManifest throws on malformed file (capabilities not array)', () => {
    writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify({
      version: 1, name: 'test', network: 'test', stack: {}, bsvDir: 'src/bsv', capabilities: 'oops'
    }) + '\n')
    expect(() => readValidManifest(dir)).toThrow('malformed bsv-scaffold.json')
  })

  test('readValidManifest throws on wrong version', () => {
    writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify({
      version: 2, name: 'test', network: 'test', stack: {}, bsvDir: 'src/bsv', capabilities: []
    }) + '\n')
    expect(() => readValidManifest(dir)).toThrow('malformed bsv-scaffold.json')
  })

  test('readValidManifest throws on path-traversal bsvDir', () => {
    writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify({
      version: 1, name: 'test', network: 'test', stack: {}, bsvDir: '../escape', capabilities: []
    }) + '\n')
    expect(() => readValidManifest(dir)).toThrow('malformed bsv-scaffold.json')
  })

  test('readValidManifest throws on unsupported frontend framework', () => {
    writeFileSync(join(dir, 'bsv-scaffold.json'), JSON.stringify({
      version: 1, name: 'test', network: 'test', stack: { frontend: { framework: 'svelte' } }, bsvDir: 'src/bsv', capabilities: []
    }) + '\n')
    expect(() => readValidManifest(dir)).toThrow('malformed bsv-scaffold.json')
  })
})
