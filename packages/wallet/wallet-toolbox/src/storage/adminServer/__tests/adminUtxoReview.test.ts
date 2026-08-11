import { runAdminUtxoReview } from '../reviewUtxos'

function makeHarness(reviewByIdentityKey: jest.Mock) {
  return {
    storage: { insertMonitorEvent: jest.fn().mockResolvedValue(1) },
    task: { reviewByIdentityKey }
  }
}

function eventDetails(insertMonitorEvent: jest.Mock, index: number): any {
  return JSON.parse(insertMonitorEvent.mock.calls[index][0].details)
}

describe('runAdminUtxoReview', () => {
  test('passes an explicit scan-only request and records start/completion evidence', async () => {
    const harness = makeHarness(jest.fn().mockResolvedValue('scan log'))

    await expect(
      runAdminUtxoReview({
        ...harness,
        requestedBy: 'operator',
        identityKey: 'customer',
        mode: 'all',
        release: false
      })
    ).resolves.toEqual({
      requestedBy: 'operator',
      identityKey: 'customer',
      mode: 'all',
      release: false,
      log: 'scan log'
    })

    expect(harness.task.reviewByIdentityKey).toHaveBeenCalledWith('customer', 'all', false)
    expect(harness.storage.insertMonitorEvent).toHaveBeenCalledTimes(2)
    expect(eventDetails(harness.storage.insertMonitorEvent, 0)).toMatchObject({
      phase: 'started',
      release: false
    })
    expect(eventDetails(harness.storage.insertMonitorEvent, 1)).toMatchObject({
      phase: 'completed',
      release: false,
      log: 'scan log'
    })
  })

  test('passes explicit release and records a failed inconclusive review', async () => {
    const error = new Error('UTXO review was inconclusive')
    const harness = makeHarness(jest.fn().mockRejectedValue(error))

    await expect(
      runAdminUtxoReview({
        ...harness,
        requestedBy: 'operator',
        identityKey: 'customer',
        mode: 'change',
        release: true
      })
    ).rejects.toBe(error)

    expect(harness.task.reviewByIdentityKey).toHaveBeenCalledWith('customer', 'change', true)
    expect(harness.storage.insertMonitorEvent).toHaveBeenCalledTimes(2)
    expect(eventDetails(harness.storage.insertMonitorEvent, 1)).toMatchObject({
      phase: 'failed',
      release: true,
      error: 'UTXO review was inconclusive'
    })
  })

  test('bounds durable log evidence without truncating the API result', async () => {
    const log = 'x'.repeat(5_000)
    const harness = makeHarness(jest.fn().mockResolvedValue(log))

    await expect(
      runAdminUtxoReview({
        ...harness,
        requestedBy: 'operator',
        identityKey: 'customer',
        mode: 'all',
        release: false
      })
    ).resolves.toMatchObject({ log })

    expect(eventDetails(harness.storage.insertMonitorEvent, 1)).toMatchObject({
      phase: 'completed',
      log: 'x'.repeat(4_096),
      logTruncated: true
    })
  })
})
