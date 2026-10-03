import { Beef, Telemetry, TelemetryEvent } from '@bsv/sdk'
import { processAction, shareReqsWithWorld } from '../../src/storage/methods/processAction'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { TableProvenTxReq } from '../../src/storage/schema/tables/TableProvenTxReq'

function makeReadyReq(): TableProvenTxReq {
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

function makeStorageFake() {
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
  test('reports the successful processAction and share spans', async () => {
    const events: TelemetryEvent[] = []
    const storage = {
      ...makeStorageFake(),
      telemetry: new Telemetry({ sink: { capture: event => events.push(event) } })
    }

    const result = await processAction(
      storage as any,
      { userId: 1 },
      {
        isNewTx: false,
        isSendWith: false,
        isNoSend: true,
        isDelayed: false,
        sendWith: []
      }
    )

    expect(result.sendWithResults).toEqual([])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'wallet.storage.process_action.share', spanStatus: 'ok' }),
        expect.objectContaining({
          name: 'wallet.storage.process_action',
          spanStatus: 'ok',
          attributes: expect.objectContaining({ 'action.send_result_count': 0 })
        })
      ])
    )
  })

  test('preserves the non-instrumented processAction path when telemetry is disabled', async () => {
    const storage = {
      ...makeStorageFake(),
      telemetry: new Telemetry()
    }

    await expect(
      processAction(
        storage as any,
        { userId: 1 },
        {
          isNewTx: false,
          isSendWith: false,
          isNoSend: true,
          isDelayed: false,
          sendWith: []
        }
      )
    ).resolves.toMatchObject({ sendWithResults: [] })
  })

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
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith(
      [req.provenTxReqId],
      expect.objectContaining({ status: 'unsent' }),
      undefined
    )
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
    expect(storage.updateProvenTxReq).toHaveBeenCalledWith(
      [req.provenTxReqId],
      expect.objectContaining({ status: 'unsent' }),
      undefined
    )
    expect(storage.updateTransaction).toHaveBeenCalledWith([22], { status: 'sending' }, undefined)
    expect(result.swr).toEqual([{ txid: req.txid, status: 'sending' }])
  })

  test.each([true, false])('does not partition an atomic set when one lookup fails (delayed=%s)', async isDelayed => {
    const req = makeReadyReq()
    const missingTxid = 'b'.repeat(64)
    const beef = {
      verify: jest.fn(async () => true)
    } as unknown as Beef
    const storage = makeStorageFake()

    const result = await shareReqsWithWorld(storage as any, 1, [req.txid, missingTxid], isDelayed, {
      beef,
      details: [
        { txid: req.txid, status: 'readyToSend', req },
        { txid: missingTxid, status: 'error', error: 'lookup failed' }
      ]
    })

    expect(result.swr).toEqual([
      { txid: req.txid, status: 'failed' },
      { txid: missingTxid, status: 'failed' }
    ])
    expect(storage.transaction).not.toHaveBeenCalled()
    expect(storage.updateProvenTxReq).not.toHaveBeenCalled()
    expect(storage.updateTransaction).not.toHaveBeenCalled()
    expect(storage.attemptToPostReqsToNetwork).not.toHaveBeenCalled()
    expect(beef.verify).not.toHaveBeenCalled()
  })

  test('turns a delayed lookup exception into a whole-set failure before scheduling', async () => {
    const req = makeReadyReq()
    const missingTxid = 'b'.repeat(64)
    const storage = {
      ...makeStorageFake(),
      findProvenTxs: jest.fn(async ({ partial }: { partial: { txid: string } }) => {
        if (partial.txid === missingTxid) throw new Error('storage unavailable')
        return []
      }),
      findProvenTxReqs: jest.fn(async () => [req])
    }

    const result = await shareReqsWithWorld(storage as any, 1, [req.txid, missingTxid], true)

    expect(result.swr).toEqual([
      { txid: req.txid, status: 'failed' },
      { txid: missingTxid, status: 'failed' }
    ])
    expect(storage.transaction).not.toHaveBeenCalled()
  })

  test('marks a BEEF assembly exception as an error instead of retaining ready status', async () => {
    const req = makeReadyReq()
    const storage = Object.create(StorageProvider.prototype) as StorageProvider & Record<string, unknown>
    Object.assign(storage, {
      findProvenTxs: jest.fn(async () => []),
      findProvenTxReqs: jest.fn(async () => [req]),
      mergeReqToBeefToShareExternally: jest.fn(async () => {
        throw new Error('BEEF source unavailable')
      })
    })

    const result = await storage.getReqsAndBeefToShareWithWorld([req.txid], [])

    expect(result.details).toEqual([expect.objectContaining({ txid: req.txid, status: 'error' })])
  })

  test('immediate sends still validate the aggregate BEEF before broadcasting', async () => {
    const req = makeReadyReq()
    const beef = {
      bumps: [],
      verify: jest.fn(async () => false),
      toLogString: () => 'invalid beef'
    } as unknown as Beef
    const storage = makeStorageFake()

    await expect(
      shareReqsWithWorld(storage as any, 1, [req.txid], false, {
        beef,
        details: [{ txid: req.txid, status: 'readyToSend', req }]
      })
    ).rejects.toThrow('merged Beef failed validation')

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
