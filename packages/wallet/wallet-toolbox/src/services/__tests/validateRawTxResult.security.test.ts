import { Script, Transaction } from '@bsv/sdk'
import { ServiceCollection } from '../ServiceCollection'
import { Services } from '../Services'
import { copyRawTransactionBytes, validateRawTxResult } from '../validateRawTxResult'

function transactionFixture(): { rawTx: number[]; txid: string } {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    sequence: 0xffffffff,
    unlockingScript: Script.fromASM('OP_1')
  })
  transaction.addOutput({ lockingScript: Script.fromASM('OP_1'), satoshis: 1 })
  return { rawTx: transaction.toBinary(), txid: transaction.id('hex') }
}

describe('raw-transaction provider trust boundary', () => {
  test('binds, copies, and locally attributes a provider result', () => {
    const { txid, rawTx } = transactionFixture()
    const source = { txid: txid.toUpperCase(), name: 'remote-name', rawTx }

    const result = validateRawTxResult(source, txid, 'configured-name')

    expect(result).toEqual({ txid, name: 'configured-name', rawTx })
    expect(result.rawTx).not.toBe(rawTx)
    rawTx[0] ^= 1
    expect(result.rawTx?.[0]).not.toBe(rawTx[0])
  })

  test('rejects sparse, non-byte, wrong-id, and accessor-backed results', () => {
    const { txid, rawTx } = transactionFixture()
    const sparse: number[] = []
    sparse.length = rawTx.length
    sparse[0] = rawTx[0]
    expect(() => copyRawTransactionBytes(sparse)).toThrow('dense')
    expect(() => copyRawTransactionBytes([256])).toThrow('integer byte')
    expect(() => validateRawTxResult({ txid: '22'.repeat(32), rawTx }, txid)).toThrow('requested')

    let invoked = false
    const accessor = { txid }
    Object.defineProperty(accessor, 'rawTx', {
      enumerable: true,
      get: () => {
        invoked = true
        return rawTx
      }
    })
    expect(() => validateRawTxResult(accessor, txid)).toThrow('accessor-free')
    expect(invoked).toBe(false)
  })

  test('Services rejects malformed providers, falls through, and returns owned bytes', async () => {
    const { txid, rawTx } = transactionFixture()
    const services = new Services(Services.createDefaultOptions('main'))
    const wrong = jest.fn(async () => ({ txid: '33'.repeat(32), rawTx }))
    const source = [...rawTx]
    const valid = jest.fn(async () => ({ txid, name: 'remote-name', rawTx: source }))
    services.getRawTxServices = new ServiceCollection('getRawTx', [
      { name: 'wrong', service: wrong },
      { name: 'valid', service: valid }
    ])

    const result = await services.getRawTx(txid.toUpperCase())

    expect(result).toEqual({ txid, name: 'valid', rawTx })
    expect(result.rawTx).not.toBe(source)
    source[0] ^= 1
    expect(result.rawTx?.[0]).toBe(rawTx[0])
    const history = services.getRawTxServices.getServiceCallHistory()
    expect(history.historyByProvider.wrong.totalCounts.error).toBe(1)
    expect(history.historyByProvider.valid.totalCounts.success).toBe(1)
  })
})
