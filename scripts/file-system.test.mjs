import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

test('readUtf8FileIfExists distinguishes a missing file from other failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-fs-read-'))
  try {
    assert.equal(readUtf8FileIfExists(join(directory, 'missing.txt')), undefined)
    assert.throws(() => readUtf8FileIfExists(directory), { code: 'EISDIR' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('writeUtf8FileAtomic creates directories and replaces complete files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-fs-write-'))
  const file = join(directory, 'nested', 'value.txt')
  try {
    writeUtf8FileAtomic(file, 'first')
    writeUtf8FileAtomic(file, 'second')

    assert.equal(readFileSync(file, 'utf8'), 'second')
    assert.deepEqual(readdirSync(join(directory, 'nested')), ['value.txt'])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('writeUtf8FileAtomic closes and removes temporary files after a write failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ts-stack-fs-failure-'))
  try {
    assert.throws(() => writeUtf8FileAtomic(join(directory, 'value.txt'), null))
    assert.deepEqual(readdirSync(directory), [])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
