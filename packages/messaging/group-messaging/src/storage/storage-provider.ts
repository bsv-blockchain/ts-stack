import { GroupMessagingError } from '../errors.js'
import type {
  ChatId,
  IdentityKey,
  InviteId,
  KeyPackageBytes,
  KeyPackageRef,
  MlsGroupId,
  PendingInvite
} from '../types.js'
import type { StorageBackend, StorageTable } from './backend.js'
import { IndexedDbStorageBackend, openDatabase } from './backends/indexeddb.js'
import { MapStorageBackend } from './backends/map.js'
import { SqlStorageBackend, type SqlDriver, type SqlStorageOptions } from './backends/sql.js'
import { decodeFrames, encodeFrames } from './frames.js'

/** A local chat: the application-chosen name over the MLS group underneath. */
export interface ChatRecord {
  chatId: ChatId
  mlsGroupId: MlsGroupId
  name?: string
  createdAt: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const toJson = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))
const fromJson = <T>(bytes: Uint8Array): T => JSON.parse(decoder.decode(bytes)) as T

/**
 * Anything {@link StorageProvider.open} knows how to turn into storage.
 *
 * The point of the union is that a host passes what it already has. Nexus has
 * an open SQLite connection, a browser has IndexedDB, a test has a `Map` — none
 * of them should have to write an adapter first.
 */
export type StorageInput =
  | StorageProvider
  | StorageBackend
  | SqlDriver
  | IDBDatabase
  | Map<string, Uint8Array>
  | 'memory'
  | 'indexeddb'

/**
 * Everything the library needs to survive a restart, over a backend the host
 * supplies.
 *
 * This is the class callers touch. It owns the layout — which namespace holds
 * what, how an ordered queue is framed into a single value — and delegates the
 * bytes to a {@link StorageBackend}. Swapping SQLite for IndexedDB for a `Map`
 * changes the backend and nothing else.
 */
export class StorageProvider {
  /** Prepended to every key. Empty for an unscoped provider. */
  readonly #prefix: string

  /**
   * `identityKey` scopes every key to one account. Omit it for the raw,
   * account-blind view — {@link StorageProvider.scopeTo} is how the client
   * narrows one.
   */
  constructor(
    private readonly backend: StorageBackend,
    identityKey?: IdentityKey
  ) {
    this.#prefix = identityKey === undefined ? '' : `${identityKey}/`
  }

  /**
   * The same backend, seen as one identity's entries and nothing else.
   *
   * Namespacing by table and key alone is not enough for the intended host: a
   * wallet managing several accounts hands every one of them the same
   * `SqlDriver`, the same `IDBDatabase` or the same `Map`. Without an identity
   * in the key, account B's `listChats` enumerates account A's chats, its
   * `listKeyPackageRefs` returns A's refs, `chatIdForGroup` resolves across
   * accounts, and two accounts in one MLS group overwrite each other's state
   * under the same `mlsGroupId`.
   *
   * Applied by {@link GroupMessagingClient}'s constructor rather than by
   * `open`, because that is the first moment the identity is certainly known —
   * `create` resolves identity, storage and transport concurrently — and
   * because it covers a caller who assembles the layers by hand just as well.
   * Scoping is by replacement, so applying it twice for one identity is a
   * no-op, and the provider handed in is left alone rather than mutated.
   */
  scopeTo(identityKey: IdentityKey): StorageProvider {
    return new StorageProvider(this.backend, identityKey)
  }

  /** The identity every key is scoped to, or `undefined` for the raw view. */
  get identityKey(): IdentityKey | undefined {
    return this.#prefix === '' ? undefined : this.#prefix.slice(0, -1)
  }

  /** In-process storage over a fresh `Map`. Lost on reload. */
  static memory(): StorageProvider {
    return new StorageProvider(new MapStorageBackend(new Map()))
  }

  /** Storage over a `Map` the caller owns. */
  static map(map: Map<string, Uint8Array>): StorageProvider {
    return new StorageProvider(new MapStorageBackend(map))
  }

  /** Storage over a SQL database the host already opened. */
  static sql(driver: SqlDriver, options?: SqlStorageOptions): StorageProvider {
    return new StorageProvider(new SqlStorageBackend(driver, options))
  }

  /** Storage over an `IDBDatabase` the host already opened. */
  static indexedDb(database: IDBDatabase): StorageProvider {
    return new StorageProvider(new IndexedDbStorageBackend(database))
  }

  /**
   * Work out which backend fits, build it, and initialize it.
   *
   * This is what `GroupMessagingClient.create` calls, so a caller normally
   * passes their database straight to the client and never sees this.
   */
  static async open(input: StorageInput): Promise<StorageProvider> {
    const provider = await StorageProvider.#resolve(input)
    await provider.init()
    return provider
  }

  static async #resolve(input: StorageInput): Promise<StorageProvider> {
    if (input instanceof StorageProvider) return input
    if (input === 'memory') return StorageProvider.memory()
    if (input === 'indexeddb') return StorageProvider.indexedDb(await openDatabase())
    if (input instanceof Map) return StorageProvider.map(input)
    if (isSqlDriver(input)) return StorageProvider.sql(input)
    if (isIndexedDb(input)) return StorageProvider.indexedDb(input)
    if (isBackend(input)) return new StorageProvider(input)
    throw new GroupMessagingError(
      'Unrecognized storage. Pass a SqlDriver, an IDBDatabase, a Map, a StorageBackend, or "memory".'
    )
  }

  /** Create whatever the backend needs. Safe to call more than once. */
  async init(): Promise<void> {
    await this.backend.init?.()
  }

  async close(): Promise<void> {
    await this.backend.close?.()
  }

  async #get(table: StorageTable, key: string): Promise<Uint8Array | undefined> {
    return this.backend.get(table, this.#prefix + key)
  }

  async #set(table: StorageTable, key: string, value: Uint8Array): Promise<void> {
    await this.backend.set(table, this.#prefix + key, value)
  }

  async #delete(table: StorageTable, key: string): Promise<void> {
    await this.backend.delete(table, this.#prefix + key)
  }

  /** This identity's keys in `table`, with the scope stripped back off. */
  async #keys(table: StorageTable): Promise<string[]> {
    const found: string[] = []
    for (const key of await this.backend.keys(table)) {
      if (key.startsWith(this.#prefix)) found.push(key.slice(this.#prefix.length))
    }
    return found
  }

  // ── MLS group state ──────────────────────────────────────────────────────

  async getGroup(groupId: MlsGroupId): Promise<Uint8Array | undefined> {
    return this.#get('groups', groupId)
  }

  async putGroup(groupId: MlsGroupId, state: Uint8Array): Promise<void> {
    await this.#set('groups', groupId, state)
  }

  /** Removes the group and anything queued for it. */
  async deleteGroup(groupId: MlsGroupId): Promise<void> {
    await this.#delete('groups', groupId)
    await this.#delete('pending', groupId)
  }

  async listGroups(): Promise<MlsGroupId[]> {
    return this.#keys('groups')
  }

  // ── Chats ────────────────────────────────────────────────────────────────

  async getChat(chatId: ChatId): Promise<ChatRecord | undefined> {
    const bytes = await this.#get('chats', chatId)
    return bytes === undefined ? undefined : fromJson<ChatRecord>(bytes)
  }

  async putChat(record: ChatRecord): Promise<void> {
    await this.#set('chats', record.chatId, toJson(record))
  }

  /** Removes the chat, its MLS state, and anything queued for it. */
  async deleteChat(chatId: ChatId): Promise<void> {
    const record = await this.getChat(chatId)
    await this.#delete('chats', chatId)
    if (record !== undefined) await this.deleteGroup(record.mlsGroupId)
  }

  async listChats(): Promise<ChatRecord[]> {
    const chats: ChatRecord[] = []
    for (const key of await this.#keys('chats')) {
      const record = await this.getChat(key)
      if (record !== undefined) chats.push(record)
    }
    return chats
  }

  /** Inbound traffic names the MLS group; the application names the chat. */
  async chatIdForGroup(mlsGroupId: MlsGroupId): Promise<ChatId | undefined> {
    const match = (await this.listChats()).find(chat => chat.mlsGroupId === mlsGroupId)
    return match?.chatId
  }

  // ── KeyPackages: PUBLIC bytes only, keyed by RFC 9420 ref ────────────────

  async getKeyPackage(ref: KeyPackageRef): Promise<KeyPackageBytes | undefined> {
    const bytes = await this.#get('keyPackages', ref)
    return bytes === undefined ? undefined : (bytes as KeyPackageBytes)
  }

  async putKeyPackage(ref: KeyPackageRef, keyPackage: KeyPackageBytes): Promise<void> {
    await this.#set('keyPackages', ref, keyPackage)
  }

  async deleteKeyPackage(ref: KeyPackageRef): Promise<void> {
    await this.#delete('keyPackages', ref)
  }

  async listKeyPackageRefs(): Promise<KeyPackageRef[]> {
    return this.#keys('keyPackages')
  }

  // ── Invites ──────────────────────────────────────────────────────────────

  async getInvite(inviteId: InviteId): Promise<PendingInvite | undefined> {
    const bytes = await this.#get('invites', inviteId)
    return bytes === undefined ? undefined : fromJson<PendingInvite>(bytes)
  }

  async putInvite(invite: PendingInvite): Promise<void> {
    await this.#set('invites', invite.inviteId, toJson(invite))
  }

  async deleteInvite(inviteId: InviteId): Promise<void> {
    await this.#delete('invites', inviteId)
  }

  async listInvites(direction?: 'inbound' | 'outbound'): Promise<PendingInvite[]> {
    const invites: PendingInvite[] = []
    for (const key of await this.#keys('invites')) {
      const invite = await this.getInvite(key)
      if (invite !== undefined && (direction === undefined || invite.direction === direction)) {
        invites.push(invite)
      }
    }
    return invites
  }

  /**
   * `requestId` is the wire correlator; `inviteId` is this device's handle.
   *
   * A `requestId` is unique only within a direction: the peer we sent one to
   * knows it and may put it on a request of their own, so a caller looking for
   * the exchange it started must say which side it means.
   */
  async inviteForRequestId(
    requestId: string,
    direction?: 'inbound' | 'outbound'
  ): Promise<PendingInvite | undefined> {
    return (await this.listInvites(direction)).find(invite => invite.requestId === requestId)
  }

  // ── Protocol messages waiting on a Commit ────────────────────────────────

  /**
   * Hold a message that cannot be processed yet — typically an application
   * message for an epoch whose Commit has not arrived. Order is preserved.
   */
  async queuePending(groupId: MlsGroupId, payload: Uint8Array): Promise<void> {
    const queue = decodeFrames(await this.#get('pending', groupId))
    queue.push(payload)
    await this.#set('pending', groupId, encodeFrames(queue))
  }

  /**
   * Replace a group's whole queue in one write.
   *
   * `queuePending` rewrites the queue per call, so re-queueing what a drain
   * could not apply one payload at a time costs O(n²) bytes on a path that
   * runs after every Commit.
   */
  async replacePending(groupId: MlsGroupId, payloads: readonly Uint8Array[]): Promise<void> {
    if (payloads.length === 0) {
      await this.#delete('pending', groupId)
      return
    }
    await this.#set('pending', groupId, encodeFrames([...payloads]))
  }

  /** What is waiting for this group's next Commit, counted and measured. */
  async pendingStats(groupId: MlsGroupId): Promise<{ count: number; bytes: number }> {
    const stored = await this.#get('pending', groupId)
    return { count: decodeFrames(stored).length, bytes: stored?.length ?? 0 }
  }

  /**
   * Read a group's queue without consuming it.
   *
   * The drain reads here and only removes what it has durably applied, so a
   * failure mid-drain leaves every unapplied payload where it was.
   */
  async peekPending(groupId: MlsGroupId): Promise<Uint8Array[]> {
    return decodeFrames(await this.#get('pending', groupId))
  }

  /** Read and clear a group's queue. */
  async takePending(groupId: MlsGroupId): Promise<Uint8Array[]> {
    const queue = decodeFrames(await this.#get('pending', groupId))
    if (queue.length > 0) await this.#delete('pending', groupId)
    return queue
  }

  /** Every group with something queued, joined or not. */
  async listPendingGroups(): Promise<MlsGroupId[]> {
    return this.#keys('pending')
  }

  async countPending(groupId: MlsGroupId): Promise<number> {
    return decodeFrames(await this.#get('pending', groupId)).length
  }

  /** Escape hatch for a caller that wants the stored bytes for one key. */
  async read(table: StorageTable, key: string): Promise<Uint8Array | undefined> {
    return this.#get(table, key)
  }
}

const hasFunctions = (value: unknown, names: string[]): boolean =>
  typeof value === 'object' &&
  value !== null &&
  names.every(name => typeof (value as Record<string, unknown>)[name] === 'function')

const isSqlDriver = (value: unknown): value is SqlDriver =>
  hasFunctions(value, ['execAsync', 'runAsync', 'getAllAsync', 'getFirstAsync'])

const isIndexedDb = (value: unknown): value is IDBDatabase =>
  hasFunctions(value, ['transaction', 'close']) && 'objectStoreNames' in (value as object)

const isBackend = (value: unknown): value is StorageBackend =>
  hasFunctions(value, ['get', 'set', 'delete', 'keys'])
