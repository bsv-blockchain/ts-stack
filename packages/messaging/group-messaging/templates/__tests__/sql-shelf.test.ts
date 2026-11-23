/**
 * The shelf that outlives the client.
 *
 * The last test is the counterfactual of `host-lifecycle.test.ts`'s third
 * characterisation: same reopen in the same window, and the join completes
 * instead of reporting that the private half is gone.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { decodeEnvelope } from '../../src/bootstrap/index.js'
import { GroupMessagingClient } from '../../src/client.js'
import type { SqlDriver } from '../../src/storage/backends/sql.js'
import { nodeSqliteDriver } from '../../src/storage/__tests__/node-sqlite-driver.js'
import { InProcessTransportHub } from '../../src/transport/backends/in-process.js'
import {
  ManagedInvitations,
  MemoryShelf,
  type ChatIds,
  type Failure,
  type ShelvedInvitation
} from '../managed-invitations.js'
import { SqlShelf } from '../sql-shelf.js'

const ids: ChatIds = { forAnswer: () => 'project', forWelcome: () => 'project' }

const record = (over: Partial<ShelvedInvitation> = {}): ShelvedInvitation =>
  ({
    ref: 'ref-1',
    inviteId: 'invite-1',
    peer: '02aa',
    chatId: 'project',
    half: new Uint8Array([1, 2, 3, 250, 251]),
    keyPackage: new Uint8Array([9, 8, 7]),
    ...over
  }) as ShelvedInvitation

describe('SqlShelf', () => {
  it('returns the half byte for byte', async () => {
    // It is key material. A driver that mangles a BLOB loses the join, and a
    // truncation would be invisible until a Welcome failed to decrypt.
    const shelf = await SqlShelf.open(nodeSqliteDriver())
    const held = record({ half: new Uint8Array([0, 255, 128, 1, 0]) as never })
    await shelf.hold(held)

    const read = await shelf.peek('ref-1')
    expect(Array.from(read!.half)).toEqual([0, 255, 128, 1, 0])
    expect(read!.peer).toBe('02aa')
    expect(read!.chatId).toBe('project')
    expect(Array.from(read!.keyPackage)).toEqual([9, 8, 7])
  })

  it('finds a record by its invite id', async () => {
    const shelf = await SqlShelf.open(nodeSqliteDriver())
    await shelf.hold(record())

    expect((await shelf.forInvite('invite-1'))?.ref).toBe('ref-1')
    expect(await shelf.forInvite('nope')).toBeUndefined()
  })

  it('peeks without removing and takes with removing', async () => {
    const shelf = await SqlShelf.open(nodeSqliteDriver())
    await shelf.hold(record())

    expect(await shelf.peek('ref-1')).toBeDefined()
    expect(await shelf.peek('ref-1')).toBeDefined()
    expect(await shelf.take('ref-1')).toBeDefined()
    expect(await shelf.take('ref-1')).toBeUndefined()
    expect(await shelf.peek('ref-1')).toBeUndefined()
  })

  it('replaces rather than duplicates when one ref is held twice', async () => {
    // `accept` resends the same bytes on retry; that is one answer, not two.
    const driver = nodeSqliteDriver()
    const shelf = await SqlShelf.open(driver)
    await shelf.hold(record())
    await shelf.hold(record({ chatId: 'renamed' }))

    const rows = await driver.getAllAsync('SELECT ref FROM group_messaging_private_halves')
    expect(rows).toHaveLength(1)
    expect((await shelf.peek('ref-1'))?.chatId).toBe('renamed')
  })

  it('survives being reopened over the same database', async () => {
    const driver = nodeSqliteDriver()
    await (await SqlShelf.open(driver)).hold(record())

    // A second open is what the host does on every client open.
    const reopened = await SqlShelf.open(driver)
    expect((await reopened.forInvite('invite-1'))?.ref).toBe('ref-1')
  })

  it('reaps halves older than the cutoff and keeps the rest', async () => {
    let now = 1_000_000
    const shelf = await SqlShelf.open(nodeSqliteDriver(), { now: () => now })
    await shelf.hold(record({ ref: 'old', inviteId: 'old' }))
    now += 10 * 24 * 60 * 60 * 1000
    await shelf.hold(record({ ref: 'fresh', inviteId: 'fresh' }))

    expect(await shelf.reap()).toBe(1)
    expect(await shelf.peek('old')).toBeUndefined()
    expect(await shelf.peek('fresh')).toBeDefined()
  })

  it('refuses a table name that is not an identifier', async () => {
    await expect(
      SqlShelf.open(nodeSqliteDriver(), { tableName: 'halves; DROP TABLE x' })
    ).rejects.toThrow(/Unusable table name/)
  })

  it('keeps two identities apart when each is given its own table', async () => {
    const driver = nodeSqliteDriver()
    const first = await SqlShelf.open(driver, { tableName: 'halves_a' })
    const second = await SqlShelf.open(driver, { tableName: 'halves_b' })

    await first.hold(record())

    expect(await first.peek('ref-1')).toBeDefined()
    expect(await second.peek('ref-1')).toBeUndefined()
  })

  it('lets only one of two concurrent takes win', async () => {
    // `#retire` (decline/abandon) and an arriving Welcome both call `take`,
    // inside one client, with nothing guarding them against each other. Two
    // winners means the user declines and the chat is joined anyway.
    const shelf = await SqlShelf.open(nodeSqliteDriver())
    await shelf.hold(record())

    const [first, second] = await Promise.all([shelf.take('ref-1'), shelf.take('ref-1')])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('agrees with MemoryShelf that only one take wins', async () => {
    // The behaviour being matched, so the two shelves are interchangeable.
    const memory = new MemoryShelf()
    await memory.hold(record())

    const [first, second] = await Promise.all([memory.take('ref-1'), memory.take('ref-1')])

    expect([first, second].filter(Boolean)).toHaveLength(1)
  })

  it('does not restart the reap clock when the same ref is held again', async () => {
    // A retried `accept` holds the same ref a second time. That is one
    // shelving, so it ages on the original clock; otherwise a half that keeps
    // being retried never reaches `reap`.
    let now = 1_000_000
    const shelf = await SqlShelf.open(nodeSqliteDriver(), { now: () => now })
    await shelf.hold(record())

    now += 6 * 24 * 60 * 60 * 1000
    await shelf.hold(record())

    now += 2 * 24 * 60 * 60 * 1000
    expect(await shelf.reap()).toBe(1)
    expect(await shelf.peek('ref-1')).toBeUndefined()
  })

  it('gives a record taken and shelved again a fresh clock', async () => {
    // The re-shelve after a failed join takes first, so it is a new shelving
    // of an actively retried half — documented, not incidental.
    let now = 1_000_000
    const shelf = await SqlShelf.open(nodeSqliteDriver(), { now: () => now })
    await shelf.hold(record())

    now += 6 * 24 * 60 * 60 * 1000
    await shelf.take('ref-1')
    await shelf.hold(record())

    now += 2 * 24 * 60 * 60 * 1000
    expect(await shelf.reap()).toBe(0)
    expect(await shelf.peek('ref-1')).toBeDefined()
  })

  it('still updates the rest of the record on a re-shelve', async () => {
    const shelf = await SqlShelf.open(nodeSqliteDriver())
    await shelf.hold(record())
    await shelf.hold(record({ chatId: 'renamed', peer: '02bb' }))

    const read = await shelf.peek('ref-1')
    expect(read?.chatId).toBe('renamed')
    expect(read?.peer).toBe('02bb')
  })

  it('returns the oldest record for an invite id, as MemoryShelf does', async () => {
    // The explicit ORDER BY is deliberately not asserted on its own: the
    // upsert preserves the rowid, so insertion order and `heldAt` order never
    // disagree here and no test can tell the clause from its absence. It stays
    // in the query as a guarantee rather than a reliance on the query plan.
    // What this does check is that both shelves answer the same way.
    let now = 1000
    const sql = await SqlShelf.open(nodeSqliteDriver(), { now: () => now })
    const memory = new MemoryShelf()
    for (const shelf of [sql, memory]) {
      await shelf.hold(record({ ref: 'ref-z' }))
      now += 5000
      await shelf.hold(record({ ref: 'ref-a' }))
    }

    expect((await sql.forInvite('invite-1'))?.ref).toBe('ref-z')
    expect((await memory.forInvite('invite-1'))?.ref).toBe('ref-z')
  })

  it('refuses a BLOB the driver handed back as a string', async () => {
    // Silently zero-length key material is the alternative, and it fails much
    // later, inside MLS, pointing nowhere near the shelf.
    const inner = nodeSqliteDriver()
    const shelf = await SqlShelf.open({
      ...inner,
      getFirstAsync: async (sql: string, params?: unknown[]) => {
        const row = (await inner.getFirstAsync(sql, params as never)) as Record<string, unknown>
        return row === null ? null : { ...row, half: 'AQID' }
      }
    } as never)
    await shelf.hold(record())

    await expect(shelf.peek('ref-1')).rejects.toThrow(/BLOB as a string/)
  })

  it('accepts a BLOB the driver handed back as a plain array', async () => {
    const inner = nodeSqliteDriver()
    const shelf = await SqlShelf.open({
      ...inner,
      getFirstAsync: async (sql: string, params?: unknown[]) => {
        const row = (await inner.getFirstAsync(sql, params as never)) as Record<string, unknown>
        return row === null ? null : { ...row, half: Array.from(row.half as Uint8Array) }
      }
    } as never)
    await shelf.hold(record({ half: new Uint8Array([4, 5, 6]) as never }))

    expect(Array.from((await shelf.peek('ref-1'))!.half)).toEqual([4, 5, 6])
  })

  it('completes the join across the reopen that loses it with MemoryShelf', async () => {
    const hub = new InProcessTransportHub()
    const aliceKey = PrivateKey.fromRandom()
    const bobKey = PrivateKey.fromRandom()
    const open = async (key: PrivateKey) =>
      GroupMessagingClient.create({
        wallet: key,
        storage: new Map(),
        transport: hub.endpoint(new KeyDeriver(key).identityKey)
      })
    const alice = await open(aliceKey)
    const bob = await open(bobKey)

    const asked: string[] = []
    bob.on('inviteReceived', ({ inviteId }) => void asked.push(inviteId))
    await alice.invites.send(new KeyDeriver(bobKey).identityKey, { chatName: 'Project' })
    await vi.waitFor(() => expect(asked).toHaveLength(1))

    // Hold Alice's Welcome in flight, exactly as the characterisation does.
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

    // Bob's shelf is backed by his database, which the reopen does not rebuild.
    const bobDatabase: SqlDriver = nodeSqliteDriver()
    const before = new ManagedInvitations(bob, await SqlShelf.open(bobDatabase), ids)
    const stopBefore = before.start()
    await before.accept(asked[0]!)
    await vi.waitFor(() => expect(held).toHaveLength(1))

    stopBefore()
    const failures: Failure[] = []
    new ManagedInvitations(
      bob,
      await SqlShelf.open(bobDatabase),
      ids,
      f => void failures.push(f)
    ).start()

    await held[0]!()

    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())
    expect(failures).toEqual([])

    await alice.close()
    await bob.close()
  })
})
