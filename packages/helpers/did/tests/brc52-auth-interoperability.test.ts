import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Peer } from '@bsv/sdk/auth/Peer'
import type { AuthMessage, Transport } from '@bsv/sdk/auth/types'
import PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import ProtoWallet from '@bsv/sdk/wallet/ProtoWallet'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import {
  BRC52MemoryNonceStore,
  receiveBRC52Disclosure,
  type BRC52AuthenticationPort,
  type BRC52DisclosureResult
} from '../src/brc52/disclosure.js'
import type { BRC52StatusResult } from '../src/brc52/status.js'
import type { BRC52Envelope } from '../src/brc52/types.js'

// Frozen synthetic certificate and keyring. Only authentication messages are signed here.
// All private scalars and nonces in this test are public fixtures, never live credentials.
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/brc203-envelope.json'), 'utf8')
) as BRC52Envelope
const subject = new PrivateKey(2).toPublicKey().toString()
const verifier = new PrivateKey(4).toPublicKey().toString()
const envelope: BRC52Envelope = {
  ...fixture,
  disclosure: {
    subject,
    verifier,
    keyring: {
      name: 'cXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXGMm+yffJMsUvp6/+TM6ou3MI05v+fhM3j3Lj2ODJrpVNEtawBoIT+ZrArRr1xQjwE='
    }
  }
}
const exactEnvelope = JSON.stringify(envelope)
const operation = 'POST /certificate/name'
const purpose = 'display the name with user permission'
const now = 100_000

// This is the test application's payload framing, NOT a BRC-203 envelope change
// or a proposed standardized BRC-103 wire format. Peer signs every payload byte.
interface ApplicationFrame {
  envelope: string
  recipient: string
  operation: string
  purpose: string
  nonce: string
  issuedAt: number
  applicationSession: string
}

function frame(overrides: Partial<ApplicationFrame> = {}): ApplicationFrame {
  return {
    envelope: exactEnvelope,
    recipient: verifier,
    operation,
    purpose,
    nonce: 'public-synthetic-application-nonce-1',
    issuedAt: now,
    applicationSession: 'offline-display-application-session',
    ...overrides
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

// Peer requires WalletInterface; every available ProtoWallet cryptographic method
// remains real. Any request for provider, funds or certificate issuance fails closed.
function offlineWallet(scalar: number): WalletInterface {
  const wallet = new ProtoWallet(new PrivateKey(scalar))
  return new Proxy(wallet, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property)
      if (typeof value === 'function') return value.bind(target)
      if (value !== undefined) return value
      return () => {
        throw new Error(`Offline wallet does not implement ${String(property)}`)
      }
    }
  }) as unknown as WalletInterface
}

class MemoryTransport implements Transport {
  peer?: MemoryTransport
  callback?: (message: AuthMessage) => Promise<void>
  lastGeneral?: AuthMessage
  alterGeneral?: (message: AuthMessage) => void

  connect(peer: MemoryTransport): void {
    this.peer = peer
    peer.peer = this
  }

  async send(message: AuthMessage): Promise<void> {
    const callback = this.peer?.callback
    if (callback === undefined) throw new Error('In-memory transport disconnected')
    const packet = structuredClone(message)
    if (packet.messageType === 'general') {
      this.alterGeneral?.(packet)
      this.lastGeneral = structuredClone(packet)
      await callback(packet)
    } else {
      // Handshake response waiters must be registered before dispatching responses.
      // Unlike general messages, handshakes do not re-enter the sender synchronously.
      queueMicrotask(() => {
        void callback(packet).catch(error => {
          this.handshakeErrors.push(error)
        })
      })
    }
  }

  readonly handshakeErrors: unknown[] = []

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.callback = callback
  }
}

function offlineStatus(): BRC52StatusResult {
  return {
    status: 'unknown',
    outpoint: fixture.credential.revocationOutpoint,
    network: 'synthetic-offline',
    privacy: {
      mode: 'local-chain-view',
      retrievalAttempted: false,
      protection: 'No network or issuer query in this fixture',
      thirdPartyCorrelation: 'none'
    }
  }
}

async function harness(senderScalar = 2, requiresCurrentStatus = false) {
  const outgoing = new MemoryTransport()
  const incoming = new MemoryTransport()
  outgoing.connect(incoming)
  const sender = new Peer(offlineWallet(senderScalar), outgoing)
  const wallet = offlineWallet(4)
  const receiver = new Peer(wallet, incoming)
  await Promise.all([sender.ready, receiver.ready])
  const plaintext: BRC52DisclosureResult[] = []
  const nonceStore = new BRC52MemoryNonceStore()
  let deliveries = 0
  let relianceCalls = 0
  receiver.listenForGeneralMessages(async (authenticatedPeer, signedPayload) => {
    deliveries++
    const application = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(signedPayload))
    ) as ApplicationFrame
    if (
      application.recipient !== verifier ||
      application.operation !== operation ||
      application.purpose !== purpose ||
      application.applicationSession !== 'offline-display-application-session'
    )
      throw new Error('Signed application routing/purpose mismatch')
    if (
      !Number.isSafeInteger(application.issuedAt) ||
      application.issuedAt > now ||
      now - application.issuedAt > 5_000
    )
      throw new Error('Signed application freshness rejected')
    const payload = bytes(application.envelope)
    let receiptConsumed = false
    // This capability exists only inside the successfully verified Peer callback.
    // Peer exports no general-message protocol nonce/session/time receipt. nonce and
    // sessionId below are signed APPLICATION context; authenticatedAt is local dispatch
    // time. SDK replay protection and the application replay policy are both exercised.
    const authentication: BRC52AuthenticationPort = {
      async authenticate(request) {
        if (
          receiptConsumed ||
          request.operation !== application.operation ||
          request.purpose !== application.purpose ||
          request.receivingVerifier !== application.recipient ||
          !Buffer.from(request.payload).equals(Buffer.from(payload))
        )
          throw new Error('Dispatcher capability payload/context mismatch')
        receiptConsumed = true
        return {
          peer: authenticatedPeer,
          receivingVerifier: application.recipient,
          payload: payload.slice(),
          operation: application.operation,
          purpose: application.purpose,
          nonce: application.nonce,
          authenticatedAt: now,
          sessionId: application.applicationSession
        }
      }
    }
    const result = await receiveBRC52Disclosure({
      inputData: payload,
      wallet,
      receivingVerifier: verifier,
      operation,
      purpose,
      authentication,
      nonceStore,
      now: () => now,
      maxRequestAgeMs: 5_000,
      async assessReliance(request) {
        relianceCalls++
        expect(request.authenticatedRequest.peer).toBe(subject)
        expect(request.fieldsToReveal).toEqual(['name'])
        const status = offlineStatus()
        // Display-only policy explicitly accepts unknown. A current-status policy
        // rejects it; no issuer query, invented current status or hidden trust verdict.
        return { authorized: !requiresCurrentStatus || status.status === 'notRevokedAsOf', status }
      }
    })
    plaintext.push(result)
  })
  return {
    sender,
    outgoing,
    incoming,
    plaintext,
    deliveries: () => deliveries,
    relianceCalls: () => relianceCalls,
    async send(application = frame()) {
      await sender.toPeer(Array.from(bytes(JSON.stringify(application))), verifier)
      expect(outgoing.handshakeErrors).toEqual([])
      expect(incoming.handshakeErrors).toEqual([])
    }
  }
}

describe('BRC-103 authenticated dispatch into BRC-52 disclosure (offline application integration)', () => {
  test('real paired wallets authenticate exact encrypted envelope and reveal only the authorized field', async () => {
    const pair = await harness()
    await pair.send()
    expect(pair.plaintext).toHaveLength(1)
    expect(pair.plaintext[0]!.disclosedFields).toEqual({ name: 'Alice Example' })
    expect(pair.plaintext[0]!.authenticatedRequest).toMatchObject({
      peer: subject,
      receivingVerifier: verifier,
      operation,
      purpose,
      nonce: frame().nonce
    })
    expect(pair.plaintext[0]!.status.status).toBe('unknown')
    expect(pair.plaintext[0]!.source.certificateBinary).toBe(fixture.certificateBinary)
    expect(JSON.stringify(pair.plaintext[0]!.verifiedDocument)).not.toContain('Alice Example')
    expect(pair.relianceCalls()).toBe(1)
  })

  test.each(['envelope', 'purpose', 'recipient', 'nonce'] as const)(
    'substituting signed %s in transit fails before dispatch/decryption',
    async field => {
      const pair = await harness()
      pair.outgoing.alterGeneral = packet => {
        const application = JSON.parse(
          new TextDecoder().decode(Uint8Array.from(packet.payload!))
        ) as ApplicationFrame
        application[field] += ' tampered'
        packet.payload = Array.from(bytes(JSON.stringify(application)))
      }
      await expect(pair.send()).rejects.toThrow(/signature/i)
      expect(pair.deliveries()).toBe(0)
      expect(pair.plaintext).toEqual([])
      expect(pair.relianceCalls()).toBe(0)
    }
  )

  test('valid authentication by another identity cannot present the subject keyring', async () => {
    const pair = await harness(3)
    await expect(pair.send()).rejects.toThrow(/peer|subject|context/i)
    expect(pair.deliveries()).toBe(1)
    expect(pair.relianceCalls()).toBe(0)
    expect(pair.plaintext).toEqual([])
  })

  test.each([
    { purpose: 'another purpose' },
    { recipient: subject },
    { operation: 'POST /another-route' },
    { issuedAt: now - 5_001 },
    { issuedAt: now + 1 }
  ])('signed but unauthorized context is rejected: %j', async overrides => {
    const pair = await harness()
    await expect(pair.send(frame(overrides))).rejects.toThrow(/routing|freshness/)
    expect(pair.plaintext).toEqual([])
    expect(pair.relianceCalls()).toBe(0)
  })

  test('SDK protocol replay is rejected before a second application dispatch', async () => {
    const pair = await harness()
    await pair.send()
    await expect(
      pair.incoming.callback!(structuredClone(pair.outgoing.lastGeneral!))
    ).rejects.toThrow(/replay|nonce/i)
    expect(pair.deliveries()).toBe(1)
    expect(pair.plaintext).toHaveLength(1)
  })

  test('new valid SDK message carrying reused application nonce is rejected before policy/decryption', async () => {
    const pair = await harness()
    await pair.send()
    const originalProtocolNonce = pair.outgoing.lastGeneral!.nonce
    await expect(pair.send()).rejects.toThrow(/nonce repeated|replay/i)
    expect(pair.outgoing.lastGeneral!.nonce).not.toBe(originalProtocolNonce)
    expect(pair.deliveries()).toBe(2)
    expect(pair.relianceCalls()).toBe(1)
    expect(pair.plaintext).toHaveLength(1)
  })

  test('a fresh signed application nonce permits another authorized display', async () => {
    const pair = await harness()
    await pair.send()
    await pair.send(frame({ nonce: 'public-synthetic-application-nonce-2' }))
    expect(pair.deliveries()).toBe(2)
    expect(pair.relianceCalls()).toBe(2)
    expect(pair.plaintext.map(result => result.disclosedFields)).toEqual([
      { name: 'Alice Example' },
      { name: 'Alice Example' }
    ])
  })

  test('application requiring current outpoint status refuses unknown without plaintext', async () => {
    const pair = await harness(2, true)
    await expect(pair.send()).rejects.toThrow(/reliance denied/i)
    expect(pair.relianceCalls()).toBe(1)
    expect(pair.plaintext).toEqual([])
  })
})
