import type { CHIRPObjectCache } from './types.js'

interface CacheEntry {
  bytes: Uint8Array
  size: number
}

export class MemoryCHIRPCache implements CHIRPObjectCache {
  private readonly entries = new Map<string, CacheEntry>()
  private currentBytes = 0

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntries = 4096
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new RangeError('maxBytes must be non-negative.')
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
      throw new RangeError('maxEntries must be non-negative.')
  }

  get(objectIdentifier: string): Uint8Array | undefined {
    const entry = this.entries.get(objectIdentifier)
    if (entry == null) return undefined
    this.entries.delete(objectIdentifier)
    this.entries.set(objectIdentifier, entry)
    return entry.bytes.slice()
  }

  set(objectIdentifier: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxBytes || this.maxEntries === 0) return
    const previous = this.entries.get(objectIdentifier)
    if (previous != null) {
      this.entries.delete(objectIdentifier)
      this.currentBytes -= previous.size
    }
    const entry = { bytes: bytes.slice(), size: bytes.byteLength }
    this.entries.set(objectIdentifier, entry)
    this.currentBytes += entry.size
    while (this.currentBytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined
      if (oldestKey == null) break
      const oldest = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      this.currentBytes -= oldest?.size ?? 0
    }
  }
}
