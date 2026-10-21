import { Beef } from '@bsv/sdk'
import { StorageProvider } from '../../StorageProvider'
import { EntityProvenTxReq } from '../../schema/entities'
import { ProvenTxReqStatus } from '../../../sdk/types'
import { aggregateActionResults } from '../../../utility/aggregateResults'
import {
  AggregatePostBeefTxResult,
  PostReqsToNetworkResult,
  updateReqsFromAggregateResults
} from '../attemptToPostReqsToNetwork'

function fixture(storedStatus: ProvenTxReqStatus, status: AggregatePostBeefTxResult['status']) {
  const txid = '11'.repeat(32)
  const req = EntityProvenTxReq.fromTxid(txid, [1], [])
  req.id = 1
  req.status = 'unsent'
  req.addNotifyTransactionId(1)
  const stored = { ...req.toApi(), status: storedStatus }
  const findProvenTxReqs = jest.fn().mockResolvedValue([stored])
  const updateProvenTxReqDynamics = jest.fn().mockResolvedValue(1)
  const updateTransactionsStatus = jest.fn().mockResolvedValue(undefined)
  const storage = {
    isStorageProvider: () => true,
    findProvenTxReqs,
    updateProvenTxReqDynamics,
    updateTransactionsStatus
  } as unknown as StorageProvider
  const detail = { txid, req, status: 'unknown' as const }
  const result: PostReqsToNetworkResult = { status: 'success', beef: new Beef(), details: [detail], log: '' }
  const aggregate: AggregatePostBeefTxResult = {
    txid,
    vreq: detail,
    txidResults: [],
    status,
    successCount: status === 'success' ? 1 : 0,
    doubleSpendCount: status === 'doubleSpend' ? 1 : 0,
    statusErrorCount: status === 'invalidTx' ? 1 : 0,
    serviceErrorCount: status === 'serviceError' ? 1 : 0,
    competingTxs: status === 'doubleSpend' ? ['22'.repeat(32)] : []
  }
  return {
    txid,
    req,
    result,
    aggregate,
    storage,
    findProvenTxReqs,
    updateProvenTxReqDynamics,
    updateTransactionsStatus
  }
}

describe('broadcast result for an advanced durable request', () => {
  test.each(['unmined', 'completed'] as const)(
    'returns a successful receipt without downgrading %s',
    async storedStatus => {
      const f = fixture(storedStatus, 'success')
      await updateReqsFromAggregateResults([f.txid], f.result, { [f.txid]: f.aggregate }, f.storage)

      expect(f.findProvenTxReqs).toHaveBeenCalledTimes(1)
      expect(f.req.status).toBe(storedStatus)
      expect(f.updateProvenTxReqDynamics).not.toHaveBeenCalled()
      expect(f.updateTransactionsStatus).not.toHaveBeenCalled()
      expect(f.result.details[0]).toMatchObject({ status: 'success', competingTxs: [] })
      await expect(aggregateActionResults(f.storage, [{ txid: f.txid, status: 'sending' }], f.result)).resolves.toEqual(
        {
          swr: [{ txid: f.txid, status: 'unproven' }],
          rar: [{ txid: f.txid, status: 'success', competingTxs: [] }]
        }
      )
    }
  )

  test.each(['unmined', 'completed'] as const)(
    'preserves negative provider outcomes when storage is %s',
    async storedStatus => {
      for (const status of ['doubleSpend', 'invalidTx', 'serviceError'] as const) {
        const f = fixture(storedStatus, status)
        await updateReqsFromAggregateResults([f.txid], f.result, { [f.txid]: f.aggregate }, f.storage)

        expect(f.result.details[0]).toMatchObject({ status, competingTxs: f.aggregate.competingTxs })
        expect(f.req.status).toBe(storedStatus)
        expect(f.updateProvenTxReqDynamics).not.toHaveBeenCalled()
        expect(f.updateTransactionsStatus).not.toHaveBeenCalled()
      }
    }
  )

  test.each([
    ['success', 'unmined', 'unproven'],
    ['doubleSpend', 'doubleSpend', 'failed'],
    ['invalidTx', 'invalid', 'failed'],
    ['serviceError', 'sending', 'sending']
  ] as const)('retains normal %s transitions for an unsent request', async (status, reqStatus, txStatus) => {
    const f = fixture('unsent', status)
    await updateReqsFromAggregateResults([f.txid], f.result, { [f.txid]: f.aggregate }, f.storage)

    expect(f.result.details[0]).toMatchObject({ status, competingTxs: f.aggregate.competingTxs })
    expect(f.req.status).toBe(reqStatus)
    expect(f.updateProvenTxReqDynamics).toHaveBeenCalledTimes(1)
    expect(f.updateTransactionsStatus).toHaveBeenCalledWith([1], txStatus, undefined)
  })
})
