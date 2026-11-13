import fc from 'fast-check'
import { BigNumber, CachedKeyDeriver, Curve, PrivateKey } from '@bsv/sdk'
import {
  parsePoint33,
  SigmaPermissionModule,
  verifyDleq,
  verifyOr,
  verifySchnorr
} from '../index.js'
import { call } from './helpers.js'

const curve = new Curve()
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

const root = fc.integer({ min: 1, max: 1_000_000_000 })
const keyID = fc.string({ minLength: 1, maxLength: 40 })
const context = fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 200 })
const otherScalar = fc.integer({ min: 1, max: 1_000_000 })
const base = fc.integer({ min: 2, max: 1_000_000 })

const point33 = (k: number): number[] => curve.g.mul(new BigNumber(k)).encode(true) as number[]
const moduleFor = (rootScalar: number): SigmaPermissionModule =>
  new SigmaPermissionModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(rootScalar)) })
const level0 = (operation: string, id: string): Record<string, unknown> => ({
  protocolID: [0, `p sigma ${operation} property test`],
  keyID: id
})
/** A context that differs from the original in one byte. */
const altered = (ctx: number[]): number[] => [(ctx[0] + 1) % 256, ...ctx.slice(1)]

describe('SigmaPermissionModule properties', () => {
  it('schnorr proofs verify, repeat exactly, and bind the context', async () => {
    await fc.assert(
      fc.asyncProperty(root, keyID, context, async (r, id, ctx) => {
        const m = moduleFor(r)
        const P = parsePoint33((await call(m, 'key', [], level0('key', id))).ciphertext, 'P')
        const first = (await call(m, 'schnorr', ctx, level0('schnorr', id))).ciphertext
        const second = (await call(m, 'schnorr', ctx, level0('schnorr', id))).ciphertext
        expect(second).toEqual(first)
        expect(verifySchnorr(P, ctx, first)).toBe(true)
        expect(verifySchnorr(P, altered(ctx), first)).toBe(false)
      })
    )
  })

  it('dleq proofs verify, repeat exactly, and bind the context', async () => {
    await fc.assert(
      fc.asyncProperty(root, keyID, context, base, async (r, id, ctx, h) => {
        const m = moduleFor(r)
        const H = parsePoint33(point33(h), 'H')
        const P = parsePoint33((await call(m, 'key', [], level0('key', id))).ciphertext, 'P')
        const plaintext = [...point33(h), ...ctx]
        const first = (await call(m, 'dleq', plaintext, level0('dleq', id))).ciphertext
        const second = (await call(m, 'dleq', plaintext, level0('dleq', id))).ciphertext
        expect(second).toEqual(first)
        expect(verifyDleq(P, H, ctx, first)).toBe(true)
        expect(verifyDleq(P, H, altered(ctx), first)).toBe(false)
      })
    )
  })

  it('or proofs verify at every ring position, repeat exactly, and bind the context', async () => {
    await fc.assert(
      fc.asyncProperty(
        root,
        keyID,
        context,
        fc
          .integer({ min: 2, max: 8 })
          .chain(n =>
            fc.tuple(
              fc.constant(n),
              fc.integer({ min: 1, max: n }),
              fc.uniqueArray(otherScalar, { minLength: n - 1, maxLength: n - 1 })
            )
          ),
        async (r, id, ctx, [n, position, scalars]) => {
          const m = moduleFor(r)
          const P = parsePoint33((await call(m, 'key', [], level0('key', id))).ciphertext, 'P')
          const others = scalars.map(k => parsePoint33(point33(k + 1), 'other'))
          // Skip the (astronomically unlikely) clash with the wallet's own point.
          fc.pre(others.every(o => !o.eq(P)))
          const plaintext = [
            n,
            position,
            ...others.flatMap(o => o.encode(true) as number[]),
            ...ctx
          ]
          const first = (await call(m, 'or', plaintext, level0('or', id))).ciphertext
          const second = (await call(m, 'or', plaintext, level0('or', id))).ciphertext
          expect(second).toEqual(first)
          const ring = [...others]
          ring.splice(position - 1, 0, P)
          expect(verifyOr(ring, ctx, first)).toBe(true)
          expect(verifyOr(ring, altered(ctx), first)).toBe(false)
        }
      )
    )
  })
})
