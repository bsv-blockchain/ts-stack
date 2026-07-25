import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function hasErrorCode (error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export function readUtf8FileIfExists (file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

export function writeUtf8FileAtomic (file, content) {
  const parent = dirname(file)
  const temporary = join(parent, `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor

  mkdirSync(parent, { recursive: true })
  try {
    descriptor = openSync(temporary, 'wx')
    writeFileSync(descriptor, content, 'utf8')
    fsyncSync(descriptor)
    const completedDescriptor = descriptor
    descriptor = undefined
    closeSync(completedDescriptor)
    renameSync(temporary, file)
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor)
    } finally {
      rmSync(temporary, { force: true })
    }
  }
}
