import HD from '../HD'
import Mnemonic from '../Mnemonic'
import ECIES from '../ECIES'
import fromUtxo from '../Utxo'
import { magicHash, sign } from '../BSM'
import PrivateKey from '../../primitives/PrivateKey'
import * as Hash from '../../primitives/Hash'

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('legacy compatibility security boundaries', () => {
  it('rejects ambiguous or excessive HD key material and derivation work', () => {
    const sparseSeed: number[] = []
    sparseSeed.length = 16
    expect(() => HD.fromSeed(sparseSeed)).toThrow('dense byte array')

    const root = HD.fromSeed(Array.from({ length: 16 }, (_, index) => index))
    expect(() => root.deriveChild(Number.NaN)).toThrow('uint32')
    expect(() => root.deriveChild(1.5)).toThrow('uint32')
    expect(() => root.deriveChild(-1)).toThrow('uint32')
    expect(() => root.derive(`m/${Array.from({ length: 256 }, () => '0').join('/')}`)).toThrow(
      'depth exceeds 255'
    )

    const invalidRoot = root.toBinary()
    invalidRoot[12] = 1
    expect(() => HD.fromBinary(invalidRoot)).toThrow('root metadata')
  })

  it('does not retain mutable HD metadata aliases in a public-only copy', () => {
    const root = HD.fromSeed(Array.from({ length: 16 }, (_, index) => index))
    const publicOnly = root.toPublic()
    const before = publicOnly.toString()

    root.chainCode[0] ^= 1
    root.parentFingerPrint[0] ^= 1

    expect(publicOnly.toString()).toBe(before)
  })

  it('atomically replaces HD state and clears private authority when loading an xpub', () => {
    const instance = HD.fromSeed(Array.from({ length: 16 }, (_, index) => index))
    const beforeFailedLoad = instance.toString()
    const invalidPrivate = instance.toBinary()
    invalidPrivate.fill(0, 46)

    expect(() => instance.fromBinary(invalidPrivate)).toThrow('Invalid key')
    expect(instance.toString()).toBe(beforeFailedLoad)

    const expectedPublic = instance.toPublic()
    instance.fromBinary(expectedPublic.toBinary())

    expect(instance.isPrivate()).toBe(false)
    expect(instance.privKey).toBeUndefined()
    expect(instance.deriveChild(0).toString()).toBe(expectedPublic.deriveChild(0).toString())
  })

  it('bounds canonical mnemonic entropy, phrases, passphrases, and binary framing', () => {
    expect(() => Mnemonic.fromRandom(288)).toThrow('BIP-39 maximum')
    const sparseEntropy: number[] = []
    sparseEntropy.length = 16
    expect(() => Mnemonic.fromEntropy(sparseEntropy)).toThrow('dense byte array')
    expect(() => Mnemonic.fromEntropy(Array.from({ length: 36 }, () => 0))).toThrow(
      'bounded dense byte array'
    )

    const mnemonic = Mnemonic.fromString(VALID_MNEMONIC)
    expect(() => mnemonic.toSeed('x'.repeat(1024 * 1024 + 1))).toThrow('bounded string')
    expect(() => new Mnemonic().fromBinary([...mnemonic.toBinary(), 0])).toThrow('trailing bytes')
    const suppliedSeed = [1, 2, 3]
    const constructed = new Mnemonic('', suppliedSeed)
    suppliedSeed[0] = 9
    expect(constructed.seed).toEqual([1, 2, 3])

    mnemonic.toSeed()
    expect(mnemonic.seed).toHaveLength(64)
    mnemonic.fromEntropy(Array.from({ length: 16 }, (_, index) => index + 1))
    expect(mnemonic.seed).toEqual([])
  })

  it('owns and bounds BSM messages and requires an exact output mode', () => {
    const sparseMessage: number[] = []
    sparseMessage.length = 2
    expect(() => magicHash(sparseMessage)).toThrow('dense byte array')
    expect(() => sign([1], new PrivateKey(1), 'unexpected' as unknown as 'raw')).toThrow(
      'raw or base64'
    )
  })

  it('rejects malformed ECIES bytes, framing, expected senders, and tags', () => {
    const sender = new PrivateKey(11)
    const recipient = new PrivateKey(12)
    const other = new PrivateKey(13)
    const envelope = ECIES.electrumEncrypt([1, 2, 3], recipient.toPublicKey(), sender)
    expect(() => ECIES.electrumDecrypt(envelope, recipient, other.toPublicKey())).toThrow(
      'expected sender'
    )
    expect(() => ECIES.electrumDecrypt(envelope.slice(0, -1), recipient)).toThrow()

    const sparsePlaintext: number[] = []
    sparsePlaintext.length = 1
    expect(() => ECIES.bitcoreEncrypt(sparsePlaintext, recipient.toPublicKey())).toThrow(
      'dense byte array'
    )

    for (const tagOffset of [0, 15, 31]) {
      const bitcore = ECIES.bitcoreEncrypt([1, 2, 3], recipient.toPublicKey(), sender)
      bitcore[bitcore.length - 32 + tagOffset] ^= 1
      expect(() => ECIES.bitcoreDecrypt(bitcore, recipient)).toThrow('Invalid checksum')
    }

    const invalidPadding = ECIES.bitcoreEncrypt(
      [1, 2, 3],
      recipient.toPublicKey(),
      sender,
      Array.from({ length: 16 }, () => 0)
    )
    invalidPadding[33 + 15] ^= 13
    const sharedSecret = sender.toPublicKey().mul(recipient).getX().toArray('be', 32)
    const macKey = Hash.sha512(sharedSecret).slice(32, 64)
    const authenticatedCiphertext = invalidPadding.slice(33, -32)
    invalidPadding.splice(-32, 32, ...Hash.sha256hmac(macKey, authenticatedCiphertext))
    expect(() => ECIES.bitcoreDecrypt(invalidPadding, recipient)).toThrow('invalid padding')
  })

  it('validates UTXO data before allocating a compatibility source descriptor', () => {
    const template = {
      sign: jest.fn(),
      estimateLength: jest.fn()
    }
    const getter = jest.fn(() => '0'.repeat(64))
    const accessorUtxo = {
      vout: 0,
      satoshis: 1,
      script: '51'
    } as Record<string, unknown>
    Object.defineProperty(accessorUtxo, 'txid', { enumerable: true, get: getter })
    expect(() => fromUtxo(accessorUtxo as never, template)).toThrow('own data property')
    expect(getter).not.toHaveBeenCalled()

    expect(() =>
      fromUtxo({ txid: '0'.repeat(64), vout: 1_000_001, satoshis: 1, script: '51' }, template)
    ).toThrow('allocation limit')
    expect(() =>
      fromUtxo({ txid: '0'.repeat(64), vout: 0, satoshis: Number.NaN, script: '51' }, template)
    ).toThrow('monetary amount')
  })
})
