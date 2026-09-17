import { describe, expect, it } from 'vitest'
import { encodeEnvelope } from '../../bootstrap/envelope.js'
import { asKeyPackageBytes, encodePrivateKeyPackage } from '../../mls/key-package-codec.js'
import type { IdentityKey, WirePayload } from '../../types.js'
import type { TransportBackend } from '../backend.js'
import { TransportService } from '../transport-service.js'

const BOB = `02${'bb'.repeat(32)}`

/**
 * Spec §4.1 has two halves, and both are tested here.
 *
 * The type-level half: each `@ts-expect-error` fails the build the moment
 * {@link WirePayload} is relaxed back to a bare `Uint8Array`. The runtime half:
 * a brand is erased once compiled, so nothing in a JavaScript caller's way stops
 * the same bytes being handed to `send`. Only well-formed envelopes go out.
 */
const recording = (): { backend: TransportBackend; sent: Uint8Array[] } => {
  const sent: Uint8Array[] = []
  return {
    sent,
    backend: {
      send: async (_recipient: IdentityKey, payload: WirePayload) => {
        sent.push(payload)
      },
      onMessage: () => () => undefined
    }
  }
}

describe('WirePayload', () => {
  const privateKeyPackage = encodePrivateKeyPackage({
    initPrivateKey: new Uint8Array(32).fill(1),
    hpkePrivateKey: new Uint8Array(32).fill(2),
    signaturePrivateKey: new Uint8Array(32).fill(3)
  })

  it('accepts a well-formed envelope', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)
    const envelope = encodeEnvelope({ kind: 'mls', payload: new Uint8Array([1, 2, 3]) })

    await transport.send(BOB, envelope)

    expect(sent).toEqual([envelope])
  })

  it('refuses a private KeyPackage', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)

    await expect(
      // @ts-expect-error a PrivateKeyPackageBytes must never reach the wire
      transport.send(BOB, privateKeyPackage)
    ).rejects.toThrow(/envelope/i)
    expect(sent).toHaveLength(0)
  })

  it('refuses a KeyPackage sent bare rather than in an envelope', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)
    // A ts-mls KeyPackage opens with the u16 protocol version, so its first byte
    // is zero where an envelope's is one.
    const keyPackage = asKeyPackageBytes(new Uint8Array([0, 1, 0, 1, 0, 0, 0, 0]))

    await expect(
      // @ts-expect-error KeyPackages travel inside a bootstrap envelope
      transport.send(BOB, keyPackage)
    ).rejects.toThrow(/envelope/i)
    expect(sent).toHaveLength(0)
  })

  it('refuses a private KeyPackage on broadcast too', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)

    await expect(
      // @ts-expect-error a PrivateKeyPackageBytes must never reach the wire
      transport.broadcast('g1', [BOB], privateKeyPackage)
    ).rejects.toThrow(/envelope/i)
    expect(sent).toHaveLength(0)
  })

  it('leaves the backend seam to the type system', async () => {
    const { backend, sent } = recording()

    // @ts-expect-error the guard belongs on TransportBackend as well
    await backend.send(BOB, privateKeyPackage)

    // A backend reached directly is past the chokepoint: the compile-time guard
    // is all there is, which is why nothing in the library calls one that way.
    expect(sent).toHaveLength(1)
  })
})
