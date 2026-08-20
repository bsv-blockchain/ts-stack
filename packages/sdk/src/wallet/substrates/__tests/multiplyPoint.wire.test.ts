import ProtoWallet from '../../../wallet/ProtoWallet'
import WalletWireTransceiver from '../../../wallet/substrates/WalletWireTransceiver'
import WalletWireProcessor from '../../../wallet/substrates/WalletWireProcessor'
import calls from '../../../wallet/substrates/WalletWireCalls'
import { PrivateKey, Curve, BigNumber } from '../../../primitives/index'
import type { WalletInterface } from '../../../wallet/Wallet.interfaces'

/**
 * BRC-229 over the serialized wire substrate.
 *
 * ProtoWallet already has unit coverage for the maths. What these tests establish is that the
 * frame encoding preserves it: a mask applied through the wire must be strippable through the
 * wire, or a wallet reached over a substrate (which is every real wallet, including BSV
 * Desktop) cannot participate in the protocol.
 */

const PROTOCOL: [0 | 1 | 2, string] = [2, 'mental poker deal']

const card = (i: number): string =>
  new Curve().g.mul(new BigNumber(i + 1)).encode(true, 'hex') as string

const wireWallet = (underlying: ProtoWallet): WalletWireTransceiver =>
  new WalletWireTransceiver(new WalletWireProcessor(underlying as unknown as WalletInterface))

describe('multiplyPoint over the wire substrate (BRC-229)', () => {
  it('is assigned call code 29', () => {
    // The BRC-100 call code table ends at 28 (getVersion), so 29 is the next free code.
    expect(calls.multiplyPoint).toEqual(29)
    expect(calls.getVersion).toEqual(28)
  })

  it('round-trips a masked point and strips it again', async () => {
    const wallet = wireWallet(new ProtoWallet(PrivateKey.fromRandom()))
    const P = card(0)

    const masked = await wallet.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    expect(masked.point).not.toEqual(P)
    expect(masked.point).toMatch(/^0[23][0-9a-f]{64}$/)

    const unmasked = await wallet.multiplyPoint({
      point: masked.point,
      protocolID: PROTOCOL,
      keyID: '1',
      invert: true
    })
    expect(unmasked.point).toEqual(P)
  })

  it('agrees with the in-process result, so the encoding loses nothing', async () => {
    const key = PrivateKey.fromRandom()
    const direct = new ProtoWallet(key)
    const overWire = wireWallet(new ProtoWallet(key))
    const P = card(9)

    const a = await direct.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: 'k' })
    const b = await overWire.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: 'k' })
    expect(b.point).toEqual(a.point)
  })

  it('commutes across two wallets reached over the wire', async () => {
    const alice = wireWallet(new ProtoWallet(PrivateKey.fromRandom()))
    const bob = wireWallet(new ProtoWallet(PrivateKey.fromRandom()))
    const P = card(4)

    const ab = await bob.multiplyPoint({
      point: (await alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })).point,
      protocolID: PROTOCOL,
      keyID: '1'
    })
    const ba = await alice.multiplyPoint({
      point: (await bob.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })).point,
      protocolID: PROTOCOL,
      keyID: '1'
    })
    expect(ab.point).toEqual(ba.point)
  })

  it('carries counterparty and invert through the frame independently', async () => {
    const alice = new ProtoWallet(PrivateKey.fromRandom())
    const bob = new ProtoWallet(PrivateKey.fromRandom())
    const wired = wireWallet(alice)
    const bobKey = (await bob.getPublicKey({ identityKey: true })).publicKey
    const P = card(2)

    // A counterparty-scoped mask must differ from a self-scoped one and still invert.
    const selfMask = await wired.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    const partyMask = await wired.multiplyPoint({
      point: P,
      protocolID: PROTOCOL,
      keyID: '1',
      counterparty: bobKey
    })
    expect(partyMask.point).not.toEqual(selfMask.point)

    const back = await wired.multiplyPoint({
      point: partyMask.point,
      protocolID: PROTOCOL,
      keyID: '1',
      counterparty: bobKey,
      invert: true
    })
    expect(back.point).toEqual(P)
  })

  it('propagates a rejected point as a wire error rather than a bad point', async () => {
    const wallet = wireWallet(new ProtoWallet(PrivateKey.fromRandom()))
    // The non-canonical x-coordinate: greater than the field prime, silently reduced by the
    // parser, and reported on-curve. It must not survive the trip.
    await expect(
      wallet.multiplyPoint({ point: '02' + 'ff'.repeat(32), protocolID: PROTOCOL, keyID: '1' })
    ).rejects.toThrow(/canonical field element/)
  })

  it('reports a clear error when the wallet does not implement the method', async () => {
    // multiplyPoint is optional, so a substrate may front a wallet without it. The caller must
    // get a legible error, not a crash on undefined.
    const withoutMethod = { getVersion: async () => ({ version: '1.0.0' }) }
    const wallet = new WalletWireTransceiver(
      new WalletWireProcessor(withoutMethod as unknown as WalletInterface)
    )
    await expect(
      wallet.multiplyPoint({ point: card(0), protocolID: PROTOCOL, keyID: '1' })
    ).rejects.toThrow(/not implemented/)
  })
})
