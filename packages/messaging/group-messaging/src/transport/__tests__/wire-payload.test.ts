import { describe, expect, it } from 'vitest'
import { asKeyPackageBytes, asPrivateKeyPackageBytes } from '../../mls/key-package-codec.js'
import type { IdentityKey, WirePayload } from '../../types.js'
import type { TransportBackend } from '../backend.js'
import { TransportService } from '../transport-service.js'

const BOB = `02${'bb'.repeat(32)}`

/**
 * The type-level half of spec §4.1: a KeyPackage's private half must not be
 * sendable. Each `@ts-expect-error` below fails the build the moment
 * {@link WirePayload} is relaxed back to a bare `Uint8Array`, which is what
 * makes this a compile-fail fixture rather than a comment.
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
  it('accepts plain bytes', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)

    await transport.send(BOB, new Uint8Array([1, 2, 3]))

    expect(sent).toEqual([new Uint8Array([1, 2, 3])])
  })

  it('refuses a private KeyPackage', async () => {
    const { backend, sent } = recording()
    const transport = new TransportService(backend)
    const privateKeyPackage = asPrivateKeyPackageBytes(new Uint8Array([1]))

    // @ts-expect-error a PrivateKeyPackageBytes must never reach the wire
    await transport.send(BOB, privateKeyPackage)

    expect(sent).toHaveLength(1)
  })

  it('refuses a KeyPackage sent bare rather than in an envelope', async () => {
    const { backend } = recording()
    const transport = new TransportService(backend)
    const keyPackage = asKeyPackageBytes(new Uint8Array([1]))

    // @ts-expect-error KeyPackages travel inside a bootstrap envelope
    await transport.send(BOB, keyPackage)
  })

  it('refuses a private KeyPackage on broadcast too', async () => {
    const { backend } = recording()
    const transport = new TransportService(backend)
    const privateKeyPackage = asPrivateKeyPackageBytes(new Uint8Array([1]))

    // @ts-expect-error a PrivateKeyPackageBytes must never reach the wire
    await transport.broadcast('g1', [BOB], privateKeyPackage)
  })

  it('refuses a private KeyPackage at the backend seam', async () => {
    const { backend } = recording()
    const privateKeyPackage = asPrivateKeyPackageBytes(new Uint8Array([1]))

    // @ts-expect-error the guard belongs on TransportBackend as well
    await backend.send(BOB, privateKeyPackage)
  })
})
