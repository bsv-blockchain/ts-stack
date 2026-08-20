import ProtoWallet from '../../wallet/ProtoWallet'
import { PrivateKey, PublicKey, Curve, BigNumber } from '../../primitives/index'

/**
 * Wallet-side point multiplication.
 *
 * The first test is the specification: it asserts the method agrees exactly with the
 * composition of existing SDK primitives. Everything after that covers the properties a
 * commutative-masking protocol depends on, and the validation that keeps an invalid point out.
 */

const PROTOCOL: [0 | 1 | 2, string] = [2, 'mental poker deal']
const OTHER_PROTOCOL: [0 | 1 | 2, string] = [2, 'a different scheme']

/** Card i is (i+1)*G, the standard Barnett-Smart card encoding. */
const card = (i: number): string =>
  new Curve().g.mul(new BigNumber(i + 1)).encode(true, 'hex') as string

let alice: ProtoWallet
let bob: ProtoWallet
let carol: ProtoWallet

beforeEach(() => {
  alice = new ProtoWallet(PrivateKey.fromRandom())
  bob = new ProtoWallet(PrivateKey.fromRandom())
  carol = new ProtoWallet(PrivateKey.fromRandom())
})

describe('ProtoWallet.multiplyPoint', () => {
  it('agrees with composing deriveSharedSecret and invm over a raw key', async () => {
    // This is the reference behaviour. Given the key, these primitives already do the job:
    //
    //   const masked   = new PublicKey(key.deriveSharedSecret(point))
    //   const inverse  = new PrivateKey(key.invm(new Curve().n))
    //   const unmasked = inverse.deriveSharedSecret(masked)
    //
    // multiplyPoint must produce identical output while keeping the key in the wallet.
    const curve = new Curve()
    const rootKey = PrivateKey.fromRandom()
    const wallet = new ProtoWallet(rootKey)
    const P = PublicKey.fromString(card(0))

    // The wallet derives per BRC-43, so compare against the same derived key.
    const derived = wallet.keyDeriver!.derivePrivateKey(PROTOCOL, '1', 'self')

    const expectedMask = new PublicKey(derived.deriveSharedSecret(P)).toString()
    const actualMask = await wallet.multiplyPoint!({
      point: P.toString(),
      protocolID: PROTOCOL,
      keyID: '1'
    })
    expect(actualMask.point).toEqual(expectedMask)

    const inverseKey = new PrivateKey(derived.invm(curve.n))
    const expectedUnmask = new PublicKey(
      inverseKey.deriveSharedSecret(PublicKey.fromString(actualMask.point))
    ).toString()
    const actualUnmask = await wallet.multiplyPoint!({
      point: actualMask.point,
      protocolID: PROTOCOL,
      keyID: '1',
      invert: true
    })
    expect(actualUnmask.point).toEqual(expectedUnmask)

    // And the round trip returns the original point.
    expect(actualUnmask.point).toEqual(P.toString())
  })

  it('masks commute across independent wallets', async () => {
    // a*(b*P) == b*(a*P): players may apply masks in any order and still agree on the deck.
    const P = card(0)
    const ab = await bob.multiplyPoint!({
      point: (await alice.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '1' })).point,
      protocolID: PROTOCOL,
      keyID: '1'
    })
    const ba = await alice.multiplyPoint!({
      point: (await bob.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '1' })).point,
      protocolID: PROTOCOL,
      keyID: '1'
    })
    expect(ab.point).toEqual(ba.point)
  })

  it('strips a three-way mask in an order different from the one applied', async () => {
    // With no dealer, unmasking order is whatever the table happens to do.
    const P = card(12)
    let deck = P
    for (const w of [alice, bob, carol]) {
      deck = (await w.multiplyPoint!({ point: deck, protocolID: PROTOCOL, keyID: 'k' })).point
    }
    expect(deck).not.toEqual(P)
    for (const w of [bob, carol, alice]) {
      deck = (
        await w.multiplyPoint!({ point: deck, protocolID: PROTOCOL, keyID: 'k', invert: true })
      ).point
    }
    expect(deck).toEqual(P)
  })

  it('separates keys by protocol, key ID and counterparty', async () => {
    const P = card(3)
    const results = await Promise.all([
      alice.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '1' }),
      alice.multiplyPoint!({ point: P, protocolID: OTHER_PROTOCOL, keyID: '1' }),
      alice.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '2' }),
      alice.multiplyPoint!({
        point: P,
        protocolID: PROTOCOL,
        keyID: '1',
        counterparty: (await bob.getPublicKey({ identityKey: true })).publicKey
      })
    ])
    const points = results.map(r => r.point)
    expect(new Set(points).size).toEqual(points.length)
  })

  it('never derives the same protocol key for two wallets', async () => {
    const P = card(5)
    const a = await alice.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '1' })
    const b = await bob.multiplyPoint!({ point: P, protocolID: PROTOCOL, keyID: '1' })
    expect(a.point).not.toEqual(b.point)
  })

  it('masks a whole deck and reveals one position without exposing the others', async () => {
    const deck = Array.from({ length: 52 }, (_, i) => card(i))
    const masked = await Promise.all(
      deck.map(
        async (p, i) =>
          (await alice.multiplyPoint!({ point: p, protocolID: PROTOCOL, keyID: String(i) })).point
      )
    )
    expect(new Set(masked).size).toEqual(52)
    masked.forEach((m, i) => expect(m).not.toEqual(deck[i]))

    const revealed = await alice.multiplyPoint!({
      point: masked[17],
      protocolID: PROTOCOL,
      keyID: '17',
      invert: true
    })
    expect(revealed.point).toEqual(deck[17])
    for (let i = 0; i < 52; i++) {
      if (i !== 17) expect(masked[i]).not.toEqual(deck[i])
    }
  })

  it('rejects a non-canonical x-coordinate that an on-curve check alone accepts', async () => {
    // x greater than the field prime. PublicKey.fromString reduces it silently and validate()
    // then returns true, so the curve equation alone is not sufficient.
    const nonCanonical = '02' + 'ff'.repeat(32)
    expect(new BigNumber('ff'.repeat(32), 16).cmp(new Curve().p)).toBeGreaterThanOrEqual(0)
    expect(PublicKey.fromString(nonCanonical).validate()).toEqual(true)

    await expect(
      alice.multiplyPoint!({ point: nonCanonical, protocolID: PROTOCOL, keyID: '1' })
    ).rejects.toThrow(/canonical field element/)
  })

  it('rejects malformed and identity points', async () => {
    for (const point of [
      '',
      '02' + 'zz'.repeat(32),
      '02ab',
      '04' + 'ab'.repeat(32),
      '02' + '00'.repeat(32)
    ]) {
      await expect(
        alice.multiplyPoint!({ point, protocolID: PROTOCOL, keyID: '1' })
      ).rejects.toThrow()
    }
  })

  it('requires protocolID and keyID', async () => {
    await expect(
      alice.multiplyPoint!({ point: card(0), protocolID: PROTOCOL, keyID: '' })
    ).rejects.toThrow(/required/)
  })

  it('stays structurally optional so existing implementors still satisfy ProtoWallet', () => {
    // A required member -- method or property -- narrows what structurally satisfies
    // ProtoWallet, which breaks implementors that do not extend the class (Wallet,
    // PrivilegedKeyManager and the wallet managers in @bsv/wallet-toolbox).
    const withoutMultiplyPoint: Pick<ProtoWallet, 'multiplyPoint'> = {}
    expect(withoutMultiplyPoint.multiplyPoint).toBeUndefined()
    expect(typeof alice.multiplyPoint).toEqual('function')
  })
})
