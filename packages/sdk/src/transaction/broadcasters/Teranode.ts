import type { BroadcastResponse, BroadcastFailure, Broadcaster } from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { binaryHttpClient } from '../http/BinaryFetchClient.js'
import type { HttpClient } from '../http/HttpClient.js'
import {
  normalizeBroadcasterHttpClient,
  normalizeBroadcasterUrl,
  providerDiagnostic,
  providerStatusCode,
  TRANSACTION_ID
} from './BroadcasterValidation.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

/**
 * Represents an Teranode transaction broadcaster.
 */
export default class Teranode implements Broadcaster {
  readonly URL: string
  readonly httpClient: HttpClient

  /**
   * Constructs an instance of the Teranode broadcaster.
   *
   * @param {string} URL - The URL endpoint for the Teranode API.
   * @param {HttpClient} httpClient - The HTTP client used to make requests to the API, binaryHttpClient by default.
   */
  constructor(URL: string, httpClient: HttpClient = binaryHttpClient()) {
    this.URL = normalizeBroadcasterUrl(URL, 'Teranode URL')
    this.httpClient = normalizeBroadcasterHttpClient(httpClient, 'Teranode httpClient')
    lockConfiguration(this, ['URL', 'httpClient'])
  }

  /**
   * Broadcasts a transaction via Teranode.
   *
   * @param {Transaction} tx - The transaction to be broadcasted.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const rawTx = tx.toEF()
    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      data: new Blob([new Uint8Array(rawTx)])
    }
    try {
      const response = await this.httpClient.request<string>(this.URL, requestOptions)
      if (response.ok) {
        const txid = tx.id('hex')
        if (typeof txid !== 'string' || !TRANSACTION_ID.test(txid)) {
          return {
            status: 'error',
            code: 'ERR_INVALID_RESPONSE',
            description: 'Transaction produced an invalid identifier.'
          }
        }
        return {
          status: 'success',
          txid: txid.toLowerCase(),
          message: 'broadcast successful'
        }
      } else {
        return {
          status: 'error',
          code: providerStatusCode(response.status),
          description: providerDiagnostic(response.data)
        }
      }
    } catch {
      return {
        status: 'error',
        code: '500',
        description: 'Internal Server Error'
      }
    }
  }
}
