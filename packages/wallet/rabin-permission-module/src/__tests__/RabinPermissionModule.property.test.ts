import fc from 'fast-check'
import { RabinPermissionModule } from '../RabinPermissionModule.js'
import { isQuadraticResidue, principalCrtRoot, rabinSign, verifyRabinSignature } from '../rabin.js'
import {
  decodePushes,
  decodeScriptNumber,
  encodePush,
  encodeScriptNumber
} from '../scriptNumber.js'
import { mod, modPow } from '../primes.js'
import { leToBigint } from '../bytes.js'
import { sha256 } from '../hkdf.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
const PRIMES = [
  3n,
  7n,
  11n,
  19n,
  23n,
  31n,
  43n,
  47n,
  59n,
  67n,
  71n,
  79n,
  83n,
  103n,
  107n,
  127n,
  131n,
  139n,
  151n,
  163n,
  167n,
  179n,
  191n,
  199n
]

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

describe('Rabin permission module properties', () => {
  it('round-trips every generated script number and push', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 512n) - 1n }), value => {
        const encoded = encodeScriptNumber(value)
        expect(decodeScriptNumber(encoded)).toBe(value)
        const [pushed] = decodePushes(encodePush(encoded))
        expect(pushed).toBeDefined()
        expect(decodeScriptNumber(pushed ?? new Uint8Array())).toBe(value)
      })
    )
  })

  it('emits one canonical signature for every small prime pair and message', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: PRIMES.length - 2 }),
        fc.integer({ min: 1, max: PRIMES.length - 1 }),
        fc.uint8Array({ minLength: 0, maxLength: 48 }),
        async (left, distance, message) => {
          const pIndex = Math.min(left, PRIMES.length - 2)
          const qIndex = Math.min(PRIMES.length - 1, pIndex + distance)
          const p = PRIMES[pIndex] ?? 3n
          const q = PRIMES[qIndex] ?? 7n
          if (p >= q) return
          const signed = await rabinSign(message, p, q)
          const hashMod = mod(leToBigint(await sha256(message)), signed.modulus)
          expect(
            await verifyRabinSignature(message, signed.signature, signed.padding, signed.modulus)
          ).toBe(true)
          for (let smaller = 0n; smaller < signed.padding; smaller++) {
            const target = mod(hashMod - smaller, signed.modulus)
            expect(isQuadraticResidue(target, p) && isQuadraticResidue(target, q)).toBe(false)
          }
          const target = mod(hashMod - signed.padding, signed.modulus)
          expect(
            principalCrtRoot(
              modPow(target, (p + 1n) / 4n, p),
              p,
              modPow(target, (q + 1n) / 4n, q),
              q
            )
          ).toBe(signed.signature)
          expect(
            await verifyRabinSignature(
              message,
              signed.signature,
              signed.padding + 1n,
              signed.modulus
            )
          ).toBe(false)
        }
      )
    )
  })

  it('rejects malformed p rabin envelopes before derivation', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 0, maxLength: 80 }), async protocolName => {
        let derivations = 0
        const module = new RabinPermissionModule({
          keyDeriver: {
            derivePrivateKey: () => {
              derivations++
              throw new Error('derivation must not run')
            }
          }
        })
        const malformed =
          !/^p rabin (key|sign) (2048|3072|4096) [a-z0-9]+(?: [a-z0-9]+)*$/.test(protocolName) ||
          protocolName.endsWith(' protocol') ||
          protocolName.length < 5 ||
          protocolName.length > 400
        if (!malformed) return
        await expect(
          module.handleRequest(
            {
              method: 'encrypt',
              originator: 'app.example',
              args: {
                protocolID: [0, protocolName],
                keyID: 'price',
                plaintext: protocolName.startsWith('p rabin key') ? [] : [1]
              }
            },
            async () => {
              throw new Error('underlying wallet must not be called')
            }
          )
        ).rejects.toThrow('Rabin:')
        expect(derivations).toBe(0)
      })
    )
  })
})
