/**
 * What the first real host integration got wrong, reproduced.
 *
 * `bsv-wallet` is the first application to drive `@bsv/group-messaging` from a
 * UI. Reviewing that branch turned up three defects that look unrelated — a
 * cache key missing a field, a missing `try`/`catch`, two screens disagreeing
 * about an argument — and are one thing: **nobody owns the client's lifetime.**
 * The host spread it across a module-scoped pair of `let`s and two components
 * that each decided when to open and close.
 *
 * These are characterisations, not aspirations. Each one asserts the broken
 * outcome, because the broken outcome is what the naive host pattern actually
 * produces and the reason the lifecycle belongs in a template rather than in
 * every host's head. When a template lands, its own tests assert the opposite.
 *
 * The library is not at fault in any of the three. It exposes `identityKey`, so
 * a mismatched cached client is detectable; `close()`, so teardown is possible;
 * and `retryDelivery`, so a lost Welcome is recoverable. The host used none of
 * them, which is the point: a correct integration is reachable and nobody
 * reached it unaided.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { decodeEnvelope } from '../../src/bootstrap/index.js'
import { GroupMessagingClient } from '../../src/client.js'
import type { SqlBindValue, SqlDriver, SqlRunResult } from '../../src/storage/backends/sql.js'
import { InProcessTransportHub } from '../../src/transport/backends/in-process.js'
import {
  ManagedInvitations,
  MemoryShelf,
  type ChatIds,
  type Failure
} from '../managed-invitations.js'

const ids: ChatIds = { forAnswer: () => 'project', forWelcome: () => 'project' }

const open = async (hub: InProcessTransportHub, key: PrivateKey, storage: unknown) =>
  GroupMessagingClient.create({
    wallet: key,
    storage: storage as never,
    transport: hub.endpoint(new KeyDeriver(key).identityKey)
  })

/**
 * The wallet's cache, copied in shape from
 * `useMessagingPlayground.ts:80-81,114`. Module-scoped by construction there;
 * function-scoped here so each test gets its own.
 */
const makeHostCache = () => {
  let opened: Promise<GroupMessagingClient> | undefined
  let openedFor: string | undefined
  return {
    openOnce(key: string, make: () => Promise<GroupMessagingClient>) {
      if (opened !== undefined && openedFor === key) return opened
      openedFor = key
      opened = make()
      return opened
    }
  }
}

describe('a client cache keyed without the identity', () => {
  it("hands the second identity the first identity's client and chats", async () => {
    const hub = new InProcessTransportHub()
    const alice = PrivateKey.fromRandom()
    const bob = PrivateKey.fromRandom()
    const cache = makeHostCache()

    // The key the wallet computes: `${chain}:${host ?? ''}`. No identity in it.
    const first = await cache.openOnce('main:', () => open(hub, alice, new Map()))
    const minted = await first.keyPackages.create()
    await first.createGroup({
      chatId: 'alices-chat',
      members: [],
      privateKeyPackage: minted.privateKeyPackage
    })

    // A different identity asks for its client. Same key, so it gets Alice's.
    const second = await cache.openOnce('main:', () => open(hub, bob, new Map()))

    expect(second).toBe(first)
    expect(second.identityKey).toBe(new KeyDeriver(alice).identityKey)
    expect(second.identityKey).not.toBe(new KeyDeriver(bob).identityKey)
    // Bob's screen renders Alice's chat list.
    expect((await second.listGroups()).map(group => group.chatId)).toEqual(['alices-chat'])

    await first.close()
  })

  it('is detectable: the client says whose it is', async () => {
    // Why this is a host bug rather than a library gap, and what the template
    // will assert on.
    const hub = new InProcessTransportHub()
    const alice = PrivateKey.fromRandom()
    const client = await open(hub, alice, new Map())

    expect(client.identityKey).toBe(new KeyDeriver(alice).identityKey)

    await client.close()
  })
})

/** A driver that fails the first statement, as a locked or corrupt file would. */
const failingDriver = (): { driver: SqlDriver; isOpen: () => boolean; close: () => void } => {
  const db = new DatabaseSync(':memory:')
  let open = true
  return {
    isOpen: () => open,
    close: () => {
      if (open) db.close()
      open = false
    },
    driver: {
      async execAsync(): Promise<void> {
        throw new Error('database is locked')
      },
      async runAsync(sql: string, params: SqlBindValue[] = []): Promise<SqlRunResult> {
        const result = db.prepare(sql).run(...params.map(toBind))
        return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) }
      },
      async getAllAsync<T>(sql: string, params: SqlBindValue[] = []): Promise<T[]> {
        return db.prepare(sql).all(...params.map(toBind)) as T[]
      },
      async getFirstAsync<T>(sql: string, params: SqlBindValue[] = []): Promise<T | null> {
        return (db.prepare(sql).get(...params.map(toBind)) as T | undefined) ?? null
      }
    }
  }
}

const toBind = (value: SqlBindValue) => (typeof value === 'boolean' ? (value ? 1 : 0) : value)

describe('an open that fails after the host acquired the database', () => {
  it('leaves the handle open, because only the success path builds a close', async () => {
    const hub = new InProcessTransportHub()
    const key = PrivateKey.fromRandom()
    const database = failingDriver()

    // The host's open, in the shape of `playground.ts:211-239`: acquire the
    // database, then do work that can throw, and only then construct the
    // `close` that would release it.
    const openPlayground = async () => {
      const client = await open(hub, key, database.driver)
      return {
        client,
        close: async () => {
          await client.close()
          database.close()
        }
      }
    }

    await expect(openPlayground()).rejects.toThrow(/locked/)

    // Nobody holds a reference to it any more, and nothing closed it.
    expect(database.isOpen()).toBe(true)

    database.close()
  })

  it('the library never closes what the host handed it', async () => {
    // `SqlDriver` has no `close()` — four methods, all queries. Releasing the
    // handle is the host's job and the library has no hook for it, which is why
    // the `try`/`catch` has to live in the host's open.
    const database = failingDriver()
    expect(Object.keys(database.driver).sort()).toEqual([
      'execAsync',
      'getAllAsync',
      'getFirstAsync',
      'runAsync'
    ])
    database.close()
  })
})

describe('a shelf that does not outlive the client', () => {
  it('loses an answered invitation when the host reopens between accept and Welcome', async () => {
    const hub = new InProcessTransportHub()
    const aliceKey = PrivateKey.fromRandom()
    const bobKey = PrivateKey.fromRandom()
    const alice = await open(hub, aliceKey, new Map())
    const bobStorage = new Map<string, Uint8Array>()
    const bob = await open(hub, bobKey, bobStorage)

    const asked: string[] = []
    bob.on('inviteReceived', ({ inviteId }) => void asked.push(inviteId))
    await alice.invites.send(new KeyDeriver(bobKey).identityKey, { chatName: 'Project' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))

    // Alice is listening throughout; her Welcome is held in flight so the
    // reopen lands in the window between the answer and its Welcome. That
    // window is seconds wide in practice — one relay round trip.
    const held: Array<() => Promise<void>> = []
    const send = alice.transport.send.bind(alice.transport)
    alice.transport.send = async (to, payload) => {
      const envelope = decodeEnvelope(payload)
      if (envelope.kind === 'bootstrap' && envelope.message.type === 'welcome') {
        held.push(() => send(to, payload))
        return
      }
      await send(to, payload)
    }
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()

    // Bob accepts. The private half goes on this ManagedInvitations' shelf.
    const beforeShelf = new MemoryShelf()
    const before = new ManagedInvitations(bob, beforeShelf, ids)
    const stopBefore = before.start()
    await before.accept(asked[0]!)
    expect(await beforeShelf.forInvite(asked[0]!)).toBeDefined()
    await vi.waitFor(() => expect(held).toHaveLength(1))

    // The host reopens — a relay Save, a navigation that re-keys the cache, a
    // reset. `new MemoryShelf()` is rebuilt with the client, so the half is
    // gone before the Welcome it was waiting for arrives.
    stopBefore()
    const afterShelf = new MemoryShelf()
    const failures: Failure[] = []
    new ManagedInvitations(bob, afterShelf, ids, f => void failures.push(f)).start()
    expect(await afterShelf.forInvite(asked[0]!)).toBeUndefined()

    await held[0]!()

    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]!.reason).toBe('the private half is gone')
    expect(await bob.getGroup('project')).toBeUndefined()

    await alice.close()
    await bob.close()
  })
})
