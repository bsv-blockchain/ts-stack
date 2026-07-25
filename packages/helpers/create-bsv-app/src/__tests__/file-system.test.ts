import { afterEach, beforeEach, expect, test } from '@jest/globals'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readUtf8FileIfExists,
  writeUtf8FileAtomic,
  writeUtf8FileExclusive
} from '../file-system'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'cba-fs-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

test('reads existing files and returns undefined for missing files', () => {
  const file = join(directory, 'value.txt')
  expect(readUtf8FileIfExists(file)).toBeUndefined()
  expect(writeUtf8FileExclusive(file, 'first')).toBe(true)
  expect(readUtf8FileIfExists(file)).toBe('first')
})

test('read failures other than a missing file remain visible', () => {
  expect(() => readUtf8FileIfExists(directory)).toThrow()
})

test('exclusive writes cannot overwrite a file', () => {
  const file = join(directory, 'value.txt')
  expect(writeUtf8FileExclusive(file, 'first')).toBe(true)
  expect(writeUtf8FileExclusive(file, 'second')).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('first')
})

test('exclusive write failures other than an existing file remain visible', () => {
  expect(() => writeUtf8FileExclusive(join(directory, 'missing', 'value.txt'), 'value')).toThrow()
})

test('atomic writes replace a complete file without leaving a temporary file', () => {
  const file = join(directory, 'value.txt')
  writeUtf8FileAtomic(file, 'first')
  writeUtf8FileAtomic(file, 'second')
  expect(readFileSync(file, 'utf8')).toBe('second')
  expect(readdirSync(directory)).toEqual(['value.txt'])
})

test('atomic writes close and remove temporary files after a write failure', () => {
  expect(() => writeUtf8FileAtomic(
    join(directory, 'value.txt'),
    null as unknown as string
  )).toThrow()
  expect(readdirSync(directory)).toEqual([])
})
