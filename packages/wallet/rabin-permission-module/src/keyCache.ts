import type { RabinKey } from './rabin.js'

interface Entry {
  key: RabinKey
  /** The originator whose request generated the key; it alone is charged for the entry. */
  originator: string
}

/** Overwrites a key's fields. Best effort: bigints are immutable, so this only drops references. */
export function forgetKey(key: RabinKey): void {
  key.p = 0n
  key.q = 0n
  key.n = 0n
  key.pInvModQ = 0n
}

/**
 * Bounded least-recently-used cache of generated Rabin keys, keyed by derivation identity. Each
 * entry is charged to the originator that generated it, and one originator may hold at most
 * `perOriginator` entries: at that cap its own least recently used entry is evicted, so one
 * application cannot displace every other application's keys. At `capacity` the global least
 * recently used entry is evicted. Evicted keys are zeroed.
 */
export class KeyCache {
  readonly #capacity: number
  readonly #perOriginator: number
  readonly #entries = new Map<string, Entry>()
  readonly #counts = new Map<string, number>()

  constructor(capacity: number, perOriginator: number) {
    this.#capacity = capacity
    this.#perOriginator = perOriginator
  }

  get size(): number {
    return this.#entries.size
  }

  /** Number of entries charged to an originator. */
  countFor(originator: string): number {
    return this.#counts.get(originator) ?? 0
  }

  /** Returns a copy of the key and marks it most recently used. */
  get(id: string): RabinKey | undefined {
    const entry = this.#entries.get(id)
    if (entry === undefined) return undefined
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    return { ...entry.key }
  }

  /** Stores a key, taking ownership of the object (it is zeroed on eviction or clear). */
  set(id: string, key: RabinKey, originator: string): void {
    this.#remove(id)
    if (this.countFor(originator) >= this.#perOriginator) {
      for (const [candidate, entry] of this.#entries) {
        if (entry.originator === originator) {
          this.#remove(candidate)
          break
        }
      }
    }
    if (this.#entries.size >= this.#capacity) {
      this.#remove(this.#entries.keys().next().value!)
    }
    this.#entries.set(id, { key, originator })
    this.#counts.set(originator, this.countFor(originator) + 1)
  }

  /** Zeroes and drops every key. */
  clear(): void {
    for (const entry of this.#entries.values()) forgetKey(entry.key)
    this.#entries.clear()
    this.#counts.clear()
  }

  #remove(id: string): void {
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    this.#entries.delete(id)
    forgetKey(entry.key)
    const remaining = this.countFor(entry.originator) - 1
    if (remaining > 0) this.#counts.set(entry.originator, remaining)
    else this.#counts.delete(entry.originator)
  }
}
