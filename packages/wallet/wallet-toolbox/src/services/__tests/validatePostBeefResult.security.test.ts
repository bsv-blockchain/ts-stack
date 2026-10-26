import { Beef, LockingScript, Transaction } from '@bsv/sdk'
import { Services } from '../Services'
import {
  makePostBeefServiceError,
  normalizePostRawHex,
  normalizePostTxids,
  snapshotPostBeefRequest,
  validatePostBeefResult,
  validatePostBeefResultOrServiceError,
  validatePostTxResult,
  validatePostTxResultOrServiceError
} from '../validatePostBeefResult'

function transactionBeef(): { beef: Beef; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new LockingScript([0x51]) })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { beef, txid: tx.id('hex') }
}

describe('postBeef trust boundary', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('binds exact results, strips sensitive diagnostics, and uses local attribution', () => {
    const { txid } = transactionBeef()
    const source = {
      name: 'remote-forgery',
      status: 'error',
      txidResults: [
        {
          txid: txid.toUpperCase(),
          status: 'error',
          doubleSpend: true,
          competingTxs: ['11'.repeat(32)],
          data: { detail: 'conflict' },
          notes: [{ what: 'remoteError', rawTx: 'secret-raw', detail: 'bounded' }]
        }
      ],
      notes: [{ what: 'postBeefError', beef: 'secret-beef', url: 'https://credential.example' }]
    }

    expect(validatePostBeefResult(source, [txid], 'configured')).toEqual({
      name: 'configured',
      status: 'error',
      txidResults: [
        {
          txid,
          status: 'error',
          doubleSpend: true,
          competingTxs: ['11'.repeat(32)],
          data: { detail: 'conflict' },
          notes: [{ what: 'remoteError', detail: 'bounded' }]
        }
      ],
      notes: [{ what: 'postBeefError' }]
    })
  })

  test('rejects wrong, duplicate, missing, contradictory, accessor, and reserved timeout results', () => {
    const { txid } = transactionBeef()
    const valid = { name: 'x', status: 'success', txidResults: [{ txid, status: 'success' }] }
    expect(() => validatePostBeefResult({ ...valid, txidResults: [] }, [txid], 'x')).toThrow('exactly one')
    expect(() =>
      validatePostBeefResult({ ...valid, txidResults: [{ txid: '22'.repeat(32), status: 'success' }] }, [txid], 'x')
    ).toThrow('exact requested')
    expect(() =>
      validatePostBeefResult({ ...valid, status: 'success', txidResults: [{ txid, status: 'error' }] }, [txid], 'x')
    ).toThrow('success exactly')
    expect(() =>
      validatePostBeefResult({ ...valid, txidResults: [{ txid, status: 'success', doubleSpend: true }] }, [txid], 'x')
    ).toThrow('without double-spend')
    expect(() =>
      validatePostBeefResult({ ...valid, notes: [{ what: 'postBeefServiceTimeout' }] }, [txid], 'x')
    ).toThrow('reserved local timeout')

    let invoked = false
    const item = { txid, status: 'success' }
    Object.defineProperty(item, 'txid', {
      enumerable: true,
      get: () => {
        invoked = true
        return txid
      }
    })
    expect(() => validatePostBeefResult({ ...valid, txidResults: [item] }, [txid], 'x')).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('snapshots a bounded request and rejects missing or duplicate requested transactions', () => {
    const { beef, txid } = transactionBeef()
    const request = snapshotPostBeefRequest(beef, [txid.toUpperCase()])
    expect(request.txids).toEqual([txid])
    expect(Beef.fromBinaryStrict(request.beefBytes).findTxid(txid)?.rawTx).toBeDefined()
    expect(() => snapshotPostBeefRequest(beef, [txid, txid])).toThrow('unique')
    expect(() => snapshotPostBeefRequest(beef, ['33'.repeat(32)])).toThrow('exact ID')
  })

  test('normalizes bounded direct-broadcast payloads and transaction identities', () => {
    const txid = '44'.repeat(32)
    expect(normalizePostRawHex('AABB', 2)).toBe('aabb')
    expect(normalizePostTxids([txid.toUpperCase()])).toEqual([txid])
    expect(() => normalizePostRawHex('not-hex', 100)).toThrow('hexadecimal')
    expect(() => normalizePostRawHex('aa'.repeat(3), 2)).toThrow('no larger')
    expect(() => normalizePostTxids([])).toThrow('1 through')
    expect(() => normalizePostTxids([txid, txid])).toThrow('unique')
  })

  test('rejects hostile array shapes, unsafe byte limits, and non-data aggregate records', () => {
    const txid = '44'.repeat(32)
    expect(() => normalizePostRawHex('aa', 0)).toThrow('maximumBytes')
    expect(() => normalizePostRawHex('a', 1)).toThrow('hexadecimal')
    expect(normalizePostTxids([], 'txids', true)).toEqual([])

    const sparse = Array(1) as string[]
    expect(() => normalizePostTxids(sparse)).toThrow('dense array')
    const extra = [txid]
    Object.defineProperty(extra, 'extra', { enumerable: true, value: true })
    expect(() => normalizePostTxids(extra)).toThrow('dense array')
    const getter = jest.fn(() => txid)
    const accessor = [txid]
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter })
    expect(() => normalizePostTxids(accessor)).toThrow('dense array')
    expect(getter).not.toHaveBeenCalled()

    for (const value of [null, [], Object.assign(Object.create({ inherited: true }), {})]) {
      expect(() => validatePostBeefResult(value, [txid], 'provider')).toThrow('plain data object')
    }
    expect(() =>
      validatePostBeefResult(
        { status: 'success', txidResults: [{ txid, status: 'success' }], [Symbol('hostile')]: true },
        [txid],
        'provider'
      )
    ).toThrow('without symbols')
    expect(() =>
      validatePostBeefResult(
        { status: 'success', txidResults: [{ txid, status: 'success' }], secret: true },
        [txid],
        'x'
      )
    ).toThrow('documented aggregate-result fields')
  })

  test('owns a rich error result while validating every optional transaction field', () => {
    const txid = '55'.repeat(32)
    const competitor = '66'.repeat(32)
    const remoteError = new Error('bounded failure')
    const source = {
      status: 'error',
      error: remoteError,
      txidResults: [
        {
          txid: txid.toUpperCase(),
          status: 'error',
          alreadyKnown: false,
          doubleSpend: true,
          serviceError: false,
          competingTxs: [competitor.toUpperCase()],
          blockHash: '77'.repeat(32).toUpperCase(),
          blockHeight: 0,
          data: { nested: [true, null, 1, 'a\u0000b'] },
          notes: [{ what: 'rejected', retryable: false, code: 42, detail: 'bounded' }]
        }
      ],
      data: { accepted: false },
      notes: [{ what: 'providerError', when: '2026-01-01T00:00:00.000Z' }]
    }
    const result = validatePostBeefResult(source, [txid], 'provider')
    expect(result).toMatchObject({
      name: 'provider',
      status: 'error',
      txidResults: [
        {
          txid,
          competingTxs: [competitor],
          blockHash: '77'.repeat(32),
          blockHeight: 0,
          data: { nested: [true, null, 1, 'a b'] }
        }
      ],
      data: { accepted: false }
    })
    expect(result.error).toBeDefined()
    expect(result).not.toBe(source)
    expect(result.txidResults[0]).not.toBe(source.txidResults[0])
  })

  test('rejects contradictory and unbounded optional transaction evidence', () => {
    const txid = '55'.repeat(32)
    const base = { txid, status: 'error' }
    const aggregate = (item: Record<string, unknown>) => ({ status: 'error', txidResults: [item] })
    const invalid = [
      { ...base, unknown: true },
      { ...base, status: 'pending' },
      { ...base, alreadyKnown: 'yes' },
      { ...base, alreadyKnown: true },
      { ...base, doubleSpend: true, serviceError: true },
      { ...base, competingTxs: ['66'.repeat(32)] },
      { ...base, doubleSpend: true, competingTxs: [txid] },
      { ...base, doubleSpend: true, competingTxs: ['66'.repeat(32), '66'.repeat(32)] },
      { ...base, blockHash: 'bad' },
      { ...base, blockHeight: -1 },
      { ...base, data: Number.POSITIVE_INFINITY },
      { ...base, data: { value: 'x'.repeat(4097) } },
      { ...base, notes: [{ what: 'bad\nwhat' }] },
      { ...base, notes: [{ what: 'bad', nested: {} }] }
    ]
    for (const item of invalid) expect(() => validatePostBeefResult(aggregate(item), [txid], 'provider')).toThrow()

    expect(() =>
      validatePostBeefResult(
        { status: 'success', error: new Error('impossible'), txidResults: [{ txid, status: 'success' }] },
        [txid],
        'provider'
      )
    ).toThrow('Error on an error result')
    expect(() => validatePostBeefResult(aggregate(base), [txid], 'bad\nprovider')).toThrow('control characters')
  })

  test('validates single-transaction adapters and creates only authenticated local service errors', () => {
    const txid = '88'.repeat(32)
    expect(validatePostTxResult({ txid, status: 'success', alreadyKnown: true }, txid, 'single')).toEqual({
      txid,
      status: 'success',
      alreadyKnown: true
    })
    expect(validatePostTxResultOrServiceError({ txid: 'bad', status: 'success' }, txid, 'single')).toMatchObject({
      txid,
      status: 'error',
      serviceError: true
    })
    expect(validatePostBeefResultOrServiceError(null, [txid], 'aggregate')).toMatchObject({
      name: 'aggregate',
      status: 'error',
      txidResults: [{ txid, status: 'error', serviceError: true }]
    })
    expect(makePostBeefServiceError('aggregate', [txid], 'postBeefServiceTimeout', 25)).toMatchObject({
      notes: [{ what: 'postBeefServiceTimeout', timeoutMs: 25 }]
    })
  })

  test('contains a malformed or throwing provider, isolates provider inputs, and continues', async () => {
    const { beef, txid } = transactionBeef()
    const services = new Services(Services.createDefaultOptions('main'))
    services.postBeefUntilSuccessSoftTimeoutMs = 0
    services.postBeefServices.services = [
      {
        name: 'bad',
        service: async (providerBeef, providerTxids) => {
          providerBeef.txs.splice(0)
          providerTxids[0] = '44'.repeat(32)
          throw new Error('remote detail')
        }
      },
      {
        name: 'good',
        service: async (providerBeef, providerTxids) => ({
          name: 'remote-forgery',
          status: providerBeef.findTxid(txid)?.rawTx != null && providerTxids[0] === txid ? 'success' : 'error',
          txidResults: [{ txid, status: 'success' }]
        })
      }
    ]

    const results = await services.postBeef(beef, [txid])
    expect(results[0]).toMatchObject({
      name: 'bad',
      status: 'error',
      txidResults: [{ txid, status: 'error', serviceError: true }],
      notes: [{ what: 'postBeefServiceError' }]
    })
    expect(results[1]).toEqual({
      name: 'good',
      status: 'success',
      txidResults: [{ txid, status: 'success' }]
    })
    expect(beef.findTxid(txid)?.rawTx).toBeDefined()
  })

  test('bounds failover latency without trusting a provider timeout marker', async () => {
    jest.useFakeTimers()
    const { beef, txid } = transactionBeef()
    const services = new Services(Services.createDefaultOptions('main'))
    services.postBeefUntilSuccessSoftTimeoutMs = 10
    services.postBeefUntilSuccessSoftTimeoutPerKbMs = 0
    services.postBeefUntilSuccessSoftTimeoutMaxMs = 10
    services.postBeefServices.services = [
      {
        name: 'hung',
        service: async () => await new Promise(() => undefined)
      },
      {
        name: 'good',
        service: async () => ({
          name: 'remote-forgery',
          status: 'success',
          txidResults: [{ txid, status: 'success' }]
        })
      }
    ]

    const pending = services.postBeef(beef, [txid])
    await jest.advanceTimersByTimeAsync(10)

    await expect(pending).resolves.toEqual([
      {
        name: 'hung',
        status: 'error',
        txidResults: [{ txid, status: 'error', serviceError: true }],
        notes: [expect.objectContaining({ what: 'postBeefServiceTimeout', timeoutMs: 10 })]
      },
      {
        name: 'good',
        status: 'success',
        txidResults: [{ txid, status: 'success' }]
      }
    ])
  })

  test('rejects invalid orchestration mode and timeout controls before calling a provider', async () => {
    const { beef, txid } = transactionBeef()
    const services = new Services(Services.createDefaultOptions('main'))
    const provider = jest.fn()
    services.postBeefServices.services = [{ name: 'unused', service: provider }]

    services.postBeefMode = 'invalid' as Services['postBeefMode']
    await expect(services.postBeef(beef, [txid])).rejects.toThrow('postBeefMode')
    expect(provider).not.toHaveBeenCalled()

    services.postBeefMode = 'UntilSuccess'
    services.postBeefUntilSuccessSoftTimeoutMs = Number.NaN
    await expect(services.postBeef(beef, [txid])).rejects.toThrow('postBeefUntilSuccessSoftTimeoutMs')
    expect(provider).not.toHaveBeenCalled()
  })
})
