import { Validation } from '@bsv/sdk'
import { validateActionBatchSendWith } from '../actionBatchBlobs'
import { processAction, shareReqsWithWorld } from '../processAction'

const txids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, '0'))

describe('storage atomic broadcast bounds', () => {
  test('rejects oversized or noncanonical action-batch broadcast sets before storage work', () => {
    expect(() => validateActionBatchSendWith(txids(Validation.MAXIMUM_SEND_WITH_TRANSACTIONS))).not.toThrow()
    expect(() => validateActionBatchSendWith(txids(Validation.MAXIMUM_SEND_WITH_TRANSACTIONS + 1))).toThrow('sendWith')
    expect(() => validateActionBatchSendWith(['A'.repeat(64)])).toThrow('canonical')
  })

  test('rejects oversized direct sharing before invoking storage', async () => {
    await expect(
      shareReqsWithWorld({} as any, 1, txids(Validation.MAXIMUM_SEND_WITH_TRANSACTIONS + 1), true)
    ).rejects.toThrow('at most')
  })

  test('rejects inconsistent flags and reserves a slot for a new transaction before telemetry or persistence', async () => {
    const storage = { telemetry: { enabled: false } }
    await expect(
      processAction(storage as any, { userId: 1 } as any, {
        isNewTx: false,
        isSendWith: false,
        isNoSend: false,
        isDelayed: true,
        sendWith: [txids(1)[0]]
      })
    ).rejects.toThrow('isSendWith')

    await expect(
      processAction(storage as any, { userId: 1 } as any, {
        isNewTx: true,
        isSendWith: true,
        isNoSend: false,
        isDelayed: true,
        sendWith: txids(Validation.MAXIMUM_SEND_WITH_TRANSACTIONS)
      })
    ).rejects.toThrow('at most')
  })
})
