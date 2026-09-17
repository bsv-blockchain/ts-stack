import 'fake-indexeddb/auto'
import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeEnvelope, encodeEnvelope, EnvelopeError } from '../bootstrap/index.js'
import { GroupMessagingClient } from '../client.js'
import { GroupMessagingError, isPermanent } from '../errors.js'
import { nodeSqliteDriver } from '../storage/__tests__/node-sqlite-driver.js'
import { openDatabase } from '../storage/backends/indexeddb.js'
import { InProcessTransportHub } from '../transport/backends/in-process.js'
import { DEFAULT_CIPHERSUITE, type IdentityKey } from '../types.js'

const hub = new InProcessTransportHub()

const openClient = async (
  storage: Parameters<typeof GroupMessagingClient.create>[0]['storage'],
  wallet = new KeyDeriver(PrivateKey.fromRandom())
): Promise<GroupMessagingClient> =>
  GroupMessagingClient.create({
    wallet,
    storage,
    transport: hub.endpoint(wallet.identityKey)
  })

describe('GroupMessagingClient.create', () => {
  it('wires every layer from one call', async () => {
    const wallet = new KeyDeriver(PrivateKey.fromRandom())
    const client = await openClient('memory', wallet)

    expect(client.identityKey).toBe(wallet.identityKey)
    expect(client.ciphersuite).toBe(DEFAULT_CIPHERSUITE)
    expect(client.identity.identityKey).toBe(wallet.identityKey)
    expect(client.engine.ciphersuite).toBe(DEFAULT_CIPHERSUITE)

    await client.close()
  })

  it('takes a bare PrivateKey as the wallet', async () => {
    const root = PrivateKey.fromRandom()
    const client = await GroupMessagingClient.create({
      wallet: root,
      storage: 'memory',
      transport: hub.endpoint(root.toPublicKey().toString())
    })

    expect(client.identityKey).toBe(root.toPublicKey().toString())
    await client.close()
  })

  it('takes a Map as storage and writes into it', async () => {
    const map = new Map<string, Uint8Array>()
    const client = await openClient(map)

    await client.storage.putGroup('g1', new Uint8Array([1]))

    // Keys carry the client's identity: one host database, many accounts.
    expect([...map.keys()]).toEqual([`groups:${client.identityKey}/g1`])
    await client.close()
  })

  it('takes a SqlDriver as storage and creates its table', async () => {
    const driver = nodeSqliteDriver()
    const client = await openClient(driver)

    await client.storage.putGroup('g1', new Uint8Array([1]))

    expect(await driver.getAllAsync('SELECT namespace, key FROM group_messaging_store')).toEqual([
      { namespace: 'groups', key: `${client.identityKey}/g1` }
    ])
    await client.close()
  })

  it('takes an IDBDatabase as storage', async () => {
    const client = await openClient(await openDatabase('client-test'))
    await client.storage.putGroup('g1', new Uint8Array([1]))
    expect(await client.storage.getGroup('g1')).toEqual(new Uint8Array([1]))
    await client.close()
  })

  it('honours an explicit ciphersuite', async () => {
    const wallet = new KeyDeriver(PrivateKey.fromRandom())
    const client = await GroupMessagingClient.create({
      wallet,
      storage: 'memory',
      transport: hub.endpoint(wallet.identityKey),
      ciphersuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
    })

    expect(client.ciphersuite).toBe('MLS_128_DHKEMP256_AES128GCM_SHA256_P256')
    await client.close()
  })
})

/** A chat record over some stored bytes, without doing any MLS work. */
const fakeChat = async (
  client: GroupMessagingClient,
  chatId: string,
  mlsGroupId: string
): Promise<void> => {
  await client.storage.putChat({ chatId, mlsGroupId, createdAt: new Date().toISOString() })
  await client.storage.putGroup(mlsGroupId, new Uint8Array([1]))
}

describe('GroupMessagingClient groups', () => {
  it('lists chats this device holds state for', async () => {
    const client = await openClient('memory')
    await fakeChat(client, 'c1', 'g1')
    await fakeChat(client, 'c2', 'g2')
    // A chat whose MLS state is gone is not a group this client can use.
    await client.storage.putChat({
      chatId: 'c3',
      mlsGroupId: 'g3',
      createdAt: new Date().toISOString()
    })

    const groups = await client.listGroups()

    expect(groups.map(group => group.chatId).sort()).toEqual(['c1', 'c2'])
    expect(groups.map(group => group.mlsGroupId).sort()).toEqual(['g1', 'g2'])
    await client.close()
  })

  it('returns undefined for a chat it has no state for', async () => {
    const client = await openClient('memory')
    expect(await client.getGroup('missing')).toBeUndefined()
    await client.close()
  })

  it('deletes a chat, its group and its pending queue', async () => {
    const client = await openClient('memory')
    await fakeChat(client, 'c1', 'g1')
    await client.storage.queuePending('g1', new Uint8Array([9]))

    const group = await client.getGroup('c1')
    await group!.delete()

    expect(await client.storage.getChat('c1')).toBeUndefined()
    expect(await client.storage.getGroup('g1')).toBeUndefined()
    expect(await client.storage.countPending('g1')).toBe(0)
    await client.close()
  })

  it('refuses to reuse a chatId', async () => {
    const client = await openClient('memory')
    const minted = await client.keyPackages.create()
    await client.createGroup({
      chatId: 'c1',
      members: [],
      privateKeyPackage: minted.privateKeyPackage
    })

    await expect(
      client.createGroup({
        chatId: 'c1',
        members: [],
        privateKeyPackage: minted.privateKeyPackage
      })
    ).rejects.toThrow(/already exists/)

    await client.close()
  })
})

describe('KeyPackages', () => {
  it('keeps the public half by ref and hands the private half back', async () => {
    const client = await openClient('memory')

    const minted = await client.keyPackages.create()

    expect(await client.keyPackages.list()).toEqual([minted.ref])
    expect(await client.keyPackages.get(minted.ref)).toEqual(minted.keyPackage)
    expect(minted.privateKeyPackage.length).toBeGreaterThan(0)
    await client.close()
  })

  it('creates a group at epoch 0 from a minted pair', async () => {
    const client = await openClient('memory')
    const minted = await client.keyPackages.create()

    const group = await client.createGroup({
      chatId: 'c1',
      members: [],
      name: 'Solo',
      privateKeyPackage: minted.privateKeyPackage
    })

    const info = await group.info()
    expect(info.chatId).toBe('c1')
    expect(info.name).toBe('Solo')
    expect(info.epoch).toBe(0n)
    expect(info.members.map(member => member.identityKey)).toEqual([client.identityKey])
    await client.close()
  })

  it('picks the KeyPackage the private half belongs to, not the first stored', async () => {
    const client = await openClient('memory')
    const first = await client.keyPackages.create()
    const second = await client.keyPackages.create()
    expect(second.keyId).not.toBe(first.keyId)

    const group = await client.createGroup({
      chatId: 'c1',
      members: [],
      privateKeyPackage: second.privateKeyPackage
    })

    // The leaf carries the credential minted with the SECOND pair. Picking the
    // only-stored ref, or the first, would build the group on the other leaf.
    const info = await group.info()
    expect(info.members).toHaveLength(1)
    expect(info.members[0]?.keyId).toBe(second.keyId)
    // Spending retires, so the survivor names which one was picked.
    expect(await client.keyPackages.list()).toEqual([first.ref])
    await client.close()
  })

  it('ignores a stored KeyPackage minted for another ciphersuite', async () => {
    const client = await openClient('memory')
    // Answering an invitation that asks for the other suite is a supported
    // path, and it stores into the same namespace as everything else.
    await client.keyPackages.create({
      ciphersuite: 'MLS_128_DHKEMP256_AES128GCM_SHA256_P256'
    })
    const own = await client.keyPackages.create()

    const group = await client.createGroup({
      chatId: 'c1',
      members: [],
      privateKeyPackage: own.privateKeyPackage
    })

    expect((await group.info()).members[0]?.keyId).toBe(own.keyId)
    await client.close()
  })

  it('refuses a private KeyPackage whose public half it never stored', async () => {
    const client = await openClient('memory')
    const other = await openClient('memory')
    const stranger = await other.keyPackages.create()
    await client.keyPackages.create()

    await expect(
      client.createGroup({
        chatId: 'c1',
        members: [],
        privateKeyPackage: stranger.privateKeyPackage
      })
    ).rejects.toThrow(/No stored KeyPackage matches/)

    await client.close()
    await other.close()
  })
})

describe('inbound routing', () => {
  it('refuses a bootstrap envelope with no sender', async () => {
    const client = await openClient('memory')
    const payload = encodeEnvelope({
      kind: 'bootstrap',
      message: { type: 'keyPackageDecline', requestId: 'r1' }
    })

    await expect(client.processIncoming(payload)).rejects.toThrow(/needs a sender/)
    await client.close()
  })

  it('refuses an MLS payload it cannot route', async () => {
    const client = await openClient('memory')
    const payload = encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1, 2, 3]) })

    await expect(client.processIncoming(payload, 'peer')).rejects.toThrow(GroupMessagingError)
    await client.close()
  })

  it('treats bytes that are not a library envelope as a permanent failure', async () => {
    const client = await openClient('memory')
    const payload = new TextEncoder().encode('from Alice')

    let caught: unknown
    try {
      await client.processIncoming(payload)
    } catch (error) {
      caught = error
    }

    // These bytes will never parse; a retry cannot change that, and the
    // original EnvelopeError stays reachable via `cause` for an operator.
    expect(isPermanent(caught)).toBe(true)
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(EnvelopeError)
    await client.close()
  })
})

describe('two clients over one hub', () => {
  it('delivers bytes between them, queueing while one is offline', async () => {
    const aliceWallet = new KeyDeriver(PrivateKey.fromRandom())
    const bobWallet = new KeyDeriver(PrivateKey.fromRandom())
    const alice = await openClient('memory', aliceWallet)
    const bob = await openClient('memory', bobWallet)

    const received: Array<{ from: IdentityKey; byte: number }> = []
    bob.transport.onMessage((from, payload) => {
      const envelope = decodeEnvelope(payload)
      if (envelope.kind === 'mls') received.push({ from, byte: envelope.payload[0]! })
    })

    hub.goOffline(bobWallet.identityKey)
    await alice.transport.send(
      bobWallet.identityKey,
      encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1]) })
    )
    await alice.transport.send(
      bobWallet.identityKey,
      encodeEnvelope({ kind: 'mls', payload: new Uint8Array([2]) })
    )
    expect(received).toEqual([])

    await hub.goOnline(bobWallet.identityKey)

    expect(received).toEqual([
      { from: aliceWallet.identityKey, byte: 1 },
      { from: aliceWallet.identityKey, byte: 2 }
    ])

    await alice.close()
    await bob.close()
  })
})

describe('event subscribers', () => {
  it('isolates a throwing listener and reports it as processingFailed', async () => {
    const client = await openClient('memory')
    const seen: string[] = []
    const failures: Error[] = []
    client.on('processingFailed', ({ error }) => failures.push(error))
    client.on('inviteDeclined', () => {
      throw new Error('listener blew up')
    })
    client.on('inviteDeclined', ({ inviteId }) => seen.push(inviteId))

    client.emit('inviteDeclined', { inviteId: 'i1', peer: '02aa' })

    expect(seen).toEqual(['i1'])
    expect(failures.map(error => error.message)).toEqual(['listener blew up'])
    await client.close()
  })
})

describe('two clients over one database', () => {
  /**
   * The intended host is a wallet with several accounts and one local database.
   * Storage is scoped to the client's own identity, so neither account can see,
   * overwrite or enumerate the other's records.
   */
  const openPair = async (): Promise<{
    map: Map<string, Uint8Array>
    alice: GroupMessagingClient
    bob: GroupMessagingClient
  }> => {
    const map = new Map<string, Uint8Array>()
    return {
      map,
      alice: await openClient(map),
      bob: await openClient(map)
    }
  }

  it('keeps chats, groups and KeyPackage refs apart', async () => {
    const { alice, bob } = await openPair()

    const aliceOwn = await alice.keyPackages.create()
    const aliceGroup = await alice.createGroup({
      chatId: 'shared-chat-id',
      members: [],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })
    // The same chatId is not taken: it is Alice's, not the database's.
    const bobOwn = await bob.keyPackages.create()
    const bobGroup = await bob.createGroup({
      chatId: 'shared-chat-id',
      members: [],
      privateKeyPackage: bobOwn.privateKeyPackage
    })
    const aliceSpare = await alice.keyPackages.create()
    const bobSpare = await bob.keyPackages.create()

    expect((await alice.listGroups()).map(group => group.mlsGroupId)).toEqual([
      aliceGroup.mlsGroupId
    ])
    expect((await bob.listGroups()).map(group => group.mlsGroupId)).toEqual([bobGroup.mlsGroupId])
    // Founding spent both, so keep an unspent pair each: the point here is
    // that one database does not let two identities see each other's refs.
    expect(await alice.keyPackages.list()).toEqual([aliceSpare.ref])
    expect(await bob.keyPackages.list()).toEqual([bobSpare.ref])
    expect(await alice.storage.chatIdForGroup(bobGroup.mlsGroupId)).toBeUndefined()
    expect(await bob.storage.chatIdForGroup(aliceGroup.mlsGroupId)).toBeUndefined()

    await alice.close()
    await bob.close()
  })

  it('does not clobber group state held under the same mlsGroupId', async () => {
    const { alice, bob } = await openPair()

    await alice.storage.putGroup('same-group', new Uint8Array([1]))
    await bob.storage.putGroup('same-group', new Uint8Array([2]))

    expect(await alice.storage.getGroup('same-group')).toEqual(new Uint8Array([1]))
    expect(await bob.storage.getGroup('same-group')).toEqual(new Uint8Array([2]))

    await alice.close()
    await bob.close()
  })

  it('keeps invites apart', async () => {
    const { alice, bob } = await openPair()

    await alice.invites.send(`02${'cc'.repeat(32)}`)

    expect(await alice.invites.list()).toHaveLength(1)
    expect(await bob.invites.list()).toEqual([])

    await alice.close()
    await bob.close()
  })
})
