import { Beef } from '@bsv/sdk'
import { shareReqsWithWorld } from '../../src/storage/methods/processAction'
import { TableProvenTxReq } from '../../src/storage/schema/tables/TableProvenTxReq'

function makeReadyReq (): TableProvenTxReq {
  const now = new Date()
  return {
    created_at: now,
    updated_at: now,
    provenTxReqId: 11,
    txid: 'a'.repeat(64),
    status: 'unsent',
    attempts: 0,
    notified: false,
    history: '{}',
    notify: JSON.stringify({ transactionIds: [22] }),
    rawTx: [1, 2, 3],
    inputBEEF: [4, 5, 6]
  }
}

function makeStorageFake () {
  return {
    transaction: jest.fn(async (callback: (trx?: unknown) => Promise<unknown>) => await callback(undefined)),
    updateProvenTxReq: jest.fn(async () => 1),
    updateTransaction: jest.fn(async () => 1),
    getServices: jest.fn(() => ({
      getChainTracker: jest.fn(async () => ({}))
    })),
    attemptToPostReqsToNetwork: jest.fn(async (reqs: TableProvenTxReq[]) => ({
      details: reqs.map(req => ({ txid: req.txid, status: 'success' as const }))
    }))
  }
}

describe('processAction shareReqsWithWorld', () => {
  test('delayed sends do not build aggregate BEEF before scheduling', async () => {
    const req = makeReadyReq()
    const storage = {
      ...makeStorageFake(),
      findProvenTxs: jest.fn(async () => []),
      findProvenTxReqs: jest.fn(async () => [req]),
      getReqsAndBeefToShareWithWorld: jest.fn(async () => {
        throw new Error('delayed BEEF should be rebuilt later')
      })
    }

    const result = await shareReqsWithWorld(storage as any, 1, [req.txid], true)

    expect(storage.getReqsAndBeefToShareWithWorld).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith([req.provenTxReqId], expect.objectContaining({ status: 'unsent' }), undefined)
    expect(storage.updateTransaction).toHaveBeenCalledWith([22], { status: 'sending' }, undefined)
    expect(result.swr).toEqual([{ txid: req.txid, status: 'sending' }])
  })

  test('delayed sends do not validate the scheduling-time aggregate BEEF', async () => {
    const req = makeReadyReq()
    const beef = {
      verify: jest.fn(async () => {
        throw new Error('delayed BEEF should be rebuilt later')
      })
    } as unknown as Beef
    const storage = makeStorageFake()

    const result = await shareReqsWithWorld(storage as any, 1, [req.txid], true, {
      beef,
      details: [{ txid: req.txid, status: 'readyToSend', req }]
    })

    expect(beef.verify).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith([req.provenTxReqId], expect.objectContaining({ status: 'unsent' }), undefined)
    expect(storage.updateTransaction).toHaveBeenCalledWith([22], { status: 'sending' }, undefined)
    expect(result.swr).toEqual([{ txid: req.txid, status: 'sending' }])
  })

  test('immediate sends still validate the aggregate BEEF before broadcasting', async () => {
    const req = makeReadyReq()
    const beef = {
      verify: jest.fn(async () => false),
      toLogString: () => 'invalid beef'
    } as unknown as Beef
    const storage = makeStorageFake()

    await expect(shareReqsWithWorld(storage as any, 1, [req.txid], false, {
      beef,
      details: [{ txid: req.txid, status: 'readyToSend', req }]
    })).rejects.toThrow('merged Beef failed validation')

    expect(beef.verify).toHaveBeenCalled()
    expect(storage.attemptToPostReqsToNetwork).not.toHaveBeenCalled()
  })

  test('immediate sends reuse the exact aggregate BEEF after prior validation', async () => {
    const req = makeReadyReq()
    const beef = {
      verify: jest.fn(async () => {
        throw new Error('the already validated BEEF must not be verified twice')
      })
    } as unknown as Beef
    const storage = makeStorageFake()

    const result = await shareReqsWithWorld(storage as any, 1, [req.txid], false, {
      beef,
      details: [{ txid: req.txid, status: 'readyToSend', req }],
      verified: true
    })

    expect(beef.verify).not.toHaveBeenCalled()
    expect(storage.attemptToPostReqsToNetwork).toHaveBeenCalledTimes(1)
    expect(result.swr).toEqual([{ txid: req.txid, status: 'unproven' }])
  })
})
