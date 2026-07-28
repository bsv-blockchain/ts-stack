import { Transaction } from '@bsv/sdk'

import { inputSourceTxid, MockServices, rawTransactionBytes } from '../MockServices'

describe('MockServices transaction normalization', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('normalizes every storage representation without copying arrays', () => {
    const array = [1, 2, 3]
    expect(rawTransactionBytes(array)).toBe(array)
    expect(rawTransactionBytes(Buffer.from([4, 5]))).toEqual([4, 5])
    expect(rawTransactionBytes(Uint8Array.from([6, 7]))).toEqual([6, 7])
  })

  test('prefers an explicit source transaction ID and falls back to the source transaction', () => {
    const sourceTransaction = {
      id: jest.fn(() => 'source-transaction')
    }

    expect(
      inputSourceTxid({
        sourceTXID: 'explicit',
        sourceTransaction
      } as unknown as Transaction['inputs'][number])
    ).toBe('explicit')
    expect(sourceTransaction.id).not.toHaveBeenCalled()

    expect(
      inputSourceTxid({
        sourceTXID: '',
        sourceTransaction
      } as unknown as Transaction['inputs'][number])
    ).toBe('source-transaction')
    expect(
      inputSourceTxid({
        sourceTXID: undefined,
        sourceTransaction: undefined
      } as unknown as Transaction['inputs'][number])
    ).toBeUndefined()
  })

  test('uses normalized IDs throughout validation and spend bookkeeping', async () => {
    const service = Object.create(MockServices.prototype) as any
    const sourceTransaction = {
      id: jest.fn(() => 'source'),
      merklePath: {}
    }
    const input = {
      sourceTXID: '',
      sourceTransaction,
      sourceOutputIndex: 3
    }
    service.storage = {
      getUtxo: jest.fn(async () => ({
        spentByTxid: null,
        isCoinbase: false,
        blockHeight: null
      })),
      markUtxoSpent: jest.fn(async () => {})
    }

    await service.validateTxInput(input, 0, 200)
    await service.spendInputs({ inputs: [input] }, 'spending')

    expect(service.storage.getUtxo).toHaveBeenCalledWith('source', 3)
    expect(service.storage.markUtxoSpent).toHaveBeenCalledWith('source', 3, 'spending')

    await service.spendInputs(
      {
        inputs: [{ sourceOutputIndex: 4 }]
      },
      'missing-source'
    )
    expect(service.storage.markUtxoSpent).toHaveBeenLastCalledWith('', 4, 'missing-source')
  })

  test('loads stored transaction encodings and preserves missing-row semantics', async () => {
    const service = Object.create(MockServices.prototype) as any
    const parsed = { inputs: [] }
    const fromBinary = jest.spyOn(Transaction, 'fromBinary').mockReturnValue(parsed as never)
    service.storage = {
      getTransaction: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rawTx: Uint8Array.from([1, 2, 3]) })
        .mockResolvedValueOnce({ rawTx: Buffer.from([4, 5, 6]) })
    }

    await expect(service.loadSourceTransaction('missing')).resolves.toBeUndefined()
    await expect(service.loadSourceTransaction('present')).resolves.toBe(parsed)
    expect(fromBinary).toHaveBeenCalledWith([1, 2, 3])
    await expect(service.getRawTx('raw')).resolves.toEqual({
      txid: 'raw',
      rawTx: [4, 5, 6],
      name: 'MockServices'
    })
  })

  test('handles missing proof rows, default exchange rates, and BEEF recursion inputs', async () => {
    const service = Object.create(MockServices.prototype) as any
    service.storage = {
      getTransaction: jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ blockHeight: null })
    }

    await expect(service.getMerklePath('missing')).resolves.toEqual({})
    await expect(service.getMerklePath('unmined')).resolves.toEqual({})
    service.storage.getTransaction.mockResolvedValueOnce({ blockHeight: 10 })
    service.storage.getTransactionsInBlock = jest.fn(async () => [])
    await expect(service.getMerklePath('absent-from-block')).resolves.toEqual({})
    await expect(service.getFiatExchangeRate('EUR')).resolves.toBe(0.92)
    await expect(service.getFiatExchangeRate('EUR', 'GBP')).resolves.toBeCloseTo(0.92 / 0.79)

    jest.spyOn(Transaction, 'fromBinary').mockReturnValue({
      inputs: [
        {
          sourceTXID: '00'.repeat(32),
          sourceOutputIndex: 0
        }
      ]
    } as never)
    const beef = {
      mergeRawTx: jest.fn(),
      mergeBump: jest.fn()
    }
    service.storage.getTransaction.mockResolvedValueOnce({ rawTx: [1], blockHeight: null })
    await service.addTxToBeef(beef, 'txid', new Set())

    expect(beef.mergeRawTx).toHaveBeenCalledWith([1])
  })
})
