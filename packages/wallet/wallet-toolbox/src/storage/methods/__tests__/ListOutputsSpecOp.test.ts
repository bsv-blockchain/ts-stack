import { specOpInvalidChange, specOpWalletBalance } from '../../../sdk/types'
import { getListOutputsSpecOp } from '../ListOutputsSpecOp'

function makeOutput(outputId: number): any {
  return {
    outputId,
    userId: 7,
    basketId: 1,
    transactionId: outputId,
    txid: outputId.toString(16).padStart(64, '0'),
    vout: 0,
    satoshis: 100 + outputId,
    spendable: true,
    lockingScript: [0]
  }
}

function makeInvalidChangeHarness(getUtxoStatus: (outpoint: string) => Promise<any>, outputs: any[]): any {
  const current = new Map(outputs.map(output => [output.outputId, { ...output }]))
  const getUtxoStatusMock = jest.fn(
    async (_hash: string, _format: undefined, outpoint: string) => await getUtxoStatus(outpoint)
  )
  const updateOutput = jest.fn(async (outputId: number, update: any) => {
    const output = current.get(outputId)
    if (output == null) return 0
    Object.assign(output, update)
    return 1
  })
  const insertMonitorEvent = jest.fn().mockResolvedValue(1)
  const transaction = jest.fn(async (scope: (trx: object) => Promise<any>) => await scope({ kind: 'trx' }))
  return {
    storage: {
      getServices: () => ({
        hashOutputScript: () => 'aa'.repeat(32),
        getUtxoStatus: getUtxoStatusMock
      }),
      validateOutputScript: jest.fn().mockResolvedValue(undefined),
      findOutputById: jest.fn(async (outputId: number) => current.get(outputId)),
      updateOutput,
      insertMonitorEvent,
      transaction
    },
    current,
    getUtxoStatusMock,
    updateOutput,
    insertMonitorEvent,
    transaction
  }
}

async function filterInvalidChange(storage: any, outputs: any[], tags: string[]): Promise<any[]> {
  const operation = getListOutputsSpecOp(specOpInvalidChange, tags).specOp
  return await operation!.filterOutputs!(storage, { userId: 7, identityKey: 'identity-7' }, {} as any, tags, outputs)
}

describe('getListOutputsSpecOp', () => {
  it('returns the ordinary operation when no basket or intercepted tag is present', () => {
    expect(getListOutputsSpecOp('', [])).toEqual({
      specOp: undefined,
      basket: '',
      tags: []
    })
    expect(getListOutputsSpecOp('application', ['ordinary'])).toEqual({
      specOp: undefined,
      basket: 'application',
      tags: ['ordinary']
    })
  })

  it('resolves a basket operation and normalizes missing tags', () => {
    const result = getListOutputsSpecOp(specOpWalletBalance, undefined as never)

    expect(result.specOp?.name).toBe('totalOutputsIsWalletBalance')
    expect(result.basket).toBe('default')
    expect(result.tags).toEqual([])
  })

  it('resolves the wallet-balance tag for the default basket', () => {
    const result = getListOutputsSpecOp('default', ['ordinary', specOpWalletBalance, 'remaining'])

    expect(result.specOp).toMatchObject({
      name: 'totalOutputsIsWalletBalance',
      managedChangeOnly: true
    })
    expect(result.basket).toBe('default')
    expect(result.tags).toEqual(['ordinary', 'remaining'])
  })

  it('preserves application-basket balance-tag behavior', () => {
    const result = getListOutputsSpecOp('application', [specOpWalletBalance])

    expect(result.specOp).toMatchObject({
      name: 'totalOutputsIsWalletBalance'
    })
    expect(result.specOp?.managedChangeOnly).toBeUndefined()
    expect(result.basket).toBe('application')
    expect(result.tags).toEqual([])
  })

  it('handles a missing tag collection without changing an unknown basket', () => {
    expect(getListOutputsSpecOp('application', undefined as never)).toEqual({
      specOp: undefined,
      basket: 'application',
      tags: undefined
    })
  })

  it('returns only outputs conclusively confirmed spent during a read-only scan', async () => {
    const outputs = [makeOutput(1), makeOutput(2)]
    const harness = makeInvalidChangeHarness(
      async outpoint => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: outpoint.startsWith(outputs[1].txid)
      }),
      outputs
    )

    const result = await filterInvalidChange(harness.storage, outputs, [])

    expect(result).toEqual([outputs[0]])
    expect(harness.transaction).not.toHaveBeenCalled()
    expect(harness.updateOutput).not.toHaveBeenCalled()
    expect(harness.insertMonitorEvent).not.toHaveBeenCalled()
  })

  it('atomically releases only confirmed-spent outputs and records bounded audit evidence', async () => {
    const outputs = [makeOutput(3), makeOutput(4)]
    const harness = makeInvalidChangeHarness(
      async outpoint => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: outpoint.startsWith(outputs[1].txid)
      }),
      outputs
    )

    const result = await filterInvalidChange(harness.storage, outputs, ['release'])

    expect(result).toEqual([outputs[0]])
    expect(outputs[0].spendable).toBe(false)
    expect(outputs[1].spendable).toBe(true)
    expect(harness.transaction).toHaveBeenCalledTimes(1)
    expect(harness.updateOutput).toHaveBeenCalledWith(3, { spendable: false }, { kind: 'trx' })
    expect(harness.insertMonitorEvent).toHaveBeenCalledTimes(1)
    const event = harness.insertMonitorEvent.mock.calls[0][0]
    expect(event.event).toBe('InvalidChangeRelease')
    expect(JSON.parse(event.details)).toEqual({
      operation: 'specOpInvalidChange',
      reason: 'provider-confirmed-spent',
      releaseMode: 'atomic',
      userId: 7,
      checked: 2,
      confirmedUnspent: 1,
      confirmedSpent: 1,
      unknown: 0,
      confirmedSpentSatoshis: outputs[0].satoshis,
      released: 1,
      releasedSatoshis: outputs[0].satoshis,
      providers: ['mock'],
      providerCount: 1,
      providersTruncated: false
    })
  })

  it.each([
    ['provider error result', async () => ({ name: 'mock', status: 'error', details: [] })],
    ['missing boolean verdict', async () => ({ name: 'mock', status: 'success', details: [] })],
    [
      'provider throw',
      async () => {
        throw new Error('429')
      }
    ]
  ])('blocks the entire release on %s', async (_name, getUtxoStatus) => {
    const outputs = [makeOutput(5), makeOutput(6)]
    const harness = makeInvalidChangeHarness(async outpoint => {
      if (outpoint.startsWith(outputs[0].txid)) {
        return { name: 'mock', status: 'success', details: [], isUtxo: false }
      }
      return await getUtxoStatus()
    }, outputs)

    await expect(filterInvalidChange(harness.storage, outputs, ['release'])).rejects.toThrow(
      '1 of 2 candidates; no outputs were changed'
    )

    expect(harness.transaction).not.toHaveBeenCalled()
    expect(harness.updateOutput).not.toHaveBeenCalled()
    expect(outputs.every(output => output.spendable)).toBe(true)
    expect(harness.insertMonitorEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'InvalidChangeReleaseBlocked' })
    )
    expect(JSON.parse(harness.insertMonitorEvent.mock.calls[0][0].details)).toMatchObject({
      reason: 'inconclusive-provider-result',
      released: 0,
      unknown: 1
    })
  })

  it('bounds provider names and provider count in release audit evidence', async () => {
    const outputs = Array.from({ length: 10 }, (_, index) => makeOutput(100 + index))
    const harness = makeInvalidChangeHarness(async outpoint => {
      const output = outputs.find(candidate => outpoint.startsWith(candidate.txid))!
      return {
        name: `${output.outputId}-${'provider-name'.repeat(20)}`,
        status: 'success',
        details: [],
        isUtxo: true
      }
    }, outputs)

    await filterInvalidChange(harness.storage, outputs, ['release'])

    const details = JSON.parse(harness.insertMonitorEvent.mock.calls[0][0].details)
    expect(details.providerCount).toBe(10)
    expect(details.providersTruncated).toBe(true)
    expect(details.providers).toHaveLength(8)
    expect(details.providers.every((provider: string) => provider.length <= 128)).toBe(true)
  })

  it('returns the conclusive read-only picture without treating unknown as spent', async () => {
    const outputs = [makeOutput(60)]
    const harness = makeInvalidChangeHarness(
      async () => ({ name: '<noservices>', status: 'error', details: [] }),
      outputs
    )

    await expect(filterInvalidChange(harness.storage, outputs, [])).resolves.toEqual([])
    expect(harness.transaction).not.toHaveBeenCalled()
    expect(harness.updateOutput).not.toHaveBeenCalled()
    expect(harness.insertMonitorEvent).not.toHaveBeenCalled()
  })

  it('treats locking-script restoration failure as unknown and performs no release', async () => {
    const outputs = [makeOutput(7)]
    const harness = makeInvalidChangeHarness(
      async () => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: false
      }),
      outputs
    )
    harness.storage.validateOutputScript.mockRejectedValue(new Error('raw transaction unavailable'))

    await expect(filterInvalidChange(harness.storage, outputs, ['release'])).rejects.toThrow(
      '1 of 1 candidates; no outputs were changed'
    )
    expect(harness.updateOutput).not.toHaveBeenCalled()
  })

  it('keeps a 640-output review within the provider-safe concurrency bound', async () => {
    const outputs = Array.from({ length: 640 }, (_, index) => makeOutput(10_000 + index))
    let active = 0
    let maximumActive = 0
    const harness = makeInvalidChangeHarness(async () => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return { name: 'mock', status: 'success', details: [], isUtxo: true }
    }, outputs)

    await expect(filterInvalidChange(harness.storage, outputs, [])).resolves.toEqual([])
    expect(maximumActive).toBeLessThanOrEqual(4)
    expect(harness.getUtxoStatusMock).toHaveBeenCalledTimes(640)
  })

  it('does not expose partially released state when an atomic write fails', async () => {
    const outputs = [makeOutput(8), makeOutput(9)]
    const harness = makeInvalidChangeHarness(
      async () => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: false
      }),
      outputs
    )
    harness.storage.updateOutput = jest.fn().mockResolvedValueOnce(1).mockRejectedValueOnce(new Error('write failed'))

    await expect(filterInvalidChange(harness.storage, outputs, ['release'])).rejects.toThrow('write failed')
    expect(outputs.every(output => output.spendable)).toBe(true)
    expect(harness.insertMonitorEvent).not.toHaveBeenCalled()
  })

  it('aborts atomically when ownership or allocation state changes during release', async () => {
    const outputs = [makeOutput(10), makeOutput(11)]
    const harness = makeInvalidChangeHarness(
      async () => ({
        name: 'mock',
        status: 'success',
        details: [],
        isUtxo: false
      }),
      outputs
    )
    harness.current.get(10).spentBy = 123

    await expect(filterInvalidChange(harness.storage, outputs, ['release'])).rejects.toThrow(
      'changed state during UTXO review; no outputs were changed'
    )
    expect(harness.updateOutput).not.toHaveBeenCalled()
    expect(harness.insertMonitorEvent).not.toHaveBeenCalled()
  })
})
