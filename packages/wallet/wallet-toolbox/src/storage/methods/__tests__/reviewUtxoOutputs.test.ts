import { WERR_UTXO_REVIEW_INCONCLUSIVE } from '../../../sdk/WERR_errors'
import { reviewUtxoOutputs, UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS } from '../reviewUtxoOutputs'

function output(outputId: number): any {
  return {
    outputId,
    userId: 7,
    basketId: 1,
    transactionId: outputId,
    txid: outputId.toString(16).padStart(64, '0'),
    vout: 0,
    satoshis: outputId * 10,
    spendable: true,
    lockingScript: [0]
  }
}

function harness(outputs: any[], verdict: (output: any) => any) {
  const current = new Map(outputs.map(candidate => [candidate.outputId, { ...candidate }]))
  const storage = {
    getServices: () => ({
      hashOutputScript: () => 'aa'.repeat(32),
      getUtxoStatus: async (_hash: string, _format: undefined, outpoint: string) => {
        const candidate = outputs.find(output => outpoint.startsWith(output.txid))
        return verdict(candidate)
      }
    }),
    validateOutputScript: jest.fn().mockResolvedValue(undefined),
    findOutputById: jest.fn(async (outputId: number) => current.get(outputId)),
    updateOutput: jest.fn(async (outputId: number, update: any) => {
      Object.assign(current.get(outputId), update)
      return 1
    }),
    insertMonitorEvent: jest.fn().mockResolvedValue(1),
    transaction: jest.fn(async (scope: (trx: object) => Promise<void>) => await scope({ kind: 'trx' }))
  }
  return { storage, current }
}

describe('reviewUtxoOutputs', () => {
  const auth = { userId: 7, identityKey: 'identity-7' }

  test('read-only review reports unknown separately from confirmed spent', async () => {
    const outputs = [output(1), output(2), output(3)]
    const h = harness(outputs, candidate => {
      if (candidate.outputId === 1) return { name: 'mock', status: 'success', details: [], isUtxo: false }
      if (candidate.outputId === 2) return { name: 'mock', status: 'error', details: [] }
      return { name: 'mock', status: 'success', details: [], isUtxo: true }
    })

    const result = await reviewUtxoOutputs(h.storage as any, auth, outputs)

    expect(result.confirmedSpentOutputs).toEqual([outputs[0]])
    expect(result.unknownOutputs).toEqual([outputs[1]])
    expect(result.diagnostics).toMatchObject({
      checked: 3,
      confirmedSpent: 1,
      confirmedUnspent: 1,
      unknown: 1,
      released: 0
    })
    expect(h.storage.updateOutput).not.toHaveBeenCalled()
  })

  test('atomic release throws a machine-readable error and mutates nothing on unknown', async () => {
    const outputs = [output(4), output(5)]
    const h = harness(outputs, candidate =>
      candidate.outputId === 4
        ? { name: 'mock', status: 'success', details: [], isUtxo: false }
        : { name: 'mock', status: 'error', details: [] }
    )

    await expect(reviewUtxoOutputs(h.storage as any, auth, outputs, 'atomic')).rejects.toMatchObject({
      name: 'WERR_UTXO_REVIEW_INCONCLUSIVE',
      checked: 2,
      confirmedSpent: 1,
      unknown: 1
    } satisfies Partial<WERR_UTXO_REVIEW_INCONCLUSIVE>)
    expect(h.storage.transaction).not.toHaveBeenCalled()
    expect(h.storage.updateOutput).not.toHaveBeenCalled()
  })

  test('operator conclusive mode releases the spent subset and quarantines unknowns', async () => {
    const outputs = [output(6), output(7)]
    const h = harness(outputs, candidate =>
      candidate.outputId === 6
        ? { name: 'mock', status: 'success', details: [], isUtxo: false }
        : { name: 'mock', status: 'error', details: [] }
    )

    const result = await reviewUtxoOutputs(h.storage as any, auth, outputs, 'conclusive')

    expect(result.diagnostics).toMatchObject({ confirmedSpent: 1, unknown: 1, released: 1 })
    expect(h.current.get(6).spendable).toBe(false)
    expect(h.current.get(7).spendable).toBe(true)
    expect(h.storage.insertMonitorEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'InvalidChangeConclusiveRelease' }),
      { kind: 'trx' }
    )
  })

  test('bounds a hung provider call and reports timeout as unknown', async () => {
    jest.useFakeTimers()
    try {
      const outputs = [output(8)]
      const h = harness(outputs, () => new Promise(() => {}))
      const pending = reviewUtxoOutputs(h.storage as any, auth, outputs)

      await jest.advanceTimersByTimeAsync(UTXO_REVIEW_PROVIDER_TIMEOUT_MSECS)

      await expect(pending).resolves.toMatchObject({
        diagnostics: { checked: 1, unknown: 1, confirmedSpent: 0 },
        classifications: [{ status: { provider: '<review-timeout>', verdict: 'unknown' } }]
      })
    } finally {
      jest.useRealTimers()
    }
  })
})
