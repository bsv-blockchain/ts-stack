import { sdk } from '../../../src'
import { WERR_REVIEW_ACTIONS } from '../../../src/sdk'
import {
  burnOneSatTestOutput,
  createOneSatTestOutput,
  createSetup,
  doubleSpendOldChange,
  LocalWalletTestOptions,
  recoverOneSatTestOutputs
} from '../../utils/localWalletMethods'

import * as dotenv from 'dotenv'
dotenv.config()

const chain: sdk.Chain = 'main'

const options: LocalWalletTestOptions = {
  setActiveClient: true,
  useMySQLConnectionForClient: true,
  useTestIdentityKey: false,
  useIdentityKey2: false
}

describe('localWallet2 tests', () => {
  jest.setTimeout(99999999)

  test('1 recover 1 sat outputs', async () => {
    const setup = await createSetup(chain, options)
    try {
      const evidence = await recoverOneSatTestOutputs(setup, 1)
      expect(evidence.recovered).toBe(evidence.available)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2 create 1 sat delayed', async () => {
    const setup = await createSetup(chain, options)
    try {
      const car = await createOneSatTestOutput(setup, {}, 1)
      expect(car.txid).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2a create 1 sat immediate', async () => {
    const setup = await createSetup(chain, options)
    try {
      const car = await createOneSatTestOutput(setup, { acceptDelayedBroadcast: false }, 1)
      expect(car.txid).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2c burn 1 sat output', async () => {
    const setup = await createSetup(chain, options)
    try {
      const evidence = await burnOneSatTestOutput(setup, {}, 1)
      expect(evidence.burned).toBe(Math.min(1, evidence.available))
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2d doubleSpend old change', async () => {
    const setup = await createSetup(chain, options)
    let reviewError: WERR_REVIEW_ACTIONS | undefined
    try {
      await doubleSpendOldChange(setup, {
        acceptDelayedBroadcast: false
      })
    } catch (eu: unknown) {
      reviewError = sdk.WalletError.fromUnknown(eu) as WERR_REVIEW_ACTIONS
    } finally {
      await setup.wallet.destroy()
    }
    expect(reviewError?.code).toBe('WERR_REVIEW_ACTIONS')
    expect(reviewError?.reviewActionResults).toHaveLength(1)
    expect(reviewError?.reviewActionResults?.[0]).toMatchObject({
      status: 'doubleSpend'
    })
    expect(reviewError?.reviewActionResults?.[0]?.competingTxs).toHaveLength(1)
  })
})
