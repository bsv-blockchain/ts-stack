import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { WelcomeDeliveryError } from '@bsv/group-messaging'
import type { KeyPackageBytes } from '@bsv/group-messaging'
import { describe, expect, it, vi } from 'vitest'
import { decodeEnvelope } from '../../src/bootstrap/index.js'
import { GroupMessagingClient } from '../../src/client.js'
import { InProcessTransportHub } from '../../src/transport/backends/in-process.js'
import {
  ManagedInvitations,
  MemoryShelf,
  type ChatIds,
  type Failure,
  type ShelvedInvitation
} from '../managed-invitations.js'

const open = async (
  hub: InProcessTransportHub,
  key: PrivateKey,
  storage = new Map<string, Uint8Array>()
) =>
  GroupMessagingClient.create({
    wallet: key,
    storage,
    transport: hub.endpoint(new KeyDeriver(key).identityKey)
  })

const ids: ChatIds = { forAnswer: () => 'project', forWelcome: () => 'project' }

/** Records every ref it was handed, so a test can count the mints. */
class RecordingShelf extends MemoryShelf {
  refs: string[] = []
  override async hold(record: ShelvedInvitation) {
    this.refs.push(record.ref)
    return super.hold(record)
  }
}

/** Two clients, Bob's inviteReceived collected, Alice's invitation sent. */
const invited = async () => {
  const hub = new InProcessTransportHub()
  const aliceKey = PrivateKey.fromRandom()
  const bobKey = PrivateKey.fromRandom()
  const alice = await open(hub, aliceKey)
  const bobStorage = new Map<string, Uint8Array>()
  const bob = await open(hub, bobKey, bobStorage)
  const asked: string[] = []
  bob.on('inviteReceived', ({ inviteId }) => void asked.push(inviteId))
  const send = async () => {
    asked.length = 0
    const sent = await alice.invites.send(new KeyDeriver(bobKey).identityKey, {
      chatName: 'Project'
    })
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    return sent
  }
  const close = async () => {
    await alice.close()
    await bob.close()
  }
  return { hub, alice, bob, bobStorage, asked, send, close }
}

/** Drops Welcomes from this client's transport while `down.value` is true. */
const dropWelcomes = (client: GroupMessagingClient, down: { value: boolean }) => {
  const inner = client.transport.send.bind(client.transport)
  client.transport.send = async (to, payload) => {
    const envelope = decodeEnvelope(payload)
    if (down.value && envelope.kind === 'bootstrap' && envelope.message.type === 'welcome') {
      down.value = false
      throw new Error('relay 502')
    }
    await inner(to, payload)
  }
}

describe('the managed-invitations template', () => {
  it('carries one invitation from send to a joined chat on both sides', async () => {
    const { alice, bob, asked, send, close } = await invited()
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    bobSide.start()

    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())
    expect(await alice.getGroup('project')).toBeDefined()

    await close()
  })

  it('does not mint a second half when one invitation is accepted twice', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    bobSide.start()

    await send()
    await bobSide.accept(asked[0]!)
    const second = await bobSide.accept(asked[0]!).catch((cause: unknown) => cause)
    expect(shelf.refs).toHaveLength(1)
    expect(String(second)).toMatch(/already answered/)

    await close()
  })

  it('keeps a lost Welcome reachable and resends it without re-adding', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const dropped = { value: true }
    dropWelcomes(alice, dropped)
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids, f => void failures.push(f)).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    bobSide.start()

    await send()
    await bobSide.accept(asked[0]!)

    // retryDelivery resent the same bytes; Bob joined and the group has two
    // members, not a second Add.
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())
    expect((await (await alice.getGroup('project'))!.info()).members).toHaveLength(2)
    expect(failures).toEqual([])
    expect(dropped.value).toBe(false)

    await close()
  })

  it('admits one leaf when two answers for the same chat arrive together', async () => {
    const { alice, bob, asked, hub, close } = await invited()
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids, failure => failures.push(failure)).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    const carol = await open(hub, PrivateKey.fromRandom())
    const own = await alice.keyPackages.create()
    await alice.createGroup({
      chatId: 'project',
      members: [(await carol.keyPackages.create()).keyPackage],
      privateKeyPackage: own.privateKeyPackage
    })
    const bobKey = bob.identityKey
    asked.length = 0
    await alice.invites.send(bobKey, { chatName: 'Project' })
    await alice.invites.send(bobKey, { chatName: 'Project' })
    await vi.waitFor(() => expect(asked).toHaveLength(2))

    // Both go out before either answer reaches Alice, as a reload mid-admission would.
    await Promise.all(asked.map(async inviteId => bobSide.accept(inviteId)))

    await vi.waitFor(() => expect(failures).toHaveLength(1))
    const members = (await (await alice.getGroup('project'))!.info()).members
    expect(members.filter(member => member.identityKey === bobKey)).toHaveLength(1)
    expect(failures[0]!.reason).toContain('already in')
    await carol.close()
    await close()
  })

  it('refuses a peer the group already has, and says so', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids, f => void failures.push(f)).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    bobSide.start()

    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())

    // MLS would take a second leaf for Bob. Refusing is the template's policy,
    // and the host hears about it.
    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]!.stage).toBe('admit')
    expect((await (await alice.getGroup('project'))!.info()).members).toHaveLength(2)

    await close()
  })

  it('hands the host the undelivered Welcome when the relay stays down', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const inner = alice.transport.send.bind(alice.transport)
    let down = true
    alice.transport.send = async (to, payload) => {
      const envelope = decodeEnvelope(payload)
      if (down && envelope.kind === 'bootstrap' && envelope.message.type === 'welcome') {
        throw new Error('relay 502')
      }
      await inner(to, payload)
    }
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids, f => void failures.push(f)).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    bobSide.start()

    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(() => expect(failures).toHaveLength(1))

    const undelivered = failures[0]!.undelivered
    expect(undelivered).toBeInstanceOf(WelcomeDeliveryError)
    expect(await bob.getGroup('project')).toBeUndefined()

    down = false
    await alice.retryDelivery(undelivered!)
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())

    await close()
  })

  it('treats a join that took as joined even when a later step throws', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, shelf, ids, f => void failures.push(f))
    bobSide.start()

    const realJoin = bob.joinFromWelcome.bind(bob)
    let threw = false
    bob.joinFromWelcome = async input => {
      await realJoin(input)
      threw = true
      throw new Error('step after the join')
    }

    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(() => expect(threw).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(await bob.getGroup('project')).toBeDefined()
    expect(failures).toEqual([])
    // Not put back: a half for a join that took would sit there forever.
    expect(await shelf.take(shelf.refs[0]!)).toBeUndefined()

    await close()
  })

  it('reports a failed join and re-shelves the half when the chat id is already taken', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, shelf, ids, f => void failures.push(f))
    bobSide.start()
    const own = await bob.keyPackages.create()
    await bob.createGroup({
      chatId: 'project',
      members: [],
      privateKeyPackage: own.privateKeyPackage
    })

    await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(() => expect(failures).toHaveLength(1))

    expect(failures[0]!.stage).toBe('join')
    expect(failures[0]!.peer).toBe(alice.identityKey)
    expect(await shelf.take(shelf.refs[0]!)).toBeDefined()

    await close()
  })

  it('reports an answer the library refused', async () => {
    const { hub, alice, bob, asked, send, close } = await invited()
    const carol = await open(hub, PrivateKey.fromRandom())
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids, f => void failures.push(f)).start()

    await send()
    // Bob answers with Carol's KeyPackage.
    await bob.invites.accept(asked[0]!, (await carol.keyPackages.create()).keyPackage)
    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]!.reason).toMatch(/refused/)

    await carol.close()
    await close()
  })

  it('gives the inviter its own invite id and the invitee only the chat name', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const answered: string[] = []
    const named: Array<string | undefined> = []
    new ManagedInvitations(alice, new MemoryShelf(), {
      forAnswer: id => (answered.push(id), 'project'),
      nameFor: () => 'Project',
      forWelcome: () => 'project'
    }).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), {
      forAnswer: () => 'project',
      forWelcome: name => (named.push(name), 'project')
    })
    bobSide.start()

    const sent = await send()
    await bobSide.accept(asked[0]!)
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())

    expect(answered).toEqual([sent])
    expect(named).toEqual(['Project'])

    await close()
  })

  it('keeps the half and resends the same KeyPackage when the answer was delivered but not acknowledged', async () => {
    const { alice, bob, asked, send, close } = await invited()
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const shelf = new RecordingShelf()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    bobSide.start()
    await send()

    const sentPackages: string[] = []
    const inner = bob.transport.send.bind(bob.transport)
    let lose = true
    bob.transport.send = async (to, payload) => {
      const envelope = decodeEnvelope(payload)
      await inner(to, payload)
      if (envelope.kind === 'bootstrap' && envelope.message.type === 'keyPackageResponse') {
        sentPackages.push(Buffer.from(envelope.message.keyPackage).toString('hex'))
        if (lose) {
          lose = false
          throw new Error('ack timed out')
        }
      }
    }
    await expect(bobSide.accept(asked[0]!)).rejects.toThrow('ack timed out')
    await bobSide.accept(asked[0]!)

    expect(shelf.refs).toHaveLength(1)
    expect(sentPackages).toHaveLength(2)
    expect(sentPackages[1]).toBe(sentPackages[0])
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())

    await close()
  })

  it('retires the record and the ref when an answered invitation is abandoned', async () => {
    const { bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    await send()
    await bobSide.accept(asked[0]!)
    expect(await bob.keyPackages.list()).toContain(shelf.refs[0])

    // The answer went out and no Welcome came: the invite row is already gone.
    await bobSide.abandon(asked[0]!)

    expect(await shelf.forInvite(asked[0]!)).toBeUndefined()
    expect(await bob.keyPackages.list()).not.toContain(shelf.refs[0])

    await close()
  })

  it('keeps the record and the ref when giving up fails while the request is still pending', async () => {
    const { bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    await send()
    const inner = bob.transport.send.bind(bob.transport)
    bob.transport.send = async () => {
      throw new Error('relay 502')
    }
    await expect(bobSide.accept(asked[0]!)).rejects.toThrow('relay 502')
    bob.transport.send = inner
    const realAbandon = bob.invites.abandon.bind(bob.invites)
    bob.invites.abandon = async () => {
      throw new Error('storage busy')
    }

    await expect(bobSide.abandon(asked[0]!)).rejects.toThrow('storage busy')
    expect(await shelf.forInvite(asked[0]!)).toBeDefined()
    expect(await bob.keyPackages.list()).toContain(shelf.refs[0])

    bob.invites.abandon = realAbandon
    await bobSide.abandon(asked[0]!)
    expect(await shelf.forInvite(asked[0]!)).toBeUndefined()

    await close()
  })

  it('keeps the record when retiring the ref fails', async () => {
    const { bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    await send()
    await bobSide.accept(asked[0]!)
    bob.keyPackages.retire = async () => {
      throw new Error('storage busy')
    }

    await expect(bobSide.abandon(asked[0]!)).rejects.toThrow('storage busy')

    expect(await shelf.forInvite(asked[0]!)).toBeDefined()
    await close()
  })

  it('ignores a redelivered Welcome while the first join is still running', async () => {
    const handlers = new Map<string, (event: unknown) => void>()
    let release!: () => void
    const joins: unknown[] = []
    const client = {
      on: (event: string, handler: (event: unknown) => void) => {
        handlers.set(event, handler)
        return () => undefined
      },
      keyPackages: {
        create: async () => ({
          ref: 'ref-1',
          keyPackage: new Uint8Array([1]),
          privateKeyPackage: new Uint8Array([2])
        })
      },
      invites: {
        list: async () => [{ inviteId: 'i1', kind: 'keyPackageRequest', peer: 'peer-a' }],
        accept: async () => undefined
      },
      joinFromWelcome: async (input: unknown) => {
        joins.push(input)
        await new Promise<void>(resolve => void (release = resolve))
      },
      getGroup: async () => undefined
    } as unknown as GroupMessagingClient
    const failures: Failure[] = []
    const managed = new ManagedInvitations(
      client,
      new MemoryShelf(),
      ids,
      f => void failures.push(f)
    )
    managed.start()
    await managed.accept('i1')

    const welcome = { inviteId: 'w1', peer: 'peer-a', ref: 'ref-1', chatName: undefined }
    handlers.get('welcomeReceived')!(welcome)
    await vi.waitFor(() => expect(joins).toHaveLength(1))
    handlers.get('welcomeReceived')!({ ...welcome, inviteId: 'w2' })
    await new Promise(resolve => setTimeout(resolve, 20))
    release()

    expect(failures).toEqual([])
    expect(joins).toHaveLength(1)
  })

  it('names the ref when a Welcome arrives and its record is gone', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, shelf, ids, f => void failures.push(f))
    bobSide.start()
    // Lost between accept and the Welcome, as a shelf in another process would be.
    const real = bob.invites.accept.bind(bob.invites)
    bob.invites.accept = async (...args) => {
      await real(...args)
      await shelf.take(shelf.refs[0]!)
    }
    await send()
    await bobSide.accept(asked[0]!)

    await vi.waitFor(() => expect(failures).toHaveLength(1))
    expect(failures[0]).toMatchObject({ stage: 'join', ref: shelf.refs[0] })
    expect(failures[0]!.chatId).toMatch(/^unknown:/)

    await close()
  })

  it('retires the shelved record only on an explicit abandon', async () => {
    const { bob, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const bobSide = new ManagedInvitations(bob, shelf, ids)
    await send()
    bob.transport.send = async () => {
      throw new Error('relay 502')
    }
    await expect(bobSide.accept(asked[0]!)).rejects.toThrow('relay 502')
    expect(await shelf.forInvite(asked[0]!)).toBeDefined()

    await bobSide.abandon(asked[0]!)
    expect(await shelf.forInvite(asked[0]!)).toBeUndefined()

    await close()
  })

  /**
   * Carol holds Bob's public KeyPackage, as any member who saw the Add would, and
   * sends her own Welcome before the genuine one. With `unbind` the library's
   * ref-to-peer binding is removed, so only the template's own check stands.
   */
  const forged = async (unbind: boolean) => {
    const { hub, alice, bob, bobStorage, asked, send, close } = await invited()
    const shelf = new RecordingShelf()
    const failures: Failure[] = []
    const refused: unknown[] = []
    bob.on('bootstrapRefused', e => void refused.push(e))
    const bobSide = new ManagedInvitations(
      bob,
      shelf,
      { ...ids, forWelcome: name => (name === 'Project' ? 'project' : `chat:${name}`) },
      f => void failures.push(f)
    )
    bobSide.start()
    const carol = await open(hub, PrivateKey.fromRandom())

    let offered: KeyPackageBytes | undefined
    const real = bob.invites.accept.bind(bob.invites)
    bob.invites.accept = async (inviteId, keyPackage) => {
      offered = keyPackage
      return real(inviteId, keyPackage)
    }
    await send()
    await bobSide.accept(asked[0]!)
    if (unbind)
      for (const key of bobStorage.keys()) if (key.endsWith('#peer')) bobStorage.delete(key)
    const carolOwn = await carol.keyPackages.create()
    await carol.createGroup({
      chatId: 'evil',
      name: 'Evil',
      members: [offered!],
      privateKeyPackage: carolOwn.privateKeyPackage
    })

    await vi.waitFor(() => expect(unbind ? failures : refused).toHaveLength(1))
    expect(await bob.getGroup('chat:Evil')).toBeUndefined()
    expect(await bob.getGroup('evil')).toBeUndefined()
    expect(await bob.getGroup('project')).toBeUndefined()
    expect(await shelf.peek(shelf.refs[0]!)).toBeDefined()

    const aliceOwn = await alice.keyPackages.create()
    await alice.createGroup({
      chatId: 'project',
      name: 'Project',
      members: [offered!],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })
    await vi.waitFor(async () => expect(await bob.getGroup('project')).toBeDefined())

    await carol.close()
    await close()
    return { failures, refused, carol }
  }

  it('has the library turn away a Welcome from anyone but the peer it answered', async () => {
    const { failures, refused, carol } = await forged(false)
    expect(refused).toEqual([
      expect.objectContaining({
        peer: carol.identityKey,
        kind: 'welcome',
        reason: expect.stringMatching(/different peer/)
      })
    ])
    expect(failures).toEqual([])
  })

  it('refuses a Welcome from anyone but the peer it answered even without the library binding', async () => {
    const { failures, carol } = await forged(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ stage: 'join', peer: carol.identityKey })
    // Neither the chat Carol named nor the one this host chose may be touched.
    expect(failures[0]!.chatId).toMatch(/^refused:/)
  })

  it('reports a shelf that rejects instead of leaking an unhandled rejection', async () => {
    const { alice, bob, asked, send, close } = await invited()
    class DownShelf extends MemoryShelf {
      override async peek(): Promise<never> {
        throw new Error('connection reset')
      }
    }
    const unhandled: unknown[] = []
    const record = (cause: unknown) => void unhandled.push(cause)
    process.on('unhandledRejection', record)
    const failures: Failure[] = []
    new ManagedInvitations(alice, new MemoryShelf(), ids).start()
    const bobSide = new ManagedInvitations(bob, new DownShelf(), ids, f => void failures.push(f))
    bobSide.start()

    try {
      await send()
      await bobSide.accept(asked[0]!)
      await vi.waitFor(() => expect(failures).toHaveLength(1))
      // Give a stray rejection the macrotask turn Node needs to report it.
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(failures[0]).toMatchObject({ stage: 'join' })
      expect(failures[0]!.chatId).toMatch(/^unknown:/)
      expect(failures[0]!.reason).toContain('connection reset')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
      await close()
    }
  })

  it('reports a throwing chatIds callback and survives onFailure throwing too', async () => {
    const { alice, bob, asked, send, close } = await invited()
    const unhandled: unknown[] = []
    const record = (cause: unknown) => void unhandled.push(cause)
    process.on('unhandledRejection', record)
    const failures: Failure[] = []
    let calls = 0
    const broken: ChatIds = {
      forAnswer: () => {
        throw new Error('no such chat')
      },
      forWelcome: () => 'project'
    }
    new ManagedInvitations(alice, new MemoryShelf(), broken, f => {
      failures.push(f)
      if (++calls === 1) throw new Error('reporter down')
    }).start()
    const bobSide = new ManagedInvitations(bob, new MemoryShelf(), ids)
    bobSide.start()

    try {
      await send()
      await bobSide.accept(asked[0]!)
      await vi.waitFor(() => expect(failures.length).toBeGreaterThan(0))
      await new Promise(resolve => setTimeout(resolve, 20))

      expect(failures[0]!.reason).toContain('no such chat')
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', record)
      await close()
    }
  })
})
