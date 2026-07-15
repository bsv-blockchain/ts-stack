// src/__tests__/write.test.ts
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFiles } from '../engine'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cba-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('writeFiles', () => {
  test('writes files and creates nested directories', () => {
    const res = writeFiles([{ path: 'src/bsv/auth.ts', content: 'hi' }], dir)
    expect(res.written).toEqual(['src/bsv/auth.ts'])
    expect(readFileSync(join(dir, 'src/bsv/auth.ts'), 'utf8')).toBe('hi')
  })

  test('skips existing files on a second run (idempotent)', () => {
    writeFiles([{ path: 'a.txt', content: 'one' }], dir)
    const res = writeFiles([{ path: 'a.txt', content: 'two' }], dir)
    expect(res.skipped).toEqual(['a.txt'])
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one')
  })

  test('overwrites when force is set', () => {
    writeFiles([{ path: 'a.txt', content: 'one' }], dir)
    const res = writeFiles([{ path: 'a.txt', content: 'two' }], dir, { force: true })
    expect(res.written).toEqual(['a.txt'])
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two')
  })
})
