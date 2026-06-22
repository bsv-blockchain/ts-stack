// src/config/__tests__/file.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfigFromFile } from '../file'
import { ConfigError } from '../validate'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-file-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeFile (name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content)
  return p
}

describe('resolveConfigFromFile', () => {
  test('loads and resolves a valid config file', () => {
    const p = writeFile('config.json', JSON.stringify({ name: 'demo', stack: { frontend: { framework: 'react' } }, capabilities: ['wallet-login'] }))
    const c = resolveConfigFromFile(p)
    expect(c.name).toBe('demo')
    expect(c.stack.frontend?.framework).toBe('react')
    expect(c.capabilities).toEqual(['wallet-login'])
  })

  test('throws ConfigError on missing file', () => {
    expect(() => resolveConfigFromFile(join(dir, 'nope.json'))).toThrow(ConfigError)
  })

  test('throws ConfigError on malformed JSON', () => {
    const p = writeFile('bad.json', '{ not json')
    expect(() => resolveConfigFromFile(p)).toThrow(/invalid JSON/i)
  })

  test('propagates ConfigError from resolveConfig (unknown capability)', () => {
    const p = writeFile('bad-cap.json', JSON.stringify({ name: 'x', stack: { backend: { framework: 'express' } }, capabilities: ['nope'] }))
    expect(() => resolveConfigFromFile(p)).toThrow(/unknown capability/i)
  })
})
