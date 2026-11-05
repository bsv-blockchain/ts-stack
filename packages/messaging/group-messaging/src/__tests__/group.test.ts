import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { GroupMessagingClient } from '../client.js'
import { decodeEnvelope } from '../bootstrap/index.js'
import { decodeContent, type RemoteAttachment } from '../content/index.js'
import type { Group } from '../group.js'
import { InProcessTransportHub } from '../transport/backends/in-process.js'
import { WelcomeDeliveryError } from '../errors.js'
import { BroadcastError, type TransportBackend } from '../transport/index.js'
import type { IdentityKey, KeyPackageBytes, PrivateKeyPackageBytes, WirePayload } from '../types.js'

const openClient = async (
  hub: InProcessTransportHub,
  wrap: (backend: TransportBackend) => TransportBackend = backend => backend
): Promise<GroupMessagingClient> => {
  const wallet = new KeyDeriver(PrivateKey.fromRandom())
  return GroupMessagingClient.create({
    wallet,
    storage: new Map(),
    transport: wrap(hub.endpoint(wallet.identityKey))
  })
}

/** A KeyPackage from a client that never has to join anything. */
const mint = async (client: GroupMessagingClient): Promise<KeyPackageBytes> =>
  (await client.keyPackages.create()).keyPackage

/** A backend that refuses MLS traffic and passes bootstrap traffic through. */
const refuseMls = (backend: TransportBackend): TransportBackend => ({
  ...backend,
  send: async (recipient: IdentityKey, payload: WirePayload) => {
    if (decodeEnvelope(payload).kind === 'mls') throw new Error('no route to member')
    await backend.send(recipient, payload)
  }
})

describe('Group.addMembers', () => {
  it('delivers the Welcome even when the Commit broadcast fails', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub, refuseMls)
    const carol = await openClient(hub)
    const bob = await openClient(hub)

    const own = await alice.keyPackages.create()
    const group = await alice.createGroup({
      chatId: 'chat-a',
      members: [await mint(carol)],
      name: 'Project Alpha',
      privateKeyPackage: own.privateKeyPackage
    })

    // The Commit cannot reach Carol, but Bob's leaf is already in the local
    // ratchet tree: without his Welcome he can never join the group he is in.
    const bobOwn = await bob.keyPackages.create()
    await expect(group.addMembers([bobOwn.keyPackage])).rejects.toThrow()

    const [invite] = await bob.invites.list('inbound')
    expect(invite?.kind).toBe('welcome')
    expect(invite?.peer).toBe(alice.identityKey)
    expect(invite?.chatName).toBe('Project Alpha')

    // And it is a Welcome he can actually use.
    const joined = await bob.joinFromWelcome({
      inviteId: invite!.inviteId,
      chatId: 'chat-b',
      privateKeyPackage: bobOwn.privateKeyPackage
    })
    const info = await joined.info()
    expect(info.mlsGroupId).toBe(group.mlsGroupId)
    expect(info.members.map(member => member.identityKey).sort()).toEqual(
      [alice.identityKey, bob.identityKey, carol.identityKey].sort()
    )

    await Promise.all([alice.close(), bob.close(), carol.close()])
  })
})

/** A solo group, plus the plaintext of everything it sends. */
const soloGroup = async (): Promise<{
  client: GroupMessagingClient
  group: Group
  sent: Uint8Array[]
}> => {
  const hub = new InProcessTransportHub()
  const client = await openClient(hub)
  const own = await client.keyPackages.create()
  const group = await client.createGroup({
    chatId: 'chat-solo',
    members: [],
    privateKeyPackage: own.privateKeyPackage
  })

  const sent: Uint8Array[] = []
  const encrypt = client.engine.encrypt.bind(client.engine)
  vi.spyOn(client.engine, 'encrypt').mockImplementation(async input => {
    sent.push(input.plaintext)
    return encrypt(input)
  })

  return { client, group, sent }
}

const attachment: RemoteAttachment = {
  mimeType: 'image/png',
  contentHash: 'sha256-00',
  encAlg: 'AES-256-GCM',
  key: 'a2V5',
  nonce: 'bm9uY2U=',
  url: 'https://example.invalid/a.png'
}

describe('Group sending', () => {
  it('sends text', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendText('hello')

    expect(decodeContent(sent[0]!)).toEqual({ v: 1, type: 'text', body: 'hello' })
    await client.close()
  })

  it('sends Markdown, falling back to the source as the plain-text body', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendMarkdown('**bold**')
    await group.sendMarkdown('**bold**', 'bold')

    expect(decodeContent(sent[0]!)).toEqual({
      v: 1,
      type: 'markdown',
      body: '**bold**',
      markdown: '**bold**'
    })
    expect(decodeContent(sent[1]!)).toMatchObject({ body: 'bold', markdown: '**bold**' })
    await client.close()
  })

  it('sends a remote attachment, naming it from the body, the filename, then a default', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendRemoteAttachment(attachment, 'look at this')
    await group.sendRemoteAttachment({ ...attachment, filename: 'a.png' })
    await group.sendRemoteAttachment(attachment)

    expect(decodeContent(sent[0]!)).toEqual({
      v: 1,
      type: 'remoteAttachment',
      body: 'look at this',
      attachments: [attachment]
    })
    expect(decodeContent(sent[1]!)?.body).toBe('a.png')
    expect(decodeContent(sent[2]!)?.body).toBe('Attachment')
    await client.close()
  })

  it('sends a reaction, defaulting to an added unicode one', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendReaction({ reference: 'm1', content: '👍' })
    await group.sendReaction({
      reference: 'm1',
      content: ':tada:',
      action: 'removed',
      schema: 'shortcode'
    })

    expect(decodeContent(sent[0]!)).toEqual({
      v: 1,
      type: 'reaction',
      body: '👍',
      reaction: { reference: 'm1', action: 'added', content: '👍', schema: 'unicode' }
    })
    expect(decodeContent(sent[1]!)?.reaction).toEqual({
      reference: 'm1',
      action: 'removed',
      content: ':tada:',
      schema: 'shortcode'
    })
    await client.close()
  })

  it('sends a reply, omitting markdown entirely when none was given', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendReply({ reference: 'm1', body: 'agreed' })
    await group.sendReply({ reference: 'm1', body: 'agreed', markdown: '_agreed_' })

    expect(decodeContent(sent[0]!)).toEqual({
      v: 1,
      type: 'reply',
      body: 'agreed',
      replyTo: 'm1'
    })
    expect(decodeContent(sent[0]!)).not.toHaveProperty('markdown')
    expect(decodeContent(sent[1]!)?.markdown).toBe('_agreed_')
    await client.close()
  })

  it('sends an already-constructed envelope untouched', async () => {
    const { client, group, sent } = await soloGroup()
    await group.sendContent({ v: 1, type: 'vendor.poll', body: 'Lunch?', extra: { options: 2 } })

    expect(decodeContent(sent[0]!)).toEqual({
      v: 1,
      type: 'vendor.poll',
      body: 'Lunch?',
      extra: { options: 2 }
    })
    await client.close()
  })
})

/** One MLS frame this backend was asked to send, refused or not. */
interface Attempt {
  to: IdentityKey
  payload: WirePayload
}

/**
 * Refuses MLS traffic to whichever members a mutable set names, and records
 * every MLS frame it was asked to send.
 *
 * The record is the seam a claim about *who was sent what* has to be made at.
 * Asserting on what a member received cannot distinguish "never sent it" from
 * "sent it and the member refused the duplicate" — MLS refuses a replayed
 * generation inside `MlsEngine.process`, so both look like one `message`.
 */
const refuseMlsTo = (
  backend: TransportBackend,
  blocked: () => ReadonlySet<IdentityKey>,
  attempts: Attempt[]
): TransportBackend => ({
  ...backend,
  send: async (recipient: IdentityKey, payload: WirePayload) => {
    if (decodeEnvelope(payload).kind !== 'mls') {
      await backend.send(recipient, payload)
      return
    }
    attempts.push({ to: recipient, payload })
    if (blocked().has(recipient)) throw new Error('no route to member')
    await backend.send(recipient, payload)
  }
})

/** Alice, Bob and Carol in one group, with Alice's MLS route under test control. */
const trio = async (
  blocked: () => ReadonlySet<IdentityKey>
): Promise<{
  alice: GroupMessagingClient
  bob: GroupMessagingClient
  carol: GroupMessagingClient
  group: Group
  /** Every MLS frame Alice's transport was asked to send, in order. */
  attempts: Attempt[]
}> => {
  const hub = new InProcessTransportHub()
  const attempts: Attempt[] = []
  const alice = await openClient(hub, backend => refuseMlsTo(backend, blocked, attempts))
  const bob = await openClient(hub)
  const carol = await openClient(hub)

  const joins = [bob, carol].map(
    async member =>
      new Promise<void>(resolve => {
        const stop = member.on('welcomeReceived', ({ inviteId }) => {
          stop()
          void member
            .joinFromWelcome({ inviteId, chatId: 'chat-a', privateKeyPackage: keys.get(member)! })
            .then(() => resolve())
        })
      })
  )
  const keys = new Map<GroupMessagingClient, PrivateKeyPackageBytes>()
  const packages = await Promise.all(
    [bob, carol].map(async member => {
      const created = await member.keyPackages.create()
      keys.set(member, created.privateKeyPackage)
      return created.keyPackage
    })
  )

  const own = await alice.keyPackages.create()
  const group = await alice.createGroup({
    chatId: 'chat-a',
    members: packages,
    name: 'Project Alpha',
    privateKeyPackage: own.privateKeyPackage
  })
  await Promise.all(joins)

  return { alice, bob, carol, group, attempts }
}

describe('deliveryFailed', () => {
  it('names the members a delivery did not reach, not the whole roster', async () => {
    // The roster and the failures are different facts, and reporting the first
    // where the second belongs made a send that reached 2 of 3 members
    // indistinguishable from one that reached none.
    let blocked = new Set<IdentityKey>()
    const { alice, bob, carol, group } = await trio(() => blocked)
    blocked = new Set([carol.identityKey])

    const failures: Array<{ recipients: IdentityKey[]; failed: IdentityKey[] | undefined }> = []
    alice.on('deliveryFailed', ({ recipients, failed }) => {
      failures.push({ recipients, failed })
    })
    await expect(group.sendText('hello')).rejects.toThrow()

    expect(failures).toHaveLength(1)
    expect([...failures[0]!.recipients].sort()).toEqual([bob.identityKey, carol.identityKey].sort())
    expect(failures[0]!.failed).toEqual([carol.identityKey])

    await Promise.all([alice.close(), bob.close(), carol.close()])
  })

  it('leaves `failed` absent when the transport did not say who was missed', async () => {
    // A backend with its own `broadcast` throws whatever it throws; the
    // partition is genuinely unknown. An empty array would read as "nothing
    // failed" and a full one as "everything did — neither is known here.
    let blocked = new Set<IdentityKey>()
    const { alice, bob, carol, group } = await trio(() => blocked)
    blocked = new Set([bob.identityKey, carol.identityKey])
    // Replaces the fan-out entirely, so nothing counts per recipient.
    ;(alice.transport as unknown as { backend: TransportBackend }).backend.broadcast = async () => {
      throw new Error('relay exploded')
    }

    const failures: Array<{ recipients: IdentityKey[]; failed: IdentityKey[] | undefined }> = []
    alice.on('deliveryFailed', ({ recipients, failed }) => {
      failures.push({ recipients, failed })
    })
    await expect(group.sendText('hello')).rejects.toThrow('relay exploded')

    expect(failures).toHaveLength(1)
    expect(failures[0]!.recipients).toHaveLength(2)
    expect(failures[0]!.failed).toBeUndefined()

    await Promise.all([alice.close(), bob.close(), carol.close()])
  })
})

describe('GroupMessagingClient.retryDelivery', () => {
  it('re-sends the same bytes to the members that missed them, and to nobody else', async () => {
    let blocked = new Set<IdentityKey>()
    const { alice, bob, carol, group, attempts } = await trio(() => blocked)
    const carolSaw: string[] = []
    const bobRefused: string[] = []
    carol.on('message', ({ content }) => void carolSaw.push(String(content.body)))
    // A duplicate reaching Bob would land here, not on `message` — so this is
    // what distinguishes "never re-sent to Bob" from "re-sent and refused".
    bob.on('processingFailed', ({ error }) => void bobRefused.push(error.message))

    blocked = new Set([carol.identityKey])
    const error = (await group.sendText('hello').catch((cause: unknown) => cause)) as BroadcastError
    const sentToBob = attempts.filter(attempt => attempt.to === bob.identityKey)
    expect(sentToBob).toHaveLength(1)
    expect(carolSaw).toEqual([])

    blocked = new Set()
    await alice.retryDelivery(error)
    await vi.waitFor(() => expect(carolSaw).toEqual(['hello']))

    // Bob already had it and is not asked to take it again.
    expect(attempts.filter(attempt => attempt.to === bob.identityKey)).toHaveLength(1)
    expect(bobRefused).toEqual([])
    // Not a new message: the retry put the first attempt's bytes back on the
    // wire, rather than encrypting the text again — which would be a second
    // message burning a second generation. The epoch is no evidence of this;
    // an application message never moves it.
    const sentToCarol = attempts.filter(attempt => attempt.to === carol.identityKey)
    expect(sentToCarol).toHaveLength(2)
    expect(sentToCarol[1]!.payload).toEqual(sentToCarol[0]!.payload)
    expect(sentToCarol[1]!.payload).toBe(error.payload)

    await Promise.all([alice.close(), bob.close(), carol.close()])
  })

  it('rejects with a fresh BroadcastError when the member is still unreachable', async () => {
    let blocked = new Set<IdentityKey>()
    const { alice, bob, carol, group } = await trio(() => blocked)
    blocked = new Set([carol.identityKey])
    const error = (await group.sendText('hello').catch((cause: unknown) => cause)) as BroadcastError

    const again = await alice.retryDelivery(error).catch((cause: unknown) => cause)

    expect(again).toBeInstanceOf(BroadcastError)
    expect((again as BroadcastError).failed).toEqual([carol.identityKey])
    expect((again as BroadcastError).delivered).toBe(0)

    await Promise.all([alice.close(), bob.close(), carol.close()])
  })
})

describe('GroupMessagingClient.retryDelivery on a lost Welcome', () => {
  it('resends the same Welcome bytes, and rejects with a fresh error while still unreachable', async () => {
    const hub = new InProcessTransportHub()
    const alice = await openClient(hub)
    const bob = await openClient(hub)
    const bobHalf = await bob.keyPackages.create()
    const own = await alice.keyPackages.create()

    let blocked = true
    const inner = alice.transport.send.bind(alice.transport)
    alice.transport.send = async (to, payload) => {
      const envelope = decodeEnvelope(payload)
      if (blocked && envelope.kind === 'bootstrap' && envelope.message.type === 'welcome') {
        throw new Error('relay 502')
      }
      await inner(to, payload)
    }
    const received: Array<{ welcome: Uint8Array; chatName?: string | undefined }> = []
    bob.on('welcomeReceived', ({ welcome, chatName }) => void received.push({ welcome, chatName }))

    const lost = (await alice
      .createGroup({
        chatId: 'chat',
        name: 'Project',
        members: [bobHalf.keyPackage],
        privateKeyPackage: own.privateKeyPackage
      })
      .catch((cause: unknown) => cause)) as WelcomeDeliveryError
    expect(lost).toBeInstanceOf(WelcomeDeliveryError)

    const again = (await alice
      .retryDelivery(lost)
      .catch((cause: unknown) => cause)) as WelcomeDeliveryError
    expect(again).toBeInstanceOf(WelcomeDeliveryError)
    expect(again.failed).toEqual([bob.identityKey])
    expect(again.welcome).toBe(lost.welcome)
    expect(received).toEqual([])

    blocked = false
    await alice.retryDelivery(again)
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]!.welcome).toEqual(lost.welcome)
    expect(received[0]!.chatName).toBe('Project')
    expect((await (await alice.getGroup('chat'))!.info()).members).toHaveLength(2)

    await Promise.all([alice.close(), bob.close()])
  })
})
