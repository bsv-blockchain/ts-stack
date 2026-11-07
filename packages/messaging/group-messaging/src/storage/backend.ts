export type Awaitable<T> = T | Promise<T>

/**
 * The five namespaces the library keeps. A backend is free to map these onto
 * tables, object stores or key prefixes as it sees fit.
 */
export const STORAGE_TABLES = ['chats', 'groups', 'keyPackages', 'pending', 'invites'] as const
export type StorageTable = (typeof STORAGE_TABLES)[number]

/**
 * The storage seam: four operations over namespaced byte blobs.
 *
 * The library never opens a database. A host that already has one — the Nexus
 * wallet's SQLite connection, a browser's IndexedDB, a plain `Map` — hands it
 * over and the library uses it. Values holding private key material inherit
 * whatever protection the host gives them, so a real backend should be
 * encrypted at rest.
 *
 * Methods may return promises or plain values, which is what lets a
 * `Map<string, Uint8Array>` satisfy the shape with no adapter.
 */
export interface StorageBackend {
  /** Create tables, object stores or whatever else the backend needs. */
  init?(): Promise<void>
  get(table: StorageTable, key: string): Awaitable<Uint8Array | undefined>
  set(table: StorageTable, key: string, value: Uint8Array): Awaitable<void>
  delete(table: StorageTable, key: string): Awaitable<void>
  keys(table: StorageTable): Awaitable<Iterable<string>>
  close?(): Promise<void>
}
