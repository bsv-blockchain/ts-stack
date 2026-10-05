import { Chain } from '../../../../../sdk/types'
import { asArray } from '../../../../../utility/utilityHelpers.noBuffer'
import {
  blockHash,
  convertBitsToWork,
  deserializeBaseBlockHeaders,
  genesisHeader,
  proofOfWorkLimitBits,
  serializeBaseBlockHeader,
  validateBufferOfHeaders,
  validateGenesisHeader,
  validateHeaderDifficulty,
  validateHeaderProofOfWork
} from '../blockHeaderUtilities'

/**
 * The first four headers of a Teranode regtest chain (heights 0 through 3), as
 * its ChainTracks `getHeaders` endpoint serves them. Height 0 is the regtest
 * genesis header; every header carries regtest's 0x207fffff target.
 */
const REGTEST_HEADERS_0_TO_3 =
  '0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4adae5494dffff7f20020000000000002006226e46111a0b59caaf126043eb5bbf28c34f3a5e332a1fc7b2b73cf188910faa9111e7f77fa9f7c006fb1d223717abd7df07f7fa01f3860697afab03ba06284176c36affff7f2000000000000000203b94cdf28e921c770f650bde0c314668a390fb026b4d4212ea4412961a1e58579cfc6ba868ba47ecb733c604e4f1876ad4edabf7ab6fd28d2af28d7c962960694776c36affff7f2001000000000000205b7ebf670fc8dde8a5924cdba996ea0e0883e7f5ac3a569209eb6f75afa3e977c8038fcfa0541538c9fb88e7f005bcffc031f5b4678c18788eeb0a01774654d14776c36affff7f2000000000'

const REGTEST_BITS = 0x207fffff
const ZERO_HASH = '00'.repeat(32)

const regtestBuffer = (): Uint8Array => Uint8Array.from(asArray(REGTEST_HEADERS_0_TO_3, 'hex'))

function regtestHeader(height: number) {
  const base = deserializeBaseBlockHeaders(regtestBuffer())[height]!
  return { ...base, height, hash: blockHash(base) }
}

describe('regtest proof of work', () => {
  test('raises the proof-of-work limit for regtest only', () => {
    expect(proofOfWorkLimitBits('regtest')).toBe(REGTEST_BITS)
    for (const chain of ['main', 'test', 'stn', 'ttn', 'tstn', 'mock', undefined] as Array<Chain | undefined>) {
      expect(proofOfWorkLimitBits(chain)).toBe(0x1d00ffff)
    }
  })

  test('the regtest genesis header is the canonical one and starts the served chain', () => {
    const genesis = genesisHeader('regtest')
    expect(genesis.bits).toBe(REGTEST_BITS)
    expect(serializeBaseBlockHeader(genesis)).toEqual(Array.from(regtestBuffer().slice(0, 80)))
    expect(() => validateGenesisHeader(regtestBuffer(), 'regtest')).not.toThrow()
    expect(() => validateGenesisHeader(regtestBuffer(), 'tstn')).toThrow()
  })

  test('accepts a regtest header only when its chain is named regtest', () => {
    const header = regtestHeader(1)
    expect(header.hash).toBe('57581e1a961244ea12424d6b02fb90a36846310cde0b650f771c928ef2cd943b')
    expect(validateHeaderProofOfWork(header, 'regtest')).toBe(true)
    for (const chain of [undefined, 'main', 'test', 'ttn', 'tstn'] as Array<Chain | undefined>) {
      expect(() => validateHeaderProofOfWork(header, chain)).toThrow('Block target exceeds the proof-of-work limit.')
    }
  })

  test('still rejects a regtest header whose hash misses the regtest target', () => {
    const header = regtestHeader(1)
    // About half of all hashes exceed regtest's target (any whose top bit is set),
    // so a few nonces are enough to find one deterministically.
    let failing: ReturnType<typeof regtestHeader> | undefined
    for (let nonce = 0; nonce < 256 && failing === undefined; nonce++) {
      const candidate = { ...header, nonce }
      const hash = blockHash(candidate)
      if (Number.parseInt(hash.slice(0, 2), 16) >= 0x80) failing = { ...candidate, hash }
    }
    expect(failing).toBeDefined()
    expect(() => validateHeaderProofOfWork(failing!, 'regtest')).toThrow(
      'Block hash is not less than specified target.'
    )
    expect(() => validateHeaderDifficulty(asArray(failing!.hash, 'hex'), REGTEST_BITS, 'regtest')).toThrow(
      'Block hash is not less than specified target.'
    )
  })

  test('still rejects malformed and above-limit targets on regtest', () => {
    const header = regtestHeader(1)
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x20800000 }, 'regtest')).toThrow(
      'Block target encoding is invalid.'
    )
    expect(() => validateHeaderProofOfWork({ ...header, bits: 0x21008000 }, 'regtest')).toThrow(
      'Block target exceeds the proof-of-work limit.'
    )
  })

  test('validates a served regtest header run and its chain work', () => {
    const { lastHeaderHash, lastChainWork } = validateBufferOfHeaders(
      regtestBuffer(),
      ZERO_HASH,
      0,
      -1,
      ZERO_HASH,
      'regtest'
    )
    expect(lastHeaderHash).toBe(regtestHeader(3).hash)
    // Each regtest header adds work 2: (2^256 - 1 - target) / (target + 1) + 1.
    expect(convertBitsToWork(REGTEST_BITS, 'regtest')).toBe('02'.padStart(64, '0'))
    expect(lastChainWork).toBe('08'.padStart(64, '0'))
  })

  test('rejects the same run when the caller does not name regtest', () => {
    for (const chain of [undefined, 'main', 'tstn'] as Array<Chain | undefined>) {
      expect(() => validateBufferOfHeaders(regtestBuffer(), ZERO_HASH, 0, -1, ZERO_HASH, chain)).toThrow(
        'Block target exceeds the proof-of-work limit.'
      )
    }
    expect(() => convertBitsToWork(REGTEST_BITS)).toThrow('Block target exceeds the proof-of-work limit.')
  })
})
