import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import {
  decodeMlsMessage,
  defaultCapabilities,
  encodeMlsMessage,
  generateKeyPackageWithKey
} from 'ts-mls'
import { encodeKeyPackage } from 'ts-mls/keyPackage.js'
import { describe, expect, it, vi } from 'vitest'
import { encodeEnvelope } from '../bootstrap/index.js'
import {
  GroupMessagingClient,
  MAX_GROUPS_HELD_BEFORE_JOIN,
  MAX_PENDING_BYTES_PER_GROUP,
  MAX_PENDING_PER_GROUP
} from '../client.js'
import { toHex } from '../bytes.js'
import { ContentDecodeError, encodeContent, text } from '../content/index.js'
import { isPermanent } from '../errors.js'
import { resolveCiphersuite } from '../mls/ciphersuite.js'
import { asKeyPackageBytes, decodePrivateKeyPackage } from '../mls/key-package-codec.js'
import { decodeFrames } from '../storage/frames.js'
import { InProcessTransportHub } from '../transport/backends/in-process.js'
import type { ClientEvents } from '../client.js'
import { DEFAULT_CIPHERSUITE, type PrivateKeyPackageBytes } from '../types.js'

const openClient = async (hub: InProcessTransportHub, storage: Map<string, Uint8Array>) => {
  const wallet = new KeyDeriver(PrivateKey.fromRandom())
  return GroupMessagingClient.create({
    wallet,
    storage,
    transport: hub.endpoint(wallet.identityKey)
  })
}

const nextEvent = <K extends keyof ClientEvents>(
  client: GroupMessagingClient,
  event: K
): Promise<ClientEvents[K]> =>
  new Promise(resolve => {
    const stop = client.on(event, payload => {
      stop()
      resolve(payload)
    })
  })

describe('two wallets, end to end', () => {
  it('invites, accepts, creates a group and exchanges a message', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())

    // Bob's wallet holds the secret; the library never sees it again.
    const bobSecrets = new Map<string, PrivateKeyPackageBytes>()

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey, { chatName: 'Project Alpha' })

    const invite = await invited
    expect(invite.peer).toBe(alice.identityKey)
    expect(invite.chatName).toBe('Project Alpha')

    const minted = await bob.keyPackages.create()
    bobSecrets.set(minted.ref, minted.privateKeyPackage)
    await bob.invites.accept(invite.inviteId, minted.keyPackage)

    const { keyPackage, keyPackageIdentity } = await answered
    // The credential inside the KeyPackage names the same peer the transport did.
    expect(keyPackageIdentity).toBe(bob.identityKey)
    expect(await bob.invites.list()).toEqual([])

    const aliceOwn = await alice.keyPackages.create()
    const welcomed = nextEvent(bob, 'welcomeReceived')
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      name: 'Project Alpha',
      privateKeyPackage: aliceOwn.privateKeyPackage
    })

    const welcome = await welcomed
    expect(welcome.peer).toBe(alice.identityKey)
    expect(welcome.ref).toBe(minted.ref)

    const bobGroup = await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: bobSecrets.get(welcome.ref!)!
    })

    expect(bobGroup.mlsGroupId).toBe(group.mlsGroupId)
    expect(await bob.invites.list()).toEqual([])

    const received = nextEvent(bob, 'message')
    await group.sendText('hello Bob')
    const message = await received

    expect(message.content.body).toBe('hello Bob')
    expect(message.sender).toBe(alice.identityKey)
    expect(message.chatId).toBe('chat-b')

    const info = await bobGroup.info()
    expect(info.chatId).toBe('chat-b')
    expect(info.mlsGroupId).toBe(group.mlsGroupId)
    expect(info.epoch).toBe(1n)
    expect(info.members.map(member => member.identityKey).sort()).toEqual(
      [alice.identityKey, bob.identityKey].sort()
    )
    // Alice named the chat; Bob's copy takes its name from the invitation.
    expect((await group.info()).name).toBe('Project Alpha')
    expect(info.name).toBe('Project Alpha')

    await alice.close()
    await bob.close()
  })

  it('carries a reply back the other way', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()

    const atAlice = nextEvent(alice, 'message')
    await bobGroup.sendText('hello Alice')
    const message = await atAlice

    expect(message.content.body).toBe('hello Alice')
    expect(message.sender).toBe(bob.identityKey)
    expect(message.chatId).toBe('chat-a')
    expect((await aliceGroup.info()).epoch).toBe(1n)

    await alice.close()
    await bob.close()
  })

  it('marks a replayed message as permanently unprocessable', async () => {
    const queues = new Map<string, Uint8Array>()
    const { hub, alice, bob, aliceGroup } = await pair(queues)

    // Held offline so the raw wire bytes land in `queues` instead of being
    // consumed immediately, then read back out the way the offline tests do.
    hub.goOffline(bob.identityKey)
    await aliceGroup.sendText('once')
    const [, payload] = decodeFrames(decodeFrames(queues.get(bob.identityKey))[0])

    const delivered = nextEvent(bob, 'message')
    await hub.goOnline(bob.identityKey)
    await delivered

    // Bob has already processed this exact message; the generation is consumed,
    // so a second delivery of the identical bytes can never decrypt.
    let caught: unknown
    try {
      await bob.processIncoming(payload!, alice.identityKey)
    } catch (error) {
      caught = error
    }
    expect(isPermanent(caught)).toBe(true)

    await alice.close()
    await bob.close()
  })

  it('marks plaintext that decrypts but is not valid content JSON as permanently unprocessable', async () => {
    const queues = new Map<string, Uint8Array>()
    const { hub, alice, bob, aliceGroup } = await pair(queues)

    // `Group.send` takes arbitrary bytes; this drives the real MLS encrypt path
    // with a plaintext that will decrypt fine and then fail `decodeContent`.
    hub.goOffline(bob.identityKey)
    await aliceGroup.send(new TextEncoder().encode('not json'))
    const [, payload] = decodeFrames(decodeFrames(queues.get(bob.identityKey))[0])

    let caught: unknown
    try {
      await bob.processIncoming(payload!, alice.identityKey)
    } catch (error) {
      caught = error
    }
    expect(isPermanent(caught)).toBe(true)
    expect((caught as { cause?: unknown }).cause).toBeInstanceOf(ContentDecodeError)

    await alice.close()
    await bob.close()
  })

  it('does not classify a storage failure after a successful decrypt as permanent', async () => {
    // The decrypt succeeded; only the write afterward is flaky. Retrying the
    // same ciphertext against the still-unadvanced stored state should work,
    // so this must not be reported the same way a replay or corrupt frame is.
    const { alice, bob, aliceGroup } = await pair()
    vi.spyOn(bob.storage, 'putGroup').mockRejectedValueOnce(new Error('disk full'))

    const failed = nextEvent(bob, 'processingFailed')
    await aliceGroup.sendText('once')
    const { error } = await failed

    expect(error.message).toBe('disk full')
    expect(isPermanent(error)).toBe(false)

    await alice.close()
    await bob.close()
  })

  it('never writes private key material into storage', async () => {
    const hub = new InProcessTransportHub()
    const aliceStore = new Map<string, Uint8Array>()
    const bobStore = new Map<string, Uint8Array>()
    const alice = await openClient(hub, aliceStore)
    const bob = await openClient(hub, bobStore)

    const aliceKp = await alice.keyPackages.create()
    const bobKp = await bob.keyPackages.create()
    assertNoPrivateMaterial(aliceStore, aliceKp.privateKeyPackage, 'after minting')

    // The public half is kept, keyed by ref. Nothing else about it is.
    expect([...aliceStore.keys()]).toContain(`keyPackages:${alice.identityKey}/${aliceKp.ref}`)
    expect(await alice.storage.getKeyPackage(aliceKp.ref)).toEqual(aliceKp.keyPackage)

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [bobKp.keyPackage],
      name: 'Project Alpha',
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    assertNoPrivateMaterial(aliceStore, aliceKp.privateKeyPackage, 'after createGroup')
    // No `keyPackages` any more: founding spent the only stored ref, and a
    // spent one is retired rather than left to match a later Welcome.
    expect(namespacesIn(aliceStore)).toEqual(['chats', 'groups'])
    expect(await alice.storage.getKeyPackage(aliceKp.ref)).toBeUndefined()

    // Bob holds the Welcome on an invite record before he acts on it.
    const welcome = await welcomed
    assertNoPrivateMaterial(bobStore, bobKp.privateKeyPackage, 'holding a Welcome')
    expect(namespacesIn(bobStore)).toEqual(['invites', 'keyPackages'])

    await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: bobKp.privateKeyPackage
    })
    assertNoPrivateMaterial(bobStore, bobKp.privateKeyPackage, 'after joinFromWelcome')
    // The invite is consumed and so is the KeyPackage it named: joining spends
    // the init key, and a spent one must not stay eligible for another Welcome.
    expect(namespacesIn(bobStore)).toEqual(['chats', 'groups'])
    expect(await bob.storage.getKeyPackage(bobKp.ref)).toBeUndefined()

    // And a round trip, so the message ratchet has run before the last check.
    const received = nextEvent(bob, 'message')
    await group.sendText('hello Bob')
    await received
    assertNoPrivateMaterial(aliceStore, aliceKp.privateKeyPackage, 'after sending')
    assertNoPrivateMaterial(bobStore, bobKp.privateKeyPackage, 'after receiving')

    await alice.close()
    await bob.close()
  })

  it('survives a restart: state reloads and a message still decrypts', async () => {
    const hub = new InProcessTransportHub()
    const aliceStore = new Map<string, Uint8Array>()
    const bobStore = new Map<string, Uint8Array>()
    const aliceWallet = new KeyDeriver(PrivateKey.fromRandom())
    const bobWallet = new KeyDeriver(PrivateKey.fromRandom())

    const open = async (wallet: KeyDeriver, store: Map<string, Uint8Array>) =>
      GroupMessagingClient.create({
        wallet,
        storage: store,
        transport: hub.endpoint(wallet.identityKey)
      })

    let alice = await open(aliceWallet, aliceStore)
    let bob = await open(bobWallet, bobStore)

    const bobKp = await bob.keyPackages.create()
    const aliceKp = await alice.keyPackages.create()
    const welcomed = nextEvent(bob, 'welcomeReceived')
    const group = await alice.createGroup({
      chatId: 'c',
      members: [bobKp.keyPackage],
      privateKeyPackage: aliceKp.privateKeyPackage
    })
    const welcome = await welcomed
    await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'c',
      privateKeyPackage: bobKp.privateKeyPackage
    })

    // Restart both sides from their stores alone.
    await alice.close()
    await bob.close()
    alice = await open(aliceWallet, aliceStore)
    bob = await open(bobWallet, bobStore)

    const received = nextEvent(bob, 'message')
    const reloaded = await alice.getGroup('c')
    expect(reloaded?.mlsGroupId).toBe(group.mlsGroupId)
    await reloaded!.sendText('after restart')

    expect((await received).content.body).toBe('after restart')

    await alice.close()
    await bob.close()
  })

  it('holds a message that arrives ahead of the Commit, then applies it', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()

    // Alice commits and speaks in the new epoch. Bob is handed the two in the
    // wrong order, which no ordered transport does but a lossy one will.
    const state = await aliceGroup.state()
    const committed = await alice.engine.update({ state })
    const spoken = await alice.engine.encrypt({
      state: committed.state,
      plaintext: encodeContent(text('into the new epoch'))
    })

    const held = nextEvent(bob, 'epochMismatch')
    await bob.processIncoming(envelope(spoken.message), alice.identityKey)

    const mismatch = await held
    expect(mismatch.disposition).toBe('queued')
    expect(mismatch.expected).toBe(1n)
    expect(mismatch.received).toBe(2n)
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(1)

    const delivered = nextEvent(bob, 'message')
    await bob.processIncoming(envelope(committed.commit), alice.identityKey)

    expect((await delivered).content.body).toBe('into the new epoch')
    expect((await bobGroup.info()).epoch).toBe(2n)
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })

  it('gives each of two newcomers the right secret out of one Welcome', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())
    const carol = await openClient(hub, new Map())

    const bobKp = await bob.keyPackages.create()
    const carolKp = await carol.keyPackages.create()
    const atBob = nextEvent(bob, 'welcomeReceived')
    const atCarol = nextEvent(carol, 'welcomeReceived')
    const aliceOwn = await alice.keyPackages.create()

    // ONE Commit, ONE Welcome, two sets of group secrets inside it.
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [bobKp.keyPackage, carolKp.keyPackage],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })

    const forBob = await atBob
    const forCarol = await atCarol
    expect(forBob.welcome).toEqual(forCarol.welcome)
    // Each side must find its OWN secret in it. Taking secrets[0] hands both
    // sides the same ref, and whoever is not first cannot join at all.
    expect(forBob.ref).toBe(bobKp.ref)
    expect(forCarol.ref).toBe(carolKp.ref)
    expect(forBob.ref).not.toBe(forCarol.ref)

    const bobGroup = await bob.joinFromWelcome({
      inviteId: forBob.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: bobKp.privateKeyPackage
    })
    const carolGroup = await carol.joinFromWelcome({
      inviteId: forCarol.inviteId,
      chatId: 'chat-c',
      privateKeyPackage: carolKp.privateKeyPackage
    })

    expect(bobGroup.mlsGroupId).toBe(group.mlsGroupId)
    expect(carolGroup.mlsGroupId).toBe(group.mlsGroupId)

    const atBobsEnd = nextEvent(bob, 'message')
    const atCarolsEnd = nextEvent(carol, 'message')
    await group.sendText('hello both')

    expect((await atBobsEnd).content.body).toBe('hello both')
    expect((await atCarolsEnd).content.body).toBe('hello both')
    expect((await carolGroup.info()).members).toHaveLength(3)

    await alice.close()
    await bob.close()
    await carol.close()
  })

  it('still applies a queued message exactly at the retention boundary', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()

    // A real epoch-1 message, held back rather than sent.
    const stale = await alice.engine.encrypt({
      state: await aliceGroup.state(),
      plaintext: encodeContent(text('just in time'))
    })

    // Queue it at epoch 4, then one more Commit puts the group at 5 â€” exactly
    // four epochs on, which ts-mls still retains keys for.
    for (let index = 0; index < 3; index++) await aliceGroup.update()
    expect((await bobGroup.info()).epoch).toBe(4n)
    await bob.storage.queuePending(bobGroup.mlsGroupId, stale.message)

    const delivered = nextEvent(bob, 'message')
    await aliceGroup.update()

    expect((await bobGroup.info()).epoch).toBe(5n)
    expect((await delivered).content.body).toBe('just in time')
    expect((await delivered).epoch).toBe(1n)
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })

  it('drops a queued message one epoch past the retention boundary', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()

    const stale = await alice.engine.encrypt({
      state: await aliceGroup.state(),
      plaintext: encodeContent(text('one epoch too late'))
    })

    // The mirror of the test above: queued at epoch 5, drained at 6, which is
    // five epochs on. One more than ts-mls keeps.
    for (let index = 0; index < 4; index++) await aliceGroup.update()
    expect((await bobGroup.info()).epoch).toBe(5n)
    await bob.storage.queuePending(bobGroup.mlsGroupId, stale.message)

    const mismatches: ClientEvents['epochMismatch'][] = []
    const messages: ClientEvents['message'][] = []
    bob.on('epochMismatch', payload => mismatches.push(payload))
    bob.on('message', payload => messages.push(payload))

    await aliceGroup.update()

    expect((await bobGroup.info()).epoch).toBe(6n)
    expect(messages).toEqual([])
    expect(mismatches).toEqual([
      {
        chatId: 'chat-a',
        mlsGroupId: bobGroup.mlsGroupId,
        expected: 6n,
        received: 1n,
        disposition: 'dropped'
      }
    ])
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })

  it("drops a queued message once its epoch's keys are gone", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()

    // A real epoch-1 message, kept back rather than sent.
    const stale = await alice.engine.encrypt({
      state: await aliceGroup.state(),
      plaintext: encodeContent(text('too late'))
    })

    // Six commits carry both sides to epoch 7, five past the message's epoch.
    for (let index = 0; index < 6; index++) await aliceGroup.update()
    expect((await bobGroup.info()).epoch).toBe(7n)

    await bob.storage.queuePending(bobGroup.mlsGroupId, stale.message)
    const mismatches: ClientEvents['epochMismatch'][] = []
    bob.on('epochMismatch', payload => mismatches.push(payload))

    // The next Commit drains the queue and finds the message unrecoverable.
    await aliceGroup.update()

    expect((await bobGroup.info()).epoch).toBe(8n)
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)
    expect(mismatches).toEqual([
      {
        chatId: 'chat-a',
        mlsGroupId: bobGroup.mlsGroupId,
        expected: 8n,
        received: 1n,
        disposition: 'dropped'
      }
    ])

    await alice.close()
    await bob.close()
  })
})

/**
 * Alice and Bob in one chat named "chat-a" on both sides, at epoch 1.
 *
 * `queues` is optional and, when passed, is the same map the hub stores
 * offline traffic in â€” a caller that wants to inspect or replay a payload
 * as raw bytes takes the peer offline, sends, and reads it back out.
 */
const pair = async (queues?: Map<string, Uint8Array>) => {
  const hub = new InProcessTransportHub(queues)
  const alice = await openClient(hub, new Map())
  const bob = await openClient(hub, new Map())

  const bobKp = await bob.keyPackages.create()
  const aliceKp = await alice.keyPackages.create()
  const welcomed = nextEvent(bob, 'welcomeReceived')
  const aliceGroup = await alice.createGroup({
    chatId: 'chat-a',
    members: [bobKp.keyPackage],
    privateKeyPackage: aliceKp.privateKeyPackage
  })
  const welcome = await welcomed
  const bobGroup = await bob.joinFromWelcome({
    inviteId: welcome.inviteId,
    chatId: 'chat-a',
    privateKeyPackage: bobKp.privateKeyPackage
  })
  return { hub, alice, bob, aliceGroup, bobGroup }
}

const envelope = (payload: Uint8Array): Uint8Array => encodeEnvelope({ kind: 'mls', payload })

/**
 * The namespaces a JSON record lives in. A `Uint8Array` written into one of
 * these does not survive as bytes â€” `JSON.stringify` turns it into
 * `{"0":12,...}` â€” so a raw subsequence search over the stored value is blind
 * to a leak here. They are searched as text, in every shape the value could
 * have taken on the way in.
 */
const JSON_NAMESPACES = ['chats:', 'invites:']

/** The forms a byte string could plausibly have been written down as. */
const writtenForms = (bytes: Uint8Array): Array<[string, string]> => [
  ['hex', toHex(bytes)],
  ['base64', btoa(String.fromCharCode(...bytes))],
  // `JSON.stringify(someUint8Array)` and `JSON.stringify([...someUint8Array])`.
  // Brackets are stripped so the needle matches wherever it is nested.
  ['number array', JSON.stringify([...bytes]).slice(1, -1)],
  ['numeric object', JSON.stringify(Object.assign({}, [...bytes])).slice(1, -1)]
]

const namespacesIn = (storage: Map<string, Uint8Array>): string[] =>
  [...new Set([...storage.keys()].map(key => key.slice(0, key.indexOf(':'))))].sort()

/**
 * No stored value holds the KeyPackage private half â€” except `groups:`.
 *
 * That exception is real and not a loophole: an encoded MLS group state *is* a
 * ratchet, and `encodeGroupState` writes `signaturePrivateKey` into it. There
 * is no version of MLS where a member can send without holding it. That
 * namespace is exactly what `storage/backend.ts` asks hosts to encrypt at rest.
 * Everything else â€” the chat record, the invite record, the stored public
 * KeyPackage â€” must be free of it, and of each of the three keys inside it.
 */
const assertNoPrivateMaterial = (
  storage: Map<string, Uint8Array>,
  privateKeyPackage: PrivateKeyPackageBytes,
  where: string
): void => {
  const parts = decodePrivateKeyPackage(privateKeyPackage)
  const secrets: Array<[string, Uint8Array]> = [
    ['the blob', privateKeyPackage],
    ['initPrivateKey', parts.initPrivateKey],
    ['hpkePrivateKey', parts.hpkePrivateKey],
    ['signaturePrivateKey', parts.signaturePrivateKey]
  ]

  let searched = 0
  for (const [key, value] of storage) {
    if (key.startsWith('groups:')) continue
    searched++
    const asText = JSON_NAMESPACES.some(namespace => key.startsWith(namespace))
      ? new TextDecoder().decode(value)
      : undefined

    for (const [name, secret] of secrets) {
      expect(
        containsSubsequence(value, secret),
        `${where}: ${key} holds ${name} as raw bytes`
      ).toBe(false)
      if (asText === undefined) continue
      for (const [form, encoded] of writtenForms(secret)) {
        expect(asText.includes(encoded), `${where}: ${key} holds ${name} as ${form}`).toBe(false)
      }
    }
  }
  // A search over nothing proves nothing.
  expect(searched, `${where}: no non-group values to search`).toBeGreaterThan(0)
}

const containsSubsequence = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

describe("a peer answering with somebody else's KeyPackage", () => {
  it("is rejected instead of surfacing as that peer's KeyPackage", async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())
    const carol = await openClient(hub, new Map())

    const accepted: unknown[] = []
    alice.on('keyPackageReceived', payload => accepted.push(payload))
    const rejected = nextEvent(alice, 'keyPackageRejected')

    const invited = nextEvent(bob, 'inviteReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited

    const carolsKeyPackage = (await carol.keyPackages.create()).keyPackage
    await bob.invites.accept(invite.inviteId, carolsKeyPackage)

    const mismatch = await rejected
    expect(mismatch.peer).toBe(bob.identityKey)
    expect(mismatch.claimed).toBe(carol.identityKey)
    expect(mismatch.error.message).toContain(carol.identityKey)
    // Nothing reaches the happy path, so no consumer can build a group it
    // believes contains Bob and which in fact contains Carol.
    expect(accepted).toEqual([])

    await alice.close()
    await bob.close()
    await carol.close()
  })

  it('rejects a KeyPackage that cannot be read at all', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())

    const accepted: unknown[] = []
    alice.on('keyPackageReceived', payload => accepted.push(payload))
    const rejected = nextEvent(alice, 'keyPackageRejected')

    const invited = nextEvent(bob, 'inviteReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited

    await bob.invites.accept(invite.inviteId, asKeyPackageBytes(new Uint8Array([1, 2, 3])))

    const mismatch = await rejected
    expect(mismatch.peer).toBe(bob.identityKey)
    expect(mismatch.claimed).toBeUndefined()
    expect(accepted).toEqual([])

    await alice.close()
    await bob.close()
  })

  /**
   * The credential names the right peer, so the identity check passes â€” and the
   * attestation inside it signs a different MLS key, so the KeyPackage is one
   * MLS refuses at admission. Rejecting it here means the inviter learns their
   * invitation was answered badly, instead of learning much later that a group
   * they already asked their wallet to sign for cannot be built.
   */
  it('rejects a KeyPackage whose credential names the peer but attests to another key', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bobWallet = new KeyDeriver(PrivateKey.fromRandom())
    const bob = await GroupMessagingClient.create({
      wallet: bobWallet,
      storage: new Map(),
      transport: hub.endpoint(bobWallet.identityKey)
    })

    const accepted: unknown[] = []
    alice.on('keyPackageReceived', payload => accepted.push(payload))
    const rejected = nextEvent(alice, 'keyPackageRejected')

    const invited = nextEvent(bob, 'inviteReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited

    // Bob's own wallet signs, but over a keypair the leaf does not use.
    const suite = await resolveCiphersuite(DEFAULT_CIPHERSUITE)
    const attested = await suite.signature.keygen()
    const { credential } = await bob.identity.createCredential({
      ciphersuite: DEFAULT_CIPHERSUITE,
      mlsSignaturePublicKey: attested.publicKey
    })
    const leafKeyPair = await suite.signature.keygen()
    const notBefore = BigInt(Math.floor(Date.now() / 1000))
    const { publicPackage } = await generateKeyPackageWithKey(
      { credentialType: 'basic', identity: credential },
      defaultCapabilities(),
      { notBefore, notAfter: notBefore + 3600n },
      [],
      leafKeyPair,
      suite
    )
    await bob.invites.accept(invite.inviteId, asKeyPackageBytes(encodeKeyPackage(publicPackage)))

    const failure = await rejected
    expect(failure.peer).toBe(bob.identityKey)
    expect(failure.claimed).toBe(bob.identityKey)
    expect(failure.error.message).toContain('does not attest')
    expect(accepted).toEqual([])

    await alice.close()
    await bob.close()
  })
})

describe('a stranger answering an invitation meant for someone else', () => {
  it('tells the inviter when a stranger answers an invitation meant for someone else', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())
    const mallory = await openClient(hub, new Map())

    const refused = nextEvent(alice, 'bootstrapRefused')
    const invited = nextEvent(bob, 'inviteReceived')
    await alice.invites.send(bob.identityKey)
    await invited
    const requestId = (await bob.invites.list('inbound'))[0]!.requestId

    // Mallory has no invitation of her own to accept â€” `invites.accept`
    // requires a local record and would reject before sending anything â€” so
    // she forges the wire message directly, the way a real attacker would.
    const hers = await mallory.keyPackages.create()
    await mallory.transport.send(
      alice.identityKey,
      encodeEnvelope({
        kind: 'bootstrap',
        message: { type: 'keyPackageResponse', requestId, keyPackage: hers.keyPackage }
      })
    )

    const event = await refused
    expect(event.peer).toBe(mallory.identityKey)
    expect(event.kind).toBe('keyPackageResponse')

    await alice.close()
    await bob.close()
    await mallory.close()
  })
})

describe('a send racing an inbound message on the same group', () => {
  it("keeps both writes, so neither side's ratchet is lost", async () => {
    const { hub, alice, bob, aliceGroup, bobGroup } = await pair()

    const atAlice: Array<string | undefined> = []
    const atBob: Array<string | undefined> = []
    alice.on('message', ({ content }) => atAlice.push(content.body))
    bob.on('message', ({ content }) => atBob.push(content.body))

    // Bob speaks while Alice is unreachable, so his message reaches her at the
    // exact moment she is encrypting her own: two reads of one stored state.
    hub.goOffline(alice.identityKey)
    await bobGroup.sendText('b1')

    const delivered = hub.goOnline(alice.identityKey)
    const sent = aliceGroup.sendText('a1')
    await Promise.all([delivered, sent])

    // One more each way. Whichever of the two racing writes were lost, one of
    // these re-consumes a generation the peer's ratchet has already spent and
    // is silently dropped â€” a nonce reuse the recipient answers with silence.
    await aliceGroup.sendText('a2')
    await bobGroup.sendText('b2')

    expect(atBob).toEqual(['a1', 'a2'])
    expect(atAlice).toEqual(['b1', 'b2'])

    await alice.close()
    await bob.close()
  })

  it('serializes concurrent sends on one group', async () => {
    const { alice, bob, aliceGroup } = await pair()

    const atBob: Array<string | undefined> = []
    bob.on('message', ({ content }) => atBob.push(content.body))

    await Promise.all([
      aliceGroup.sendText('one'),
      aliceGroup.sendText('two'),
      aliceGroup.sendText('three')
    ])

    expect(atBob.sort()).toEqual(['one', 'three', 'two'])

    await alice.close()
    await bob.close()
  })
})

describe('the join window', () => {
  /**
   * Joining is user-gated and may happen long after the Welcome. Everything the
   * group says in between is addressed to a member whose client has no chat row
   * yet, and over MessageBox a silent drop is also an acknowledgement â€” so the
   * message is gone from the box as well.
   */
  it('delivers messages sent between the Welcome and a late join', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())
    const bobSecrets = new Map<string, PrivateKeyPackageBytes>()

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey)

    const invite = await invited
    const minted = await bob.keyPackages.create()
    bobSecrets.set(minted.ref, minted.privateKeyPackage)
    await bob.invites.accept(invite.inviteId, minted.keyPackage)
    const { keyPackage } = await answered

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const aliceOwn = await alice.keyPackages.create()
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })
    const welcome = await welcomed

    // Alice speaks while Bob's join is still waiting on a human.
    await group.sendText('first')
    await group.sendText('second')

    const seen: string[] = []
    bob.on('message', ({ content }) => {
      if (typeof content.body === 'string') seen.push(content.body)
    })

    await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: bobSecrets.get(welcome.ref!)!
    })

    expect(seen).toEqual(['first', 'second'])

    await alice.close()
    await bob.close()
  })

  /**
   * Holding is gated on an outstanding Welcome. Without that gate any peer
   * could name any group id and have this device store the payload â€” the same
   * unbounded write the pending queue already invites elsewhere.
   */
  it('holds nothing once no invitation is outstanding', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())
    const bobSecrets = new Map<string, PrivateKeyPackageBytes>()

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey)

    const invite = await invited
    const minted = await bob.keyPackages.create()
    bobSecrets.set(minted.ref, minted.privateKeyPackage)
    await bob.invites.accept(invite.inviteId, minted.keyPackage)
    const { keyPackage } = await answered

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const aliceOwn = await alice.keyPackages.create()
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })
    const welcome = await welcomed

    await group.sendText('held')
    expect(await bob.storage.countPending(group.mlsGroupId)).toBe(1)

    // Bob abandons the invitation. There is nothing left to join, so later
    // traffic for that group is not this device's business, and what was held
    // for a join that will not happen goes with it.
    await bob.storage.deleteInvite(welcome.inviteId)
    await group.sendText('dropped')
    expect(await bob.storage.countPending(group.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })
})

describe('the pending queue is bounded', () => {
  /** What an attacker does: a real frame with its cleartext epoch rewritten. */
  const reframe = (message: Uint8Array, epoch: bigint): Uint8Array => {
    const decoded = decodeMlsMessage(message, 0)
    if (decoded === undefined) throw new Error('not an MLS message')
    const [value] = decoded
    if (value.wireformat !== 'mls_private_message') throw new Error('not a private message')
    return encodeMlsMessage({
      ...value,
      privateMessage: { ...value.privateMessage, epoch }
    })
  }

  it('refuses an epoch further ahead than any Commit sequence will reach', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()
    const spoken = await alice.engine.encrypt({
      state: await aliceGroup.state(),
      plaintext: encodeContent(text('forged'))
    })

    const held = nextEvent(bob, 'epochMismatch')
    await bob.processIncoming(envelope(reframe(spoken.message, 1_000_000n)), alice.identityKey)

    expect((await held).disposition).toBe('refused')
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })

  it('stops holding once the queue is full', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()
    const committed = await alice.engine.update({ state: await aliceGroup.state() })
    const spoken = await alice.engine.encrypt({
      state: committed.state,
      plaintext: encodeContent(text('ahead'))
    })

    const payload = envelope(spoken.message)
    for (let index = 0; index < MAX_PENDING_PER_GROUP + 8; index++) {
      await bob.processIncoming(payload, alice.identityKey)
    }

    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(MAX_PENDING_PER_GROUP)

    await alice.close()
    await bob.close()
  })
})

describe('the pending queue is bounded by bytes as well as count', () => {
  /**
   * The count cap alone leaves a second shape of the same attack: a handful of
   * very large frames. At 256 payloads a megabyte budget only binds above 4KiB
   * each, which is exactly the case the count cap does not reach.
   */
  it("stops holding once the queue's byte budget is spent", async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()
    const committed = await alice.engine.update({ state: await aliceGroup.state() })
    const spoken = await alice.engine.encrypt({
      state: committed.state,
      plaintext: encodeContent(text('x'.repeat(300_000)))
    })

    const payload = envelope(spoken.message)
    const dispositions: string[] = []
    bob.on('epochMismatch', ({ disposition }) => dispositions.push(disposition))
    for (let index = 0; index < 6; index++) {
      await bob.processIncoming(payload, alice.identityKey)
    }

    const stats = await bob.storage.pendingStats(bobGroup.mlsGroupId)
    expect(stats.bytes).toBeLessThanOrEqual(MAX_PENDING_BYTES_PER_GROUP)
    expect(stats.count).toBeLessThan(MAX_PENDING_PER_GROUP)
    expect(dispositions).toContain('refused')

    await alice.close()
    await bob.close()
  })
})

describe('a spent KeyPackage is retired', () => {
  /**
   * RFC 9420 treats a KeyPackage as single-use. The library holds only the
   * public half, so retiring it is what stops a second Welcome naming the same
   * ref from being joinable â€” the reuse the spec warns against.
   */
  it('retires the ref the join consumed, and names it', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited
    const minted = await bob.keyPackages.create()
    await bob.invites.accept(invite.inviteId, minted.keyPackage)
    const { keyPackage } = await answered

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const own = await alice.keyPackages.create()
    await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      privateKeyPackage: own.privateKeyPackage
    })
    const welcome = await welcomed

    const consumed = nextEvent(bob, 'keyPackageConsumed')
    await bob.joinFromWelcome({
      inviteId: welcome.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: minted.privateKeyPackage
    })

    expect((await consumed).ref).toBe(minted.ref)
    expect(await bob.keyPackages.list()).not.toContain(minted.ref)

    await alice.close()
    await bob.close()
  })

  it("retires the founder's own ref when the group is created", async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())

    const own = await alice.keyPackages.create()
    const consumed = nextEvent(alice, 'keyPackageConsumed')
    await alice.createGroup({
      chatId: 'chat-a',
      members: [],
      privateKeyPackage: own.privateKeyPackage
    })

    expect((await consumed).ref).toBe(own.ref)
    expect(await alice.keyPackages.list()).not.toContain(own.ref)

    await alice.close()
  })

  /** A join that failed is owed its retry, and the retry needs the ref. */
  it('keeps the ref when the join fails', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited
    const minted = await bob.keyPackages.create()
    await bob.invites.accept(invite.inviteId, minted.keyPackage)
    const { keyPackage } = await answered

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const own = await alice.keyPackages.create()
    await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      privateKeyPackage: own.privateKeyPackage
    })
    const welcome = await welcomed

    // The wrong private half: the engine refuses, and nothing is spent.
    const wrong = await bob.keyPackages.create()
    await expect(
      bob.joinFromWelcome({
        inviteId: welcome.inviteId,
        chatId: 'chat-b',
        privateKeyPackage: wrong.privateKeyPackage
      })
    ).rejects.toThrow()

    expect(await bob.keyPackages.list()).toContain(minted.ref)

    await alice.close()
    await bob.close()
  })

  it('retires a ref on request, for a pool the caller is managing', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())

    const minted = await alice.keyPackages.create()
    expect(await alice.keyPackages.list()).toContain(minted.ref)

    await alice.keyPackages.retire(minted.ref)

    expect(await alice.keyPackages.list()).not.toContain(minted.ref)
    await alice.close()
  })
})

describe('holds taken before a join are bounded across groups', () => {
  /** What an attacker does: a real frame relabelled with a group id they made up. */
  const relabel = (message: Uint8Array, groupId: Uint8Array): Uint8Array => {
    const decoded = decodeMlsMessage(message, 0)
    if (decoded === undefined) throw new Error('not an MLS message')
    const [value] = decoded
    if (value.wireformat !== 'mls_private_message') throw new Error('not a private message')
    return encodeMlsMessage({
      ...value,
      privateMessage: { ...value.privateMessage, groupId }
    })
  }

  /** Bob has a Welcome outstanding and has not joined: the window holds are taken in. */
  const invitedNotJoined = async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, new Map())
    const bob = await openClient(hub, new Map())

    const invited = nextEvent(bob, 'inviteReceived')
    const answered = nextEvent(alice, 'keyPackageReceived')
    await alice.invites.send(bob.identityKey)
    const invite = await invited
    const minted = await bob.keyPackages.create()
    await bob.invites.accept(invite.inviteId, minted.keyPackage)
    const { keyPackage } = await answered

    const welcomed = nextEvent(bob, 'welcomeReceived')
    const aliceOwn = await alice.keyPackages.create()
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [keyPackage],
      privateKeyPackage: aliceOwn.privateKeyPackage
    })
    return { alice, bob, group, welcome: await welcomed }
  }

  const spoofedGroupIds = (count: number): Uint8Array[] =>
    Array.from({ length: count }, (_, index) => {
      const groupId = new Uint8Array(32)
      groupId[0] = index + 1
      groupId[1] = 0xff
      return groupId
    })

  it('stops taking on new groups once the window is full', async () => {
    const { alice, bob, group } = await invitedNotJoined()
    const spoken = await alice.engine.encrypt({
      state: await group.state(),
      plaintext: encodeContent(text('spoofed'))
    })

    for (const groupId of spoofedGroupIds(MAX_GROUPS_HELD_BEFORE_JOIN + 8)) {
      await bob.processIncoming(envelope(relabel(spoken.message, groupId)), alice.identityKey)
    }

    expect((await bob.storage.listPendingGroups()).length).toBe(MAX_GROUPS_HELD_BEFORE_JOIN)

    await alice.close()
    await bob.close()
  })

  it('reclaims held queues once no invitation is left to name them', async () => {
    const { alice, bob, group, welcome } = await invitedNotJoined()
    const spoken = await alice.engine.encrypt({
      state: await group.state(),
      plaintext: encodeContent(text('spoofed'))
    })
    const spoofed = spoofedGroupIds(4)
    for (const groupId of spoofed) {
      await bob.processIncoming(envelope(relabel(spoken.message, groupId)), alice.identityKey)
    }
    expect((await bob.storage.listPendingGroups()).length).toBe(spoofed.length)

    await bob.storage.deleteInvite(welcome.inviteId)
    await bob.processIncoming(
      envelope(relabel(spoken.message, spoofedGroupIds(5)[4]!)),
      alice.identityKey
    )

    expect(await bob.storage.listPendingGroups()).toEqual([])

    await alice.close()
    await bob.close()
  })
})

describe('a queued payload that no longer decodes', () => {
  it('is reported rather than dropped in silence', async () => {
    const { alice, bob, aliceGroup, bobGroup } = await pair()
    await bob.storage.queuePending(bobGroup.mlsGroupId, new Uint8Array([1, 2, 3]))

    const failed = nextEvent(bob, 'processingFailed')
    await aliceGroup.sendText('hello')

    expect((await failed).error).toBeInstanceOf(Error)
    expect(await bob.storage.countPending(bobGroup.mlsGroupId)).toBe(0)

    await alice.close()
    await bob.close()
  })
})
