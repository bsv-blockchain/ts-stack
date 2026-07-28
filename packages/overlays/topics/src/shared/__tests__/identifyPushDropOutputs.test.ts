/**
 * Focused unit tests for the shared admit/reject loop used by the BasketMap,
 * CertMap, ProtoMap and WalletConfig topic managers.
 */

import { jest } from '@jest/globals'
import { LockingScript, Transaction } from '@bsv/sdk'
import { identifyPushDropOutputs } from '../identifyPushDropOutputs.js'
import { assertTransactionInputsAndOutputs } from '../assertTransactionShape.js'

function buildTx(outputCount: number, withInput = true): Transaction {
  const tx = new Transaction()
  if (withInput) {
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: new LockingScript([]), satoshis: 10000 })
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: 0,
      unlockingScript: new LockingScript([])
    })
  }
  for (let i = 0; i < outputCount; i++) {
    tx.addOutput({ lockingScript: new LockingScript([{ op: i + 1 }]), satoshis: 1000 })
  }
  return tx
}

describe('assertTransactionInputsAndOutputs', () => {
  it('accepts a transaction with at least one input and output', () => {
    expect(() => assertTransactionInputsAndOutputs(buildTx(1))).not.toThrow()
  })

  it('rejects a transaction without inputs', () => {
    expect(() => assertTransactionInputsAndOutputs(buildTx(1, false))).toThrow(
      'Transaction inputs must be valid'
    )
  })

  it('rejects a transaction without outputs', () => {
    expect(() => assertTransactionInputsAndOutputs(buildTx(0))).toThrow(
      'Transaction outputs must be valid'
    )
  })
})

describe('identifyPushDropOutputs', () => {
  let errorSpy: jest.SpiedFunction<Console['error']>

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('admits every output the validator accepts', async () => {
    const onRejectedOutput = jest.fn()
    const result = await identifyPushDropOutputs({
      beef: buildTx(2).toBEEF(),
      previousCoins: [],
      validateOutput: async () => {},
      onRejectedOutput
    })

    expect(result).toEqual({ outputsToAdmit: [0, 1], coinsToRetain: [] })
    expect(onRejectedOutput).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('reports rejected outputs while still admitting the valid ones', async () => {
    const onRejectedOutput = jest.fn()
    const result = await identifyPushDropOutputs({
      beef: buildTx(2).toBEEF(),
      previousCoins: [],
      validateOutput: async lockingScript => {
        if (lockingScript.chunks[0].op === 1) throw new Error('bad output')
      },
      onRejectedOutput
    })

    expect(result).toEqual({ outputsToAdmit: [1], coinsToRetain: [] })
    expect(onRejectedOutput).toHaveBeenCalledTimes(1)
    expect(onRejectedOutput).toHaveBeenCalledWith(0, expect.any(Error))
    // Admitting at least one output must not trigger the identification error log.
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs when nothing is admitted and no previous coins were consumed', async () => {
    const result = await identifyPushDropOutputs({
      beef: buildTx(1).toBEEF(),
      previousCoins: [],
      validateOutput: async () => {
        throw new Error('bad output')
      },
      onRejectedOutput: () => {}
    })

    expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBe('Error identifying admissible outputs:')
  })

  it('stays quiet when nothing is admitted but previous coins were consumed', async () => {
    const result = await identifyPushDropOutputs({
      beef: buildTx(1).toBEEF(),
      previousCoins: [0],
      validateOutput: async () => {
        throw new Error('bad output')
      },
      onRejectedOutput: () => {}
    })

    expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('treats an undefined previousCoins list as no previous coins', async () => {
    await identifyPushDropOutputs({
      beef: buildTx(1).toBEEF(),
      previousCoins: undefined,
      validateOutput: async () => {
        throw new Error('bad output')
      },
      onRejectedOutput: () => {}
    })

    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('returns an empty result for an unparseable BEEF', async () => {
    const onRejectedOutput = jest.fn()
    const result = await identifyPushDropOutputs({
      beef: [0, 1, 2, 3],
      previousCoins: [],
      validateOutput: async () => {},
      onRejectedOutput
    })

    expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
    expect(onRejectedOutput).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a transaction whose shape assertion fails', async () => {
    const result = await identifyPushDropOutputs({
      beef: buildTx(1, false).toBEEF(),
      previousCoins: [],
      validateOutput: async () => {},
      onRejectedOutput: () => {}
    })

    expect(result).toEqual({ outputsToAdmit: [], coinsToRetain: [] })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][1])).toContain('Transaction inputs must be valid')
  })
})
