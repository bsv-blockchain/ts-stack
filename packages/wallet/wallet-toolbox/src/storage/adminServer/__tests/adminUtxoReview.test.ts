import { runAdminUtxoReview } from '../reviewUtxos'

function makePage(log: string, overrides: Record<string, unknown> = {}): any {
  return {
    found: true,
    userId: 7,
    identityKey: 'customer',
    mode: 'all',
    release: false,
    offset: 0,
    pageLimit: 100,
    sourceScanned: 1,
    complete: true,
    checked: 1,
    confirmedUnspent: 1,
    confirmedSpent: 0,
    unknown: 0,
    confirmedSpentSatoshis: 0,
    released: 0,
    releasedSatoshis: 0,
    providers: ['mock'],
    providerCount: 1,
    providersTruncated: false,
    log,
    ...overrides
  }
}

function makeHarness(reviewPageByIdentityKey: jest.Mock) {
  return {
    storage: { insertMonitorEvent: jest.fn().mockResolvedValue(1) },
    task: { reviewPageByIdentityKey }
  }
}

function eventDetails(insertMonitorEvent: jest.Mock, index: number): any {
  return JSON.parse(insertMonitorEvent.mock.calls[index][0].details)
}

describe('runAdminUtxoReview', () => {
  test('passes an explicit scan-only request and records start/completion evidence', async () => {
    const harness = makeHarness(jest.fn().mockResolvedValue(makePage('scan log')))

    await expect(
      runAdminUtxoReview({
        ...harness,
        requestedBy: 'operator',
        identityKey: 'customer',
        mode: 'all',
        release: false,
        pageLimit: 100,
        offset: 0
      })
    ).resolves.toMatchObject({
      requestedBy: 'operator',
      identityKey: 'customer',
      mode: 'all',
      release: false,
      log: 'scan log'
    })

    expect(harness.task.reviewPageByIdentityKey).toHaveBeenCalledWith('customer', 'all', false, 100, 0)
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
        release: true,
        pageLimit: 100,
        offset: 0
      })
    ).rejects.toBe(error)

    expect(harness.task.reviewPageByIdentityKey).toHaveBeenCalledWith('customer', 'change', true, 100, 0)
    expect(harness.storage.insertMonitorEvent).toHaveBeenCalledTimes(2)
    expect(eventDetails(harness.storage.insertMonitorEvent, 1)).toMatchObject({
      phase: 'failed',
      release: true,
      error: 'UTXO review was inconclusive'
    })
  })

  test('bounds durable log evidence without truncating the API result', async () => {
    const log = 'x'.repeat(5_000)
    const harness = makeHarness(jest.fn().mockResolvedValue(makePage(log)))

    await expect(
      runAdminUtxoReview({
        ...harness,
        requestedBy: 'operator',
        identityKey: 'customer',
        mode: 'all',
        release: false,
        pageLimit: 100,
        offset: 0
      })
    ).resolves.toMatchObject({ log })

    expect(eventDetails(harness.storage.insertMonitorEvent, 1)).toMatchObject({
      phase: 'completed',
      log: 'x'.repeat(4_096),
      logTruncated: true
    })
  })
})
