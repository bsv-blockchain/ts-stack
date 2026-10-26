import { HttpClient, HttpClientRequestOptions, HttpClientResponse, LockingScript, Transaction } from '@bsv/sdk'
import { Bitails } from '../Bitails'

function rawTransaction(): { rawTx: string; txid: string } {
  const tx = new Transaction()
  tx.addOutput({ satoshis: 1, lockingScript: new LockingScript([0x51]) })
  return { rawTx: tx.toHex(), txid: tx.id('hex') }
}

describe('Bitails broadcast boundary', () => {
  test('normalizes the request, applies a deadline, and binds every response txid', async () => {
    const { rawTx, txid } = rawTransaction()
    let options: HttpClientRequestOptions | undefined
    const httpClient: HttpClient = {
      async request<T>(_url: string, requestOptions: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
        options = requestOptions
        return { ok: true, status: 200, statusText: 'OK', data: [{ txid }] as T }
      }
    }

    await expect(new Bitails('main', { httpClient, requestTimeoutMsecs: 25 }).postRaws([rawTx.toUpperCase()])).resolves
      .toMatchObject({ status: 'success', txidResults: [{ txid, status: 'success' }] })
    expect(options?.data).toEqual({ raws: [rawTx] })
    expect(options?.signal).toBeInstanceOf(AbortSignal)
  })

  test('rejects malformed, excessive, accessor-backed, and foreign request identities before HTTP', async () => {
    const { rawTx, txid } = rawTransaction()
    const request = jest.fn()
    const bitails = new Bitails('main', { httpClient: { request } as HttpClient })
    let invoked = false
    const raws = [rawTx]
    Object.defineProperty(raws, '0', {
      enumerable: true,
      get: () => {
        invoked = true
        return rawTx
      }
    })

    await expect(bitails.postRaws(raws)).rejects.toThrow('accessor-free')
    expect(invoked).toBe(false)
    await expect(bitails.postRaws([])).rejects.toThrow('1 through')
    await expect(bitails.postRaws(['not-hex'])).rejects.toThrow('hexadecimal')
    await expect(bitails.postRaws([rawTx], ['11'.repeat(32)])).rejects.toThrow('present in raws')
    await expect(bitails.postRaws([rawTx], [txid, txid])).rejects.toThrow('unique')
    expect(request).not.toHaveBeenCalled()
  })

  test('rejects invalid request timeout configuration', () => {
    expect(() => new Bitails('main', { requestTimeoutMsecs: 0 })).toThrow('requestTimeoutMsecs')
  })
})
