import type { StorageBackend, StorageTable } from '../backend.js'

/**
 * A backend over a single `Map`, namespaced by key prefix.
 *
 * The map is supplied by the caller — the demo owns one and passes it in — so
 * the library never holds state nobody asked for. `StorageProvider.memory()`
 * creates one for you, which is a caller asking by name.
 */
export class MapStorageBackend implements StorageBackend {
  constructor(private readonly map: Map<string, Uint8Array>) {}

  get(table: StorageTable, key: string): Uint8Array | undefined {
    return this.map.get(scope(table, key))?.slice()
  }

  set(table: StorageTable, key: string, value: Uint8Array): void {
    // A real database copies on the way in and yields a fresh value on the way
    // out. Storing the caller's view by reference would make a `Map` the one
    // backend where reusing a buffer rewrites what is already stored, so the
    // demo and the tests would never see a bug SQLite hosts would.
    this.map.set(scope(table, key), value.slice())
  }

  delete(table: StorageTable, key: string): void {
    this.map.delete(scope(table, key))
  }

  keys(table: StorageTable): string[] {
    const prefix = `${table}:`
    const found: string[] = []
    for (const key of this.map.keys()) {
      if (key.startsWith(prefix)) found.push(key.slice(prefix.length))
    }
    return found
  }
}

const scope = (table: StorageTable, key: string): string => `${table}:${key}`
