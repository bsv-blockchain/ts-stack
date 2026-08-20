import ProtoWallet from '../../wallet/ProtoWallet'
import { PrivateKey, Curve, BigNumber } from '../../primitives/index'

/**
 * BRC-229: wallet-native elliptic curve point multiplication.
 *
 * These tests assert the properties a commutative-masking protocol actually depends on,
 * rather than that the method returns some string. If any of them fail, mental poker built
 * on this primitive is broken.
 */

const PROTOCOL: [0 | 1 | 2, string] = [2, 'mental poker deal']
const OTHER_PROTOCOL: [0 | 1 | 2, string] = [2, 'a different scheme']

/** Card i is encoded as (i+1)*G, the standard Barnett-Smart card encoding. */
const card = (i: number): string => {
  const curve = new Curve()
  return curve.g.mul(new BigNumber(i + 1)).encode(true, 'hex') as string
}

let alice: ProtoWallet
let bob: ProtoWallet
let carol: ProtoWallet

beforeEach(() => {
  alice = new ProtoWallet(PrivateKey.fromRandom())
  bob = new ProtoWallet(PrivateKey.fromRandom())
  carol = new ProtoWallet(PrivateKey.fromRandom())
})

describe('ProtoWallet.multiplyPoint (BRC-229)', () => {
  it('masks commute across independent wallets', async () => {
    // The property the whole construction rests on: a*(b*P) == b*(a*P), so players may
    // apply their masks in any order and still agree on the deck.
    const P = card(0)

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

  it('invert recovers the original point', async () => {
    const P = card(7)
    const masked = await alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    expect(masked.point).not.toEqual(P)

    const unmasked = await alice.multiplyPoint({
      point: masked.point,
      protocolID: PROTOCOL,
      keyID: '1',
      invert: true
    })
    expect(unmasked.point).toEqual(P)
  })

  it('a three-way mask strips in any order', async () => {
    // No dealer exists, so unmasking order is whatever the table happens to do.
    const P = card(12)
    let deck = P
    for (const w of [alice, bob, carol]) {
      deck = (await w.multiplyPoint({ point: deck, protocolID: PROTOCOL, keyID: 'k' })).point
    }
    expect(deck).not.toEqual(P)

    // Strip in a deliberately different order from the one used to apply.
    for (const w of [bob, carol, alice]) {
      deck = (
        await w.multiplyPoint({ point: deck, protocolID: PROTOCOL, keyID: 'k', invert: true })
      ).point
    }
    expect(deck).toEqual(P)
  })

  it('separates keys by protocol, key ID and counterparty', async () => {
    const P = card(3)
    const base = await alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    const otherProto = await alice.multiplyPoint({
      point: P,
      protocolID: OTHER_PROTOCOL,
      keyID: '1'
    })
    const otherKey = await alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '2' })
    const otherParty = await alice.multiplyPoint({
      point: P,
      protocolID: PROTOCOL,
      keyID: '1',
      counterparty: (await bob.getPublicKey({ identityKey: true })).publicKey
    })

    const all = [base.point, otherProto.point, otherKey.point, otherParty.point]
    expect(new Set(all).size).toEqual(all.length)
  })

  it('two wallets never derive the same protocol key', async () => {
    const P = card(5)
    const a = await alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    const b = await bob.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '1' })
    expect(a.point).not.toEqual(b.point)
  })

  it('masks a whole deck and reveals one position without leaking the others', async () => {
    const deck = Array.from({ length: 52 }, (_, i) => card(i))
    const masked = await Promise.all(
      deck.map(
        async (p, i) =>
          (await alice.multiplyPoint({ point: p, protocolID: PROTOCOL, keyID: String(i) })).point
      )
    )

    // Every masked position differs from its plaintext and from every other position.
    expect(new Set(masked).size).toEqual(52)
    masked.forEach((m, i) => expect(m).not.toEqual(deck[i]))

    // Revealing position 17 discloses that card and nothing else.
    const revealed = await alice.multiplyPoint({
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

  it('rejects a non-canonical x-coordinate that on-curve checks alone accept', async () => {
    // The regression that motivates the spec's canonical-encoding rule. This x is greater
    // than the field prime; PublicKey.fromString reduces it silently and validate() then
    // returns true, so an implementation checking only the curve equation accepts a point
    // that was never validly encoded.
    const nonCanonical = '02' + 'ff'.repeat(32)
    const curve = new Curve()
    expect(new BigNumber('ff'.repeat(32), 16).cmp(curve.p)).toBeGreaterThanOrEqual(0)

    await expect(
      alice.multiplyPoint({ point: nonCanonical, protocolID: PROTOCOL, keyID: '1' })
    ).rejects.toThrow(/canonical field element/)
  })

  it('rejects malformed, off-curve and identity points', async () => {
    const bad: Record<string, string> = {
      empty: '',
      'not hex': '02' + 'zz'.repeat(32),
      'too short': '02ab',
      'bad prefix': '04' + 'ab'.repeat(32),
      'all zeros': '02' + '00'.repeat(32)
    }
    for (const [name, point] of Object.entries(bad)) {
      await expect(
        alice.multiplyPoint({ point, protocolID: PROTOCOL, keyID: '1' })
      ).rejects.toThrow()
      expect(name).toBeTruthy()
    }
  })

  it('stays structurally optional so existing implementors still satisfy ProtoWallet', () => {
    // Regression guard. Declaring multiplyPoint as a required member -- method or property --
    // narrows what structurally satisfies ProtoWallet, and every implementor that does not
    // extend the class stops type-checking. That broke Wallet, PrivilegedKeyManager and the
    // wallet managers in @bsv/wallet-toolbox with 6 compile errors. This asserts the shape a
    // structural implementor needs: no multiplyPoint, and it still assigns.
    const withoutMultiplyPoint: Pick<ProtoWallet, 'multiplyPoint'> = {}
    expect(withoutMultiplyPoint.multiplyPoint).toBeUndefined()

    // And the real wallet does provide it.
    expect(typeof alice.multiplyPoint).toEqual('function')
  })

  it('requires protocolID and keyID', async () => {
    const P = card(0)
    await expect(
      alice.multiplyPoint({ point: P, protocolID: PROTOCOL, keyID: '' })
    ).rejects.toThrow(/required/)
  })
})
