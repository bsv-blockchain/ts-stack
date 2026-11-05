import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { signObject } from '../src/index.js'
import { validateLCHOverlayLicense } from '../src/overlayAcquisitionLicense.js'
import { lchOverlaySignatureBudget } from '../src/overlayAcquisitionVerification.js'
import { lchOverlayLicenseFixture } from './overlay-acquisition-license.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED),
  replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

it('rejects signed substituted License commitments before any buyer decryption', async () => {
  const f = await lchOverlayLicenseFixture()
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('assetId', 'offerId', 'requestId'),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      async (field, bytes) => {
        const wrong = bytes.slice()
        wrong[0] = ((f.license.body[field] as Uint8Array)[0] + 1) % 256
        const license = await signObject('license', { ...f.license.body, [field]: wrong }, f.seller)
        let decryptions = 0
        await expect(
          validateLCHOverlayLicense({
            ...f.input,
            verifier: lchOverlaySignatureBudget(() => {}),
            context: { ...f.context, license },
            keyDelivery: {
              recover: () => {
                decryptions++
                throw new Error('Wrong License reached decryption')
              }
            }
          })
        ).rejects.toThrow('License IDs')
        expect(decryptions).toBe(0)
      }
    )
  )
}, 180000)
