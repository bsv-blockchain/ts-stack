import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it, vi } from 'vitest'
import { GroupMessagingClient } from '../client.js'
import { decodeEnvelope } from '../bootstrap/index.js'
import { decodeContent, type RemoteAttachment } from '../content/index.js'
import type { Group } from '../group.js'
import { InProcessTransportHub } from '../transport/backends/in-process.js'
import type { TransportBackend } from '../transport/index.js'
import type { IdentityKey, KeyPackageBytes, WirePayload } from '../types.js'

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
