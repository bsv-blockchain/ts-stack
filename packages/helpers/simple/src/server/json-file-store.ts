/**
 * Generic file-based JSON persistence.
 * Used by identity registry, server wallet manager, and credential issuer handler.
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'

export class JsonFileStore<T> {
  constructor (private readonly filePath: string) {}

  load (): T | null {
    try {
      if (existsSync(this.filePath)) {
        return JSON.parse(readFileSync(this.filePath, 'utf-8'))
      }
    } catch {
      // Corrupted file — treat as missing
    }
    return null
  }

  save (data: T): void {
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  delete (): void {
    try {
      if (existsSync(this.filePath)) unlinkSync(this.filePath)
    } catch {
      // Already gone
    }
  }

  exists (): boolean {
    return existsSync(this.filePath)
  }
}
