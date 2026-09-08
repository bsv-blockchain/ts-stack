import fc from 'fast-check'
import { BigNumber, CachedKeyDeriver, Curve, PrivateKey, type PubKeyHex } from '@bsv/sdk'
import { EcpmPermissionModule } from '../EcpmPermissionModule.js'

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

describe('EcpmPermissionModule properties', () => {
  it('round-trips every generated non-zero root and point scalar', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        async (rootScalar, pointScalar) => {
          const module = new EcpmPermissionModule({
            keyDeriver: new CachedKeyDeriver(new PrivateKey(rootScalar))
          })
          const original = curve.g.mul(new BigNumber(pointScalar)).encode(true, 'hex') as PubKeyHex
          const call = async (operation: 'apply' | 'remove', point: PubKeyHex) =>
            await module.handleRequest!(
              {
                method: 'getPublicKey',
                originator: 'property.example',
                args: {
                  protocolID: [0, `p ecpm ${operation} ${point} property poker game`],
                  keyID: 'property key',
                  counterparty: 'self'
                }
              },
              async () => {
                throw new Error('unexpected underlying call')
              }
            )

          const applied = await call('apply', original)
          const removed = await call('remove', applied.publicKey)
          expect(removed.publicKey).toBe(original)
        }
      )
    )
  })
})
