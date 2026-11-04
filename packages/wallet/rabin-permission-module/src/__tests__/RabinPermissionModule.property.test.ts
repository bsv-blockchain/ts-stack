import fc from 'fast-check'
import { CachedKeyDeriver, PrivateKey } from '@bsv/sdk'
import { decodeKeyResult, decodeSignResult, scriptNum, scriptNumToBigInt } from '../encoding.js'
import { RabinPermissionModule } from '../RabinPermissionModule.js'
import { digestValue, generateKey, modPow, verify } from '../rabin.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const deriver = new CachedKeyDeriver(new PrivateKey(0x5eed))
const seed = deriver
  .derivePrivateKey([0, 'p rabin property oracle'], 'property key', 'self')
  .toArray('be', 32)
const seedHex = Buffer.from(seed).toString('hex')
const reference = generateKey(seed, 2048)
const isResidue = (t: bigint, prime: bigint) =>
  t % prime === 0n || modPow(t, (prime - 1n) / 2n, prime) === 1n
const rabin = new RabinPermissionModule({ keyDeriver: deriver })
const call = async (operation: 'key' | 'sign', plaintext: number[]) =>
  await rabin.handleRequest(
    {
      method: 'encrypt',
      originator: 'property.example',
      args: {
        protocolID: [0, `p rabin ${operation} 2048 property oracle`],
        keyID: 'property key',
        counterparty: 'self',
        plaintext
      }
    },
    async () => {
      throw new Error('unexpected underlying call')
    }
  )

describe('RabinPermissionModule properties', () => {
  it('signs every generated message canonically and verifiably under the returned key', async () => {
    const n = decodeKeyResult((await call('key', [])).ciphertext)
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async bytes => {
        const message = Array.from(bytes)
        const first = await call('sign', message)
        const second = await call('sign', message)
        expect(second.ciphertext).toEqual(first.ciphertext)
        const { sig, padding } = decodeSignResult(first.ciphertext)
        expect(verify(message, sig, padding, n)).toBe(true)
        expect(verify(message, sig, padding + 1n, n)).toBe(false)

        // Canonical choice: the smallest residue padding and the CRT of the principal roots.
        const { p, q } = reference
        const h = digestValue(message)
        for (let u = 0n; u < padding; u++) {
          expect(isResidue(h - u, p) && isResidue(h - u, q)).toBe(false)
        }
        const t = h - padding
        expect(sig % p).toBe(modPow(t % p, (p + 1n) / 4n, p))
        expect(sig % q).toBe(modPow(t % q, (q + 1n) / 4n, q))

        // The result carries only public values: never the seed, p or q.
        const hex = Buffer.from(first.ciphertext).toString('hex')
        expect(hex.includes(seedHex)).toBe(false)
        expect(sig === p || sig === q || n !== p * q).toBe(false)
      })
    )
  }, 60_000)

  it('round-trips every non-negative Script number minimally', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 4200n) - 1n }), value => {
        const encoded = scriptNum(value)
        expect(scriptNumToBigInt(encoded)).toBe(value)
        if (encoded.length > 0) {
          expect(encoded[encoded.length - 1] & 0x80).toBe(0)
          if (encoded[encoded.length - 1] === 0) {
            expect(encoded[encoded.length - 2] & 0x80).toBe(0x80)
          }
        }
      })
    )
  })
})
