import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { KeyPackageBytes } from '../../types.js'
import { openDatabase } from '../backends/indexeddb.js'
import { SqlStorageBackend } from '../backends/sql.js'
import { nodeSqliteDriver } from './node-sqlite-driver.js'
import { StorageProvider } from '../storage-provider.js'

/**
 * Every backend runs the same suite. Passing it is what makes them
 * interchangeable as far as the library is concerned.
 */
const behavesLikeStorage = (name: string, open: () => Promise<StorageProvider>): void => {
  describe(name, () => {
    let storage: StorageProvider

    beforeEach(async () => {
      storage = await open()
      await storage.init()
    })

    it('round-trips group state', async () => {
      await storage.putGroup('g1', new Uint8Array([1, 2, 3]))
      expect(await storage.getGroup('g1')).toEqual(new Uint8Array([1, 2, 3]))
      expect(await storage.listGroups()).toEqual(['g1'])
    })

    it('overwrites an existing group rather than duplicating it', async () => {
      await storage.putGroup('g1', new Uint8Array([1]))
      await storage.putGroup('g1', new Uint8Array([2]))
      expect(await storage.getGroup('g1')).toEqual(new Uint8Array([2]))
      expect(await storage.listGroups()).toEqual(['g1'])
    })

    it('copies what it is given, so a host reusing a buffer cannot corrupt it', async () => {
      const buffer = new Uint8Array([1, 2, 3])
      await storage.putGroup('g1', buffer)
      buffer[0] = 9

      expect(await storage.getGroup('g1')).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('copies what it hands back, so a caller writing to it cannot corrupt it', async () => {
      await storage.putGroup('g1', new Uint8Array([1, 2, 3]))

      const read = await storage.getGroup('g1')
      read![0] = 9

      expect(await storage.getGroup('g1')).toEqual(new Uint8Array([1, 2, 3]))
    })

    it('returns undefined for a group it does not have', async () => {
      expect(await storage.getGroup('missing')).toBeUndefined()
    })

    it('keeps namespaces apart', async () => {
      await storage.putGroup('same', new Uint8Array([1]))
      await storage.putKeyPackage('same', new Uint8Array([2]) as KeyPackageBytes)

      expect(await storage.getGroup('same')).toEqual(new Uint8Array([1]))
      expect(await storage.getKeyPackage('same')).toEqual(new Uint8Array([2]))
      expect(await storage.listGroups()).toEqual(['same'])
    })

    it('replaces a whole queue in order, and clears it when given nothing', async () => {
      await storage.queuePending('g1', new Uint8Array([1]))
      await storage.replacePending('g1', [new Uint8Array([7]), new Uint8Array([8])])

      expect(await storage.takePending('g1')).toEqual([new Uint8Array([7]), new Uint8Array([8])])

      await storage.queuePending('g1', new Uint8Array([9]))
      await storage.replacePending('g1', [])
      expect(await storage.countPending('g1')).toBe(0)
    })

    it('measures a queue as well as counting it', async () => {
      expect(await storage.pendingStats('g1')).toEqual({ count: 0, bytes: 0 })

      await storage.queuePending('g1', new Uint8Array([1, 2, 3]))
      await storage.queuePending('g1', new Uint8Array([4, 5]))

      const stats = await storage.pendingStats('g1')
      expect(stats.count).toBe(2)
      // Five payload bytes plus a four-byte length header on each frame.
      expect(stats.bytes).toBe(13)
    })

    it('lists every group with something queued', async () => {
      expect(await storage.listPendingGroups()).toEqual([])

      await storage.queuePending('g1', new Uint8Array([1]))
      await storage.queuePending('g2', new Uint8Array([2]))
      expect((await storage.listPendingGroups()).sort()).toEqual(['g1', 'g2'])

      await storage.replacePending('g1', [])
      expect(await storage.listPendingGroups()).toEqual(['g2'])
    })

    it('keeps pending messages ordered and drains them once', async () => {
      await storage.queuePending('g1', new Uint8Array([1]))
      await storage.queuePending('g1', new Uint8Array([2]))
      await storage.queuePending('g1', new Uint8Array([3]))
      expect(await storage.countPending('g1')).toBe(3)

      expect(await storage.takePending('g1')).toEqual([
        new Uint8Array([1]),
        new Uint8Array([2]),
        new Uint8Array([3])
      ])
      expect(await storage.takePending('g1')).toEqual([])
    })

    it("discards a group's pending queue when the group is deleted", async () => {
      await storage.putGroup('g1', new Uint8Array([1]))
      await storage.queuePending('g1', new Uint8Array([9]))

      await storage.deleteGroup('g1')

      expect(await storage.getGroup('g1')).toBeUndefined()
      expect(await storage.takePending('g1')).toEqual([])
    })

    it('round-trips a chat and resolves its mlsGroupId back to a chatId', async () => {
      await storage.putChat({
        chatId: 'c1',
        mlsGroupId: 'aabb',
        name: 'Project Alpha',
        createdAt: '2026-08-18T00:00:00.000Z'
      })

      expect((await storage.getChat('c1'))?.name).toBe('Project Alpha')
      expect(await storage.chatIdForGroup('aabb')).toBe('c1')
      expect(await storage.chatIdForGroup('ffff')).toBeUndefined()
      expect((await storage.listChats()).map(chat => chat.chatId)).toEqual(['c1'])
    })

    it('deleting a chat drops its group state and pending queue', async () => {
      await storage.putChat({ chatId: 'c1', mlsGroupId: 'aabb', createdAt: 't' })
      await storage.putGroup('aabb', new Uint8Array([1]))
      await storage.queuePending('aabb', new Uint8Array([9]))

      await storage.deleteChat('c1')

      expect(await storage.getChat('c1')).toBeUndefined()
      expect(await storage.getGroup('aabb')).toBeUndefined()
      expect(await storage.countPending('aabb')).toBe(0)
    })

    it('stores public KeyPackages keyed by ref', async () => {
      const bytes = new Uint8Array([1, 2, 3]) as KeyPackageBytes
      await storage.putKeyPackage('a3f1', bytes)

      expect(await storage.getKeyPackage('a3f1')).toEqual(bytes)
      expect(await storage.listKeyPackageRefs()).toEqual(['a3f1'])

      await storage.deleteKeyPackage('a3f1')
      expect(await storage.listKeyPackageRefs()).toEqual([])
    })

    it('filters invites by direction and finds one by requestId', async () => {
      const base = { kind: 'keyPackageRequest' as const, peer: '02aa', receivedAt: 't' }
      await storage.putInvite({ ...base, inviteId: 'i1', direction: 'inbound', requestId: 'r1' })
      await storage.putInvite({ ...base, inviteId: 'i2', direction: 'outbound', requestId: 'r2' })

      expect((await storage.listInvites('inbound')).map(i => i.inviteId)).toEqual(['i1'])
      expect((await storage.listInvites('outbound')).map(i => i.inviteId)).toEqual(['i2'])
      expect((await storage.listInvites()).length).toBe(2)
      expect((await storage.inviteForRequestId('r2'))?.inviteId).toBe('i2')
      expect(await storage.inviteForRequestId('nope')).toBeUndefined()
    })

    // The peer knows the requestId we sent them, so they can mint an inbound
    // row carrying the same value. Without a direction the winner is whichever
    // key the backend happens to list first.
    it('finds one by requestId and direction when both directions share it', async () => {
      const base = { kind: 'keyPackageRequest' as const, peer: '02aa', receivedAt: 't' }
      await storage.putInvite({ ...base, inviteId: 'i1', direction: 'inbound', requestId: 'rx' })
      await storage.putInvite({ ...base, inviteId: 'i2', direction: 'outbound', requestId: 'rx' })

      expect((await storage.inviteForRequestId('rx', 'outbound'))?.inviteId).toBe('i2')
      expect((await storage.inviteForRequestId('rx', 'inbound'))?.inviteId).toBe('i1')
    })
  })
}

let databaseCount = 0

behavesLikeStorage('memory', async () => StorageProvider.memory())
behavesLikeStorage("caller's Map", async () => StorageProvider.map(new Map()))
behavesLikeStorage('SQL over node:sqlite', async () => StorageProvider.sql(nodeSqliteDriver()))
behavesLikeStorage('IndexedDB', async () =>
  StorageProvider.indexedDb(await openDatabase(`suite-${databaseCount++}`))
)

describe('StorageProvider.open', () => {
  it('accepts a Map and namespaces its keys', async () => {
    const map = new Map<string, Uint8Array>()
    const storage = await StorageProvider.open(map)
    await storage.putGroup('g1', new Uint8Array([1]))

    expect([...map.keys()]).toEqual(['groups:g1'])
  })

  it('accepts a SqlDriver and creates its table', async () => {
    const driver = nodeSqliteDriver()
    const storage = await StorageProvider.open(driver)
    await storage.putGroup('g1', new Uint8Array([1]))

    const rows = await driver.getAllAsync<{ namespace: string; key: string }>(
      'SELECT namespace, key FROM group_messaging_store'
    )
    expect(rows).toEqual([{ namespace: 'groups', key: 'g1' }])
  })

  it('accepts an IDBDatabase', async () => {
    const storage = await StorageProvider.open(await openDatabase('open-idb'))
    await storage.putGroup('g1', new Uint8Array([1]))
    expect(await storage.getGroup('g1')).toEqual(new Uint8Array([1]))
  })

  it('accepts the memory shorthand, with separate state per call', async () => {
    const first = await StorageProvider.open('memory')
    const second = await StorageProvider.open('memory')
    await first.putGroup('g1', new Uint8Array([1]))

    expect(await second.getGroup('g1')).toBeUndefined()
  })

  it('passes an existing provider through untouched', async () => {
    const provider = StorageProvider.memory()
    expect(await StorageProvider.open(provider)).toBe(provider)
  })

  it('rejects something it cannot recognize', async () => {
    await expect(StorageProvider.open({ nope: true } as never)).rejects.toThrow(
      /Unrecognized storage/
    )
  })
})

describe('SqlStorageBackend', () => {
  it('shares rows between two providers over one connection', async () => {
    const driver = nodeSqliteDriver()
    const first = await StorageProvider.open(driver)
    await first.putGroup('g1', new Uint8Array([1, 2]))

    const second = await StorageProvider.open(driver)
    expect(await second.getGroup('g1')).toEqual(new Uint8Array([1, 2]))
  })

  it('refuses an unsafe table name rather than interpolating it', () => {
    expect(
      () => new SqlStorageBackend(nodeSqliteDriver(), { tableName: 'x; DROP TABLE y' })
    ).toThrow(/Unsafe table name/)
  })

  it('keeps two clients apart when given different table names', async () => {
    const driver = nodeSqliteDriver()
    const alice = new StorageProvider(new SqlStorageBackend(driver, { tableName: 'alice_store' }))
    const bob = new StorageProvider(new SqlStorageBackend(driver, { tableName: 'bob_store' }))
    await alice.init()
    await bob.init()

    await alice.putGroup('g1', new Uint8Array([1]))

    expect(await bob.getGroup('g1')).toBeUndefined()
    expect(await alice.getGroup('g1')).toEqual(new Uint8Array([1]))
  })
})

/**
 * The intended host is a wallet running several accounts against one local
 * database, so table-and-key namespacing alone is not isolation: `listChats`,
 * `listGroups`, `listKeyPackageRefs` and `listInvites` all enumerate a whole
 * table. Every backend gets the same suite.
 */
const ALICE_KEY = `02${'aa'.repeat(32)}`
const BOB_KEY = `02${'bb'.repeat(32)}`

const isolatesIdentities = (name: string, open: () => Promise<StorageProvider>): void => {
  describe(`identity scoping over ${name}`, () => {
    let alice: StorageProvider
    let bob: StorageProvider

    beforeEach(async () => {
      const shared = await open()
      await shared.init()
      alice = shared.scopeTo(ALICE_KEY)
      bob = shared.scopeTo(BOB_KEY)
    })

    it('reports the identity it is scoped to', () => {
      expect(alice.identityKey).toBe(ALICE_KEY)
      expect(bob.identityKey).toBe(BOB_KEY)
    })

    it('does not leak chats between identities', async () => {
      await alice.putChat({ chatId: 'c1', mlsGroupId: 'aabb', createdAt: 't' })

      expect((await bob.listChats()).map(chat => chat.chatId)).toEqual([])
      expect(await bob.getChat('c1')).toBeUndefined()
      expect((await alice.listChats()).map(chat => chat.chatId)).toEqual(['c1'])
    })

    it('does not resolve chatIdForGroup across identities', async () => {
      await alice.putChat({ chatId: 'c1', mlsGroupId: 'aabb', createdAt: 't' })
      await bob.putChat({ chatId: 'c2', mlsGroupId: 'ccdd', createdAt: 't' })

      expect(await bob.chatIdForGroup('aabb')).toBeUndefined()
      expect(await alice.chatIdForGroup('ccdd')).toBeUndefined()
      expect(await alice.chatIdForGroup('aabb')).toBe('c1')
      expect(await bob.chatIdForGroup('ccdd')).toBe('c2')
    })

    it('does not clobber group state held under the same mlsGroupId', async () => {
      await alice.putGroup('shared', new Uint8Array([1]))
      await bob.putGroup('shared', new Uint8Array([2]))

      expect(await alice.getGroup('shared')).toEqual(new Uint8Array([1]))
      expect(await bob.getGroup('shared')).toEqual(new Uint8Array([2]))
      expect(await alice.listGroups()).toEqual(['shared'])
      expect(await bob.listGroups()).toEqual(['shared'])
    })

    it("does not let one identity delete another's group", async () => {
      await alice.putGroup('shared', new Uint8Array([1]))
      await bob.putGroup('shared', new Uint8Array([2]))

      await bob.deleteGroup('shared')

      expect(await alice.getGroup('shared')).toEqual(new Uint8Array([1]))
      expect(await bob.getGroup('shared')).toBeUndefined()
    })

    it('does not leak KeyPackage refs between identities', async () => {
      await alice.putKeyPackage('a3f1', new Uint8Array([1]) as KeyPackageBytes)

      expect(await bob.listKeyPackageRefs()).toEqual([])
      expect(await bob.getKeyPackage('a3f1')).toBeUndefined()
      expect(await alice.listKeyPackageRefs()).toEqual(['a3f1'])
    })

    it('does not leak invites between identities', async () => {
      await alice.putInvite({
        inviteId: 'i1',
        direction: 'inbound',
        kind: 'keyPackageRequest',
        peer: '02cc',
        requestId: 'r1',
        receivedAt: 't'
      })

      expect(await bob.listInvites()).toEqual([])
      expect(await bob.getInvite('i1')).toBeUndefined()
      expect(await bob.inviteForRequestId('r1')).toBeUndefined()
      expect((await alice.listInvites()).map(invite => invite.inviteId)).toEqual(['i1'])
    })

    it("keeps each identity's pending queue to itself", async () => {
      await alice.queuePending('shared', new Uint8Array([1]))

      expect(await bob.countPending('shared')).toBe(0)
      expect(await bob.takePending('shared')).toEqual([])
      expect(await alice.countPending('shared')).toBe(1)
    })
  })
}

isolatesIdentities('a shared Map', async () => StorageProvider.map(new Map()))
isolatesIdentities('a shared SqlDriver', async () => StorageProvider.sql(nodeSqliteDriver()))
isolatesIdentities('a shared IDBDatabase', async () =>
  StorageProvider.indexedDb(await openDatabase(`scoped-${databaseCount++}`))
)

describe('StorageProvider.scopeTo', () => {
  it('leaves the provider it narrows alone', async () => {
    const map = new Map<string, Uint8Array>()
    const shared = StorageProvider.map(map)

    await shared.scopeTo(ALICE_KEY).putGroup('g1', new Uint8Array([1]))

    expect(shared.identityKey).toBeUndefined()
    expect([...map.keys()]).toEqual([`groups:${ALICE_KEY}/g1`])
  })

  it('is a no-op applied twice for one identity', async () => {
    const map = new Map<string, Uint8Array>()
    const twice = StorageProvider.map(map).scopeTo(ALICE_KEY).scopeTo(ALICE_KEY)

    await twice.putGroup('g1', new Uint8Array([1]))

    expect([...map.keys()]).toEqual([`groups:${ALICE_KEY}/g1`])
    expect(await twice.getGroup('g1')).toEqual(new Uint8Array([1]))
  })

  it('re-narrows rather than nesting when the identity changes', async () => {
    const map = new Map<string, Uint8Array>()
    const rescoped = StorageProvider.map(map).scopeTo(ALICE_KEY).scopeTo(BOB_KEY)

    await rescoped.putGroup('g1', new Uint8Array([1]))

    expect([...map.keys()]).toEqual([`groups:${BOB_KEY}/g1`])
  })

  it('still works alongside a per-client table name', async () => {
    const driver = nodeSqliteDriver()
    const alice = new StorageProvider(
      new SqlStorageBackend(driver, { tableName: 'alice_store' })
    ).scopeTo(ALICE_KEY)
    await alice.init()

    await alice.putGroup('g1', new Uint8Array([1]))

    expect(await alice.getGroup('g1')).toEqual(new Uint8Array([1]))
    expect(await alice.listGroups()).toEqual(['g1'])
  })
})
