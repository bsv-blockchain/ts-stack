import { describe, expect, it, vi } from 'vitest'
import { decodeEnvelope, type BootstrapMessage } from '../../bootstrap/index.js'
import { GroupMessagingError } from '../../errors.js'
import { StorageProvider } from '../../storage/index.js'
import { TransportService } from '../../transport/index.js'
import { InProcessTransportHub } from '../../transport/backends/in-process.js'
import { DEFAULT_CIPHERSUITE, type KeyPackageBytes } from '../../types.js'
import {
  InviteService,
  MAX_PENDING_INBOUND_REQUESTS,
  type InviteServiceDeps
} from '../invite-service.js'
import { PermanentProcessingError } from '../../errors.js'
import type { KeyPackageRef } from '../../types.js'

const ALICE = `02${'aa'.repeat(32)}`
const BOB = `02${'bb'.repeat(32)}`
const CAROL = `02${'cc'.repeat(32)}`

const build = async (overrides: Partial<Pick<InviteServiceDeps, 'resolveWelcome'>> = {}) => {
  const hub = new InProcessTransportHub()
  const sent: Array<{ to: string; payload: Uint8Array }> = []
  const aliceTransport = await TransportService.open({
    send: async (to, payload) => {
      sent.push({ to, payload })
    },
    onMessage: () => () => undefined
  })
  const emit = vi.fn()
  const storage = StorageProvider.memory()
  const service = new InviteService({
    identityKey: ALICE,
    storage,
    transport: aliceTransport,
    ciphersuite: DEFAULT_CIPHERSUITE,
    emit,
    resolveWelcome: async () => undefined,
    ...overrides
  })
  return { service, sent, emit, hub, storage }
}

describe('InviteService.send', () => {
  it('records an outbound invite and puts a request on the wire', async () => {
    const { service, sent } = await build()

    const inviteId = await service.send(BOB, { chatName: 'Project Alpha' })

    const invites = await service.list('outbound')
    expect(invites).toHaveLength(1)
    expect(invites[0]!.inviteId).toBe(inviteId)
    expect(invites[0]!.peer).toBe(BOB)

    expect(sent).toHaveLength(1)
    const envelope = decodeEnvelope(sent[0]!.payload)
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageRequest') {
      throw new Error('wrong envelope')
    }
    expect(envelope.message.chatName).toBe('Project Alpha')
    expect(envelope.message.requestId).toBe(invites[0]!.requestId)
  })

  it('gives the invite a local id distinct from the wire requestId', async () => {
    const { service } = await build()
    const inviteId = await service.send(BOB)
    const invite = (await service.list('outbound'))[0]!
    expect(invite.requestId).not.toBe(inviteId)
  })
})

describe('InviteService.handle', () => {
  it('stores an inbound request and emits inviteReceived without minting', async () => {
    const { service, emit, sent } = await build()

    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: [DEFAULT_CIPHERSUITE],
      chatName: 'Alpha'
    })

    const inbound = await service.list('inbound')
    expect(inbound).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(
      'inviteReceived',
      expect.objectContaining({ peer: BOB, chatName: 'Alpha' })
    )
    // Nothing is minted and nothing is answered until a human accepts.
    expect(sent).toHaveLength(0)
  })

  it('emits keyPackageReceived and clears the outbound invite on a response', async () => {
    const { service, emit } = await build()
    await service.send(BOB)
    const requestId = (await service.list('outbound'))[0]!.requestId
    const keyPackage = new Uint8Array([1, 2, 3]) as KeyPackageBytes

    await service.handle(BOB, { type: 'keyPackageResponse', requestId, keyPackage })

    expect(emit).toHaveBeenCalledWith(
      'keyPackageReceived',
      expect.objectContaining({ peer: BOB, keyPackage })
    )
    expect(await service.list('outbound')).toHaveLength(0)
  })

  it('emits inviteDeclined and clears the outbound invite on a decline', async () => {
    const { service, emit } = await build()
    await service.send(BOB)
    const requestId = (await service.list('outbound'))[0]!.requestId

    await service.handle(BOB, { type: 'keyPackageDecline', requestId })

    expect(emit).toHaveBeenCalledWith('inviteDeclined', expect.objectContaining({ peer: BOB }))
    expect(await service.list('outbound')).toHaveLength(0)
  })

  it('reports, rather than drops, a response for a requestId it never sent', async () => {
    const { service, emit } = await build()

    await service.handle(BOB, {
      type: 'keyPackageResponse',
      requestId: 'unknown',
      keyPackage: new Uint8Array([1]) as KeyPackageBytes
    })

    expect(emit).toHaveBeenCalledWith('bootstrapRefused', {
      peer: BOB,
      kind: 'keyPackageResponse',
      requestId: 'unknown',
      reason: 'no outbound invitation matches this request id and sender'
    })
    expect(await service.list()).toHaveLength(0)
  })

  it('reports, rather than drops, a decline for a requestId it never sent', async () => {
    const { service, emit } = await build()

    await service.handle(BOB, { type: 'keyPackageDecline', requestId: 'unknown' })

    expect(emit).toHaveBeenCalledWith('bootstrapRefused', {
      peer: BOB,
      kind: 'keyPackageDecline',
      requestId: 'unknown',
      reason: 'no outbound invitation matches this request id and sender'
    })
    expect(await service.list()).toHaveLength(0)
  })
})

describe('InviteService.handle rejects forged answers', () => {
  /**
   * The peer chooses the requestId in the request it sends us. Echoing it back
   * as a response must not resolve to our own inbound invite: that would both
   * consume the invite awaiting a human decision and surface attacker-chosen
   * bytes as a KeyPackage we asked for.
   */
  it('reports, rather than acts on, a response whose requestId matches only our own inbound invite', async () => {
    const { service, emit } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: [DEFAULT_CIPHERSUITE]
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId
    emit.mockClear()

    await service.handle(BOB, {
      type: 'keyPackageResponse',
      requestId: 'r1',
      keyPackage: new Uint8Array([9, 9, 9]) as KeyPackageBytes
    })

    expect(emit).toHaveBeenCalledWith('bootstrapRefused', {
      peer: BOB,
      kind: 'keyPackageResponse',
      requestId: 'r1',
      reason: 'no outbound invitation matches this request id and sender'
    })
    const inbound = await service.list('inbound')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.inviteId).toBe(inviteId)
  })

  it('reports, rather than acts on, a decline whose requestId matches only our own inbound invite', async () => {
    const { service, emit } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: [DEFAULT_CIPHERSUITE]
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId
    emit.mockClear()

    await service.handle(BOB, { type: 'keyPackageDecline', requestId: 'r1' })

    expect(emit).toHaveBeenCalledWith('bootstrapRefused', {
      peer: BOB,
      kind: 'keyPackageDecline',
      requestId: 'r1',
      reason: 'no outbound invitation matches this request id and sender'
    })
    const inbound = await service.list('inbound')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.inviteId).toBe(inviteId)
  })

  it('reports, rather than acts on, a response from a peer we never sent that request to', async () => {
    const { service, emit } = await build()
    const inviteId = await service.send(BOB)
    const requestId = (await service.list('outbound'))[0]!.requestId
    emit.mockClear()

    await service.handle(CAROL, {
      type: 'keyPackageResponse',
      requestId,
      keyPackage: new Uint8Array([9, 9, 9]) as KeyPackageBytes
    })

    expect(emit).toHaveBeenCalledWith('bootstrapRefused', {
      peer: CAROL,
      kind: 'keyPackageResponse',
      requestId,
      reason: 'no outbound invitation matches this request id and sender'
    })
    const outbound = await service.list('outbound')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.inviteId).toBe(inviteId)
  })
})

describe('InviteService.accept and decline', () => {
  it('sends the supplied KeyPackage and clears the invite', async () => {
    const { service, sent } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: [DEFAULT_CIPHERSUITE]
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId
    const keyPackage = new Uint8Array([7, 7]) as KeyPackageBytes

    await service.accept(inviteId, keyPackage)

    const envelope = decodeEnvelope(sent[0]!.payload)
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageResponse') {
      throw new Error('wrong envelope')
    }
    expect(envelope.message.requestId).toBe('r1')
    expect(envelope.message.keyPackage).toEqual(keyPackage)
    expect(await service.list('inbound')).toHaveLength(0)
  })

  it('sends a decline and clears the invite', async () => {
    const { service, sent } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: [DEFAULT_CIPHERSUITE]
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId

    await service.decline(inviteId)

    const envelope = decodeEnvelope(sent[0]!.payload)
    if (envelope.kind !== 'bootstrap' || envelope.message.type !== 'keyPackageDecline') {
      throw new Error('wrong envelope')
    }
    expect(await service.list('inbound')).toHaveLength(0)
  })

  it('rejects accepting an invite that does not exist', async () => {
    const { service } = await build()
    await expect(service.accept('nope', new Uint8Array([1]) as KeyPackageBytes)).rejects.toThrow()
  })

  it('refuses an invitation for a ciphersuite this client is not configured for', async () => {
    const { service, sent } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: ['MLS_128_DHKEMP256_AES128GCM_SHA256_P256']
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId

    // The error must name both suites: the caller has to see which side to change.
    await expect(
      service.accept(inviteId, new Uint8Array([7, 7]) as KeyPackageBytes)
    ).rejects.toThrow(new RegExp(`MLS_128_DHKEMP256_AES128GCM_SHA256_P256.*${DEFAULT_CIPHERSUITE}`))
    await expect(
      service.accept(inviteId, new Uint8Array([7, 7]) as KeyPackageBytes)
    ).rejects.toThrow(GroupMessagingError)

    // Nothing answered, and the invitation is still there to be declined.
    expect(sent).toHaveLength(0)
    expect(await service.list('inbound')).toHaveLength(1)
  })

  it("accepts an invitation that offers this client's suite among others", async () => {
    const { service, sent } = await build()
    await service.handle(BOB, {
      type: 'keyPackageRequest',
      requestId: 'r1',
      ciphersuites: ['MLS_128_DHKEMP256_AES128GCM_SHA256_P256', DEFAULT_CIPHERSUITE]
    })
    const inviteId = (await service.list('inbound'))[0]!.inviteId

    await service.accept(inviteId, new Uint8Array([7, 7]) as KeyPackageBytes)

    expect(sent).toHaveLength(1)
  })
})

describe('InviteService.handle welcome', () => {
  const WELCOME = new Uint8Array([1, 2, 3, 4])
  const message = { type: 'welcome', requestId: 'r1', welcome: WELCOME } as const

  it('stores nothing when the Welcome matches no KeyPackage this device holds', async () => {
    const { service } = await build({ resolveWelcome: async () => undefined })

    await service.handle(BOB, message)

    expect(await service.list('inbound')).toHaveLength(0)
  })

  it('emits bootstrapRefused when the Welcome names no KeyPackage this device holds', async () => {
    const { service, emit } = await build({ resolveWelcome: async () => undefined })

    await service.handle(BOB, message)

    expect(emit).toHaveBeenCalledWith(
      'bootstrapRefused',
      expect.objectContaining({ peer: BOB, kind: 'welcome' })
    )
  })

  it('stores nothing when the Welcome cannot be decoded', async () => {
    const { service } = await build({
      resolveWelcome: async () => {
        throw new Error('not a Welcome')
      }
    })

    await expect(service.handle(BOB, message)).rejects.toThrow(PermanentProcessingError)
    expect(await service.list('inbound')).toHaveLength(0)
  })

  it('records the ref and the Welcome bytes when it is addressed to this device', async () => {
    const ref = 'deadbeef' as KeyPackageRef
    const { service } = await build({ resolveWelcome: async () => ref })

    await service.handle(BOB, message)

    const inbound = await service.list('inbound')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.ref).toBe(ref)
    expect(inbound[0]!.welcome).toBe('01020304')
  })
})

describe('InviteService.handle welcome is one-per-ref', () => {
  const WELCOME = new Uint8Array([1, 2, 3, 4])
  const message = { type: 'welcome', requestId: 'r1', welcome: WELCOME } as const

  /**
   * A KeyPackage is single-use, so at most one Welcome can legitimately consume
   * one. The ref a Welcome names is cleartext and unauthenticated, so without
   * this a peer holding our published KeyPackage can mint a row per forgery.
   */
  it('refuses a second Welcome naming a ref an invite already holds', async () => {
    const ref = 'deadbeef' as KeyPackageRef
    const { service, emit } = await build({ resolveWelcome: async () => ref })
    await service.handle(BOB, message)
    emit.mockClear()

    await service.handle(CAROL, { type: 'welcome', requestId: 'r2', welcome: WELCOME })

    expect(await service.list('inbound')).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(
      'bootstrapRefused',
      expect.objectContaining({ peer: CAROL, kind: 'welcome' })
    )
  })
})

describe('InviteService.accept refuses anything but an inbound request', () => {
  const WELCOME = new Uint8Array([1, 2, 3, 4])

  /**
   * Accepting a Welcome would answer it with a keyPackageResponse the peer
   * never asked for and then delete the only copy of the Welcome bytes, which
   * is the one thing that can still join that group.
   */
  it('refuses a welcome invite and keeps the Welcome bytes', async () => {
    const { service, sent } = await build({
      resolveWelcome: async () => 'deadbeef' as KeyPackageRef
    })
    await service.handle(BOB, { type: 'welcome', requestId: 'r1', welcome: WELCOME })
    const inviteId = (await service.list('inbound'))[0]!.inviteId

    await expect(
      service.accept(inviteId, new Uint8Array([7, 7]) as KeyPackageBytes)
    ).rejects.toThrow(GroupMessagingError)

    expect(sent).toHaveLength(0)
    const inbound = await service.list('inbound')
    expect(inbound).toHaveLength(1)
    expect(inbound[0]!.welcome).toBe('01020304')
  })

  it('refuses our own outbound request and keeps it pending', async () => {
    const { service, sent } = await build()
    const inviteId = await service.send(BOB)
    sent.length = 0

    await expect(
      service.accept(inviteId, new Uint8Array([7, 7]) as KeyPackageBytes)
    ).rejects.toThrow(GroupMessagingError)

    expect(sent).toHaveLength(0)
    expect(await service.list('outbound')).toHaveLength(1)
  })
})

describe('InviteService.handle resolves answers by direction', () => {
  /**
   * The peer we sent a request to knows its requestId and can send us a request
   * of their own bearing the same value. Their genuine response must still
   * resolve to our outbound row rather than to that collision.
   */
  it('accepts a response when an inbound invite shares the requestId', async () => {
    const { service, emit, storage } = await build()
    await storage.putInvite({
      inviteId: 'inbound-first',
      direction: 'inbound',
      kind: 'keyPackageRequest',
      peer: BOB,
      requestId: 'shared',
      receivedAt: 't'
    })
    await storage.putInvite({
      inviteId: 'ours',
      direction: 'outbound',
      kind: 'keyPackageRequest',
      peer: BOB,
      requestId: 'shared',
      receivedAt: 't'
    })

    await service.handle(BOB, {
      type: 'keyPackageResponse',
      requestId: 'shared',
      keyPackage: new Uint8Array([1, 2]) as KeyPackageBytes
    })

    expect(emit).toHaveBeenCalledWith(
      'keyPackageReceived',
      expect.objectContaining({ inviteId: 'ours', peer: BOB })
    )
    expect((await service.list('inbound')).map(i => i.inviteId)).toEqual(['inbound-first'])
  })
})

describe('InviteService.handle bounds inbound requests', () => {
  const request = (requestId: string): BootstrapMessage => ({
    type: 'keyPackageRequest',
    requestId,
    ciphersuites: [DEFAULT_CIPHERSUITE]
  })

  it('refuses a repeat of a request id already pending from that peer', async () => {
    const { service, emit } = await build()
    await service.handle(BOB, request('r1'))
    emit.mockClear()

    await service.handle(BOB, request('r1'))

    expect(await service.list('inbound')).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(
      'bootstrapRefused',
      expect.objectContaining({ peer: BOB, kind: 'keyPackageRequest' })
    )
    expect(emit).not.toHaveBeenCalledWith('inviteReceived', expect.anything())
  })

  it('stores the same request id from a different peer', async () => {
    const { service } = await build()
    await service.handle(BOB, request('r1'))

    await service.handle(CAROL, request('r1'))

    expect(await service.list('inbound')).toHaveLength(2)
  })

  it('refuses inbound requests beyond the cap instead of growing the database', async () => {
    const { service, emit } = await build()
    for (let i = 0; i < MAX_PENDING_INBOUND_REQUESTS; i++) {
      await service.handle(BOB, request(`r${i}`))
    }
    emit.mockClear()

    await service.handle(CAROL, request('one-too-many'))

    expect(await service.list('inbound')).toHaveLength(MAX_PENDING_INBOUND_REQUESTS)
    expect(emit).toHaveBeenCalledWith(
      'bootstrapRefused',
      expect.objectContaining({ peer: CAROL, kind: 'keyPackageRequest' })
    )
  })
})

describe('InviteService.handle refuses an unserveable request', () => {
  /**
   * `decodeEnvelope` narrows the offer to suites this library has, so an empty
   * list means the peer asked for nothing we can answer. Storing it would put
   * a row in front of a user whose only possible outcome is a decline.
   */
  it('reports rather than stores a request offering no suite we serve', async () => {
    const { service, emit } = await build()

    await service.handle(BOB, { type: 'keyPackageRequest', requestId: 'r1', ciphersuites: [] })

    expect(await service.list('inbound')).toHaveLength(0)
    expect(emit).toHaveBeenCalledWith(
      'bootstrapRefused',
      expect.objectContaining({ peer: BOB, kind: 'keyPackageRequest' })
    )
  })
})
