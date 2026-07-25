import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

function hasErrorCode (error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export function readUtf8FileIfExists (file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
}

export function writeUtf8FileExclusive (file: string, content: string): boolean {
  try {
    writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) return false
    throw error
  }
}

export function writeUtf8FileAtomic (file: string, content: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | undefined

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
