/**
 * Generic file-based JSON persistence.
 * Used by identity registry, server wallet manager, and credential issuer handler.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

const MAX_JSON_FILE_BYTES = 16 * 1024 * 1024

function missingFile(error: unknown): boolean {
  return error != null && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT'
}

export class JsonFileStore<T> {
  constructor(private readonly filePath: string) {}

  load(): T | null {
    let fd: number | undefined
    try {
      fd = openSync(this.filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_JSON_FILE_BYTES) {
        throw new Error('Persistent JSON state is not a bounded regular file')
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('Persistent JSON state is owned by another user')
      }
      if ((stat.mode & 0o077) !== 0) fchmodSync(fd, 0o600)
      const text = readFileSync(fd, 'utf8')
      return JSON.parse(text) as T
    } catch (error) {
      if (missingFile(error)) return null
      throw new Error('Persistent JSON state could not be loaded safely')
    } finally {
      if (fd != null) closeSync(fd)
    }
  }

  save(data: T): void {
    const serialized = JSON.stringify(data, null, 2)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_JSON_FILE_BYTES) {
      throw new Error('Persistent JSON state exceeds the configured limit')
    }
    const temporary = join(
      dirname(this.filePath),
      `.${basename(this.filePath)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    )
    let fd: number | undefined
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      writeFileSync(fd, serialized, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, this.filePath)
      chmodSync(this.filePath, 0o600)
    } catch (error) {
      if (fd != null) closeSync(fd)
      try {
        unlinkSync(temporary)
      } catch (cleanupError) {
        if (!missingFile(cleanupError)) {
          throw new Error('Persistent JSON state cleanup failed')
        }
      }
      throw error
    }
  }

  delete(): void {
    try {
      unlinkSync(this.filePath)
    } catch (error) {
      if (!missingFile(error)) throw error
    }
  }

  exists(): boolean {
    return existsSync(this.filePath)
  }
}
