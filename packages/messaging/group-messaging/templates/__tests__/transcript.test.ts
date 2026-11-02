/**
 * The transcript, and the ordering that stops a read beating its write.
 *
 * The race is the reason this template exists, so it is tested against the
 * real client over a real `node:sqlite` driver rather than against a fake that
 * would resolve in the order the test wanted.
 */
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { GroupMessagingClient } from '../../src/client.js'
import { nodeSqliteDriver } from '../../src/storage/__tests__/node-sqlite-driver.js'
import { InProcessTransportHub } from '../../src/transport/backends/in-process.js'
import type { MessageContent } from '../../src/content/types.js'
import { Transcript } from '../transcript.js'

const text = (body: string): MessageContent => ({ v: 1, type: 'text', body })

const stored = (over: Record<string, unknown> = {}) => ({
  chatId: 'project',
  id: 'm1',
  sender: '02aa' as never,
  at: 1000,
  content: text('hello'),
  ...over
})

/**
 * `node:sqlite` runs synchronously behind an async facade, so against it every
 * write has already landed by the time its promise settles. That makes a
 * missing `await` and a missing write queue both invisible — which is how the
 * queue came to be deleted as speculative. This wrapper defers each write by a
 * macrotask so the suite can see ordering at all.
 */
const deferringDriver = (inner = nodeSqliteDriver()) => {
  const pending: Array<() => void> = []
  return {
    /**
     * Drains in rounds, releasing whatever is waiting newest-first each time.
     *
     * Rounds matter: a serialised writer only ever has one INSERT in flight,
     * so reversing a single-entry queue is a no-op and arrival order survives.
     * An unserialised one has both waiting at once, and reversing them puts
     * the rowids in the wrong order — which is the defect under test.
     */
    drainReversed: async (until: Promise<unknown>) => {
      let settled = false
      void until.then(
        () => (settled = true),
        () => (settled = true)
      )
      for (let round = 0; round < 50 && !settled; round++) {
        await new Promise(resolve => setTimeout(resolve, 0))
        for (const release of pending.splice(0).reverse()) release()
      }
      return until
    },
    driver: {
      ...inner,
      runAsync: async (sql: string, params?: unknown[]) => {
        await new Promise<void>(resolve => {
          if (/^\s*INSERT/i.test(sql)) pending.push(resolve)
          else setTimeout(resolve, 0)
        })
        return inner.runAsync(sql, params as never)
      }
    } as typeof inner
  }
}

/** Defers every write by one macrotask, without holding any back. */
const slowDriver = (inner = nodeSqliteDriver()) =>
  ({
    ...inner,
    runAsync: async (sql: string, params?: unknown[]) => {
      await new Promise(resolve => setTimeout(resolve, 0))
      return inner.runAsync(sql, params as never)
    }
  }) as typeof inner

const nextEvent = <K extends 'welcomeReceived' | 'inviteReceived' | 'keyPackageReceived'>(
  client: GroupMessagingClient,
  event: K
) =>
  new Promise<Parameters<Parameters<GroupMessagingClient['on']>[1]>[0] & Record<string, never>>(
    resolve => {
      const stop = client.on(event, payload => {
        stop()
        resolve(payload as never)
      })
    }
  )

/** Two clients joined to one chat, so a real message really arrives. */
const chatting = async () => {
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

  const invited = nextEvent(bob, 'inviteReceived')
  await alice.invites.send(bob.identityKey, { chatName: 'Project' })
  const invite = await invited

  const minted = await bob.keyPackages.create()
  const answered = nextEvent(alice, 'keyPackageReceived')
  await bob.invites.accept(invite.inviteId, minted.keyPackage)
  const { keyPackage } = await answered

  const aliceOwn = await alice.keyPackages.create()
  const welcomed = nextEvent(bob, 'welcomeReceived')
  await alice.createGroup({
    chatId: 'project',
    members: [keyPackage],
    name: 'Project',
    privateKeyPackage: aliceOwn.privateKeyPackage
  })
  const welcome = await welcomed
  await bob.joinFromWelcome({
    inviteId: welcome.inviteId,
    chatId: 'project',
    privateKeyPackage: minted.privateKeyPackage
  })

  return {
    alice,
    bob,
    aliceIdentity: alice.identityKey,
    close: async () => {
      await alice.close()
      await bob.close()
    }
  }
}

describe('Transcript', () => {
  it('stores the whole envelope, not just the text', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    const reaction: MessageContent = {
      v: 1,
      type: 'reaction',
      reaction: {
        reference: 'm1',
        content: '👍',
        action: 'added',
        schema: 'unicode'
      }
    }
    await transcript.append(stored({ id: 'm2', content: reaction }))

    const [read] = await transcript.list('project')
    expect(read!.content.type).toBe('reaction')
    expect(read!.content.reaction?.content).toBe('👍')
  })

  it('orders by time, oldest first', async () => {
    // The `id ASC` tiebreak for an equal `at` is deliberately not asserted:
    // SQLite orders equal keys by rowid regardless, so no test here can tell
    // the explicit tiebreak from its absence. It stays in the query as a
    // guarantee rather than a reliance on unspecified behaviour.
    const transcript = await Transcript.open(nodeSqliteDriver())
    await transcript.append(stored({ id: 'late', at: 90 }))
    await transcript.append(stored({ id: 'early', at: 10 }))
    await transcript.append(stored({ id: 'middle', at: 50 }))

    expect((await transcript.list('project')).map(m => m.id)).toEqual(['early', 'middle', 'late'])
  })

  it('keeps chats apart', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    await transcript.append(stored({ id: 'here' }))
    await transcript.append(stored({ id: 'elsewhere', chatId: 'other' }))

    expect((await transcript.list('project')).map(m => m.id)).toEqual(['here'])
  })

  it('needs no migration on a fresh database', async () => {
    // The integration this came from declared a stale schema and ALTERed it on
    // every first open, so the legacy path was the normal one.
    const driver = nodeSqliteDriver()
    await Transcript.open(driver)
    const columns = await driver.getAllAsync<{ name: string }>(
      'PRAGMA table_info(group_messaging_transcript)'
    )
    expect(columns.map(c => c.name).sort()).toEqual(
      ['at', 'body', 'chatId', 'content', 'id', 'messageId', 'sender'].sort()
    )
  })

  it('survives a second open over the same database', async () => {
    const driver = nodeSqliteDriver()
    await (await Transcript.open(driver)).append(stored())
    expect(await (await Transcript.open(driver)).list('project')).toHaveLength(1)
  })

  it('falls back to the body when the stored envelope is unreadable', async () => {
    const driver = nodeSqliteDriver()
    const transcript = await Transcript.open(driver)
    await transcript.append(stored())
    await driver.runAsync(
      "UPDATE group_messaging_transcript SET content = 'not json' WHERE messageId = 'm1'"
    )

    const [read] = await transcript.list('project')
    expect(read!.content.body).toBe('hello')
    expect(read!.content.type).toBe('text')
  })

  it('falls back when the stored envelope is a scalar', async () => {
    // `JSON.parse('null')` succeeds, so without a shape check the catch never
    // fires and the caller gets a non-object where it expects `content.type`.
    const driver = nodeSqliteDriver()
    const transcript = await Transcript.open(driver)
    await transcript.append(stored())
    await driver.runAsync(
      "UPDATE group_messaging_transcript SET content = 'null' WHERE messageId = 'm1'"
    )

    const [read] = await transcript.list('project')
    expect(read!.content.type).toBe('text')
    expect(read!.content.body).toBe('hello')
  })

  it('refuses a table name that is not an identifier', async () => {
    await expect(
      Transcript.open(nodeSqliteDriver(), { tableName: 'x; DROP TABLE y' })
    ).rejects.toThrow(/Unusable table name/)
  })
})

describe('Transcript.record', () => {
  it('keeps a message this device sent, which MLS never echoes back', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver(), { now: () => 7 })
    const saved = await transcript.record({
      chatId: 'project',
      sender: '02me' as never,
      content: text('mine'),
      id: 'what-send-returned'
    })

    expect(saved.at).toBe(7)
    expect((await transcript.list('project')).map(m => m.content.body)).toEqual(['mine'])
  })

  it('keeps the id the send returned, so a reply resolves', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    const saved = await transcript.record({
      chatId: 'project',
      sender: '02me' as never,
      content: text('mine'),
      id: 'chosen'
    })

    expect(saved.id).toBe('chosen')
    expect((await transcript.list('project'))[0]!.id).toBe('chosen')
  })
})

describe('ordering under a driver that actually defers', () => {
  it('writes concurrent appends in the order they were made', async () => {
    // The driver completes the INSERTs in reverse. Without serialisation the
    // rowid tiebreak follows completion order, not arrival order, and the
    // transcript reads backwards.
    const deferring = deferringDriver()
    const transcript = await Transcript.open(deferring.driver)

    const settled = Promise.all([
      transcript.append(stored({ id: 'first', at: 5 })),
      transcript.append(stored({ id: 'second', at: 5 }))
    ])
    await deferring.drainReversed(settled)

    expect((await transcript.list('project')).map(m => m.id)).toEqual(['first', 'second'])
  })

  it('tells listeners in the order the appends were made', async () => {
    const deferring = deferringDriver()
    const transcript = await Transcript.open(deferring.driver)
    const told: string[] = []
    transcript.onAppended(message => told.push(message.id))

    const settled = Promise.all([
      transcript.append(stored({ id: 'first', at: 5 })),
      transcript.append(stored({ id: 'second', at: 5 }))
    ])
    await deferring.drainReversed(settled)

    expect(told).toEqual(['first', 'second'])
  })

  it('has really written the row before it tells anyone', async () => {
    // Against a synchronous driver this passes even with the `await` removed.
    // Against this one it does not.
    const transcript = await Transcript.open(slowDriver())
    const seen: number[] = []
    transcript.onAppended(() => {
      void transcript.list('project').then(all => seen.push(all.length))
    })

    await transcript.append(stored())
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    expect(seen[0]).toBe(1)
  })
})

describe('a write that fails', () => {
  it('reports through onError instead of losing the message silently', async () => {
    const failures: Array<[string, string]> = []
    const transcript = await Transcript.open(
      {
        ...nodeSqliteDriver(),
        runAsync: async (sql: string) => {
          if (/^\s*INSERT/i.test(sql)) throw new Error('database is locked')
          return { changes: 0, lastInsertRowId: 0 }
        }
      } as never,
      { onError: (error, message) => failures.push([message.id, error.message]) }
    )
    const { alice, bob, close } = await chatting()
    transcript.follow(bob)

    const group = await alice.getGroup('project')
    const sent = await group!.sendContent(text('doomed'))

    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]![0]).toBe(sent)
    expect(failures[0]![1]).toMatch(/locked/)

    await close()
  })

  it('raises no unhandled rejection when a follow write fails', async () => {
    const seen: unknown[] = []
    const onUnhandled = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const transcript = await Transcript.open(
        {
          ...nodeSqliteDriver(),
          runAsync: async (sql: string) => {
            if (/^\s*INSERT/i.test(sql)) throw new Error('database is locked')
            return { changes: 0, lastInsertRowId: 0 }
          }
        } as never,
        { onError: () => undefined }
      )
      const { alice, bob, close } = await chatting()
      transcript.follow(bob)

      const group = await alice.getGroup('project')
      await group!.sendContent(text('doomed'))
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(seen).toEqual([])
      await close()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps accepting appends after one has failed', async () => {
    // The write chain must not be poisoned by a rejection.
    let fail = true
    const inner = nodeSqliteDriver()
    const transcript = await Transcript.open({
      ...inner,
      runAsync: async (sql: string, params?: unknown[]) => {
        if (fail && /^\s*INSERT/i.test(sql)) throw new Error('database is locked')
        return inner.runAsync(sql, params as never)
      }
    } as never)

    await expect(transcript.append(stored({ id: 'doomed' }))).rejects.toThrow(/locked/)
    fail = false
    await transcript.append(stored({ id: 'fine' }))

    expect((await transcript.list('project')).map(m => m.id)).toEqual(['fine'])
  })
})

describe('Transcript.follow', () => {
  it('has written the row before it tells anyone', async () => {
    // The defect: the host did `void append()` on one subscription and
    // `void reload()` on another, so the SELECT could beat the INSERT and an
    // arriving message did not render. A listener here re-reads immediately,
    // exactly as that screen did, and must see the message.
    const { alice, bob, close } = await chatting()
    const transcript = await Transcript.open(nodeSqliteDriver())
    transcript.follow(bob)

    const seen: number[] = []
    transcript.onAppended(() => {
      void transcript.list('project').then(all => seen.push(all.length))
    })

    const group = await alice.getGroup('project')
    await group!.sendContent(text('arrived'))

    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toBe(1)

    await close()
  })

  it('stores what actually arrived, through a real client', async () => {
    const { alice, bob, aliceIdentity, close } = await chatting()
    const transcript = await Transcript.open(nodeSqliteDriver())
    transcript.follow(bob)

    const group = await alice.getGroup('project')
    const sent = await group!.sendContent(text('hello there'))

    await vi.waitFor(async () => expect(await transcript.list('project')).toHaveLength(1))
    const [message] = await transcript.list('project')
    expect(message!.content.body).toBe('hello there')
    expect(message!.sender).toBe(aliceIdentity)
    // The id the sender got back, stored by the side that only received it.
    expect(message!.id).toBe(sent)

    await close()
  })

  it('gives every arriving message the id its sender derived', async () => {
    const { alice, bob, close } = await chatting()
    const transcript = await Transcript.open(nodeSqliteDriver())
    transcript.follow(bob)

    const group = await alice.getGroup('project')
    const first = await group!.sendContent(text('one'))
    const second = await group!.sendContent(text('two'))

    await vi.waitFor(async () => expect(await transcript.list('project')).toHaveLength(2))
    expect((await transcript.list('project')).map(m => m.id)).toEqual([first, second])

    await close()
  })

  it('stops appending once unsubscribed', async () => {
    const { alice, bob, close } = await chatting()
    const transcript = await Transcript.open(nodeSqliteDriver())
    const stop = transcript.follow(bob)
    stop()

    const group = await alice.getGroup('project')
    await group!.sendContent(text('after the stop'))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await transcript.list('project')).toEqual([])

    await close()
  })

  it('stops telling a listener that unsubscribed', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    const told: string[] = []
    const stop = transcript.onAppended(message => told.push(message.id))

    await transcript.append(stored({ id: 'before' }))
    stop()
    await transcript.append(stored({ id: 'after' }))

    expect(told).toEqual(['before'])
  })

  it('keeps telling the other listeners when one throws', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    const told: string[] = []
    transcript.onAppended(() => {
      throw new Error('a screen blew up')
    })
    transcript.onAppended(message => told.push(message.id))

    await transcript.append(stored())

    expect(told).toEqual(['m1'])
  })

  it('writes every concurrent append exactly once', async () => {
    const transcript = await Transcript.open(nodeSqliteDriver())
    await Promise.all([
      transcript.append(stored({ id: 'one' })),
      transcript.append(stored({ id: 'two' })),
      transcript.append(stored({ id: 'three' }))
    ])

    expect((await transcript.list('project')).map(m => m.id).sort()).toEqual([
      'one',
      'three',
      'two'
    ])
  })
})
