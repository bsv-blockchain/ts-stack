import { BroadcastResponse, BroadcastFailure, Broadcaster } from '../Broadcaster.js'
import Transaction from '../Transaction.js'
import { HttpClient } from '../http/HttpClient.js'
import { defaultHttpClient } from '../http/DefaultHttpClient.js'
import {
  normalizeBroadcasterHttpClient,
  normalizeBsvNetwork,
  providerDiagnostic,
  providerStatusCode,
  TRANSACTION_ID
} from './BroadcasterValidation.js'
import { lockConfiguration } from '../http/ConfigurationLock.js'

/**
 * Represents an WhatsOnChain transaction broadcaster.
 */
export default class WhatsOnChainBroadcaster implements Broadcaster {
  readonly network: string
  private readonly URL: string
  private readonly httpClient: HttpClient

  /**
   * Constructs an instance of the WhatsOnChain broadcaster.
   *
   * @param {'main' | 'test' | 'stn'} network - The BSV network to use when calling the WhatsOnChain API.
   * @param {HttpClient} httpClient - The HTTP client used to make requests to the API.
   */
  constructor(
    network: 'main' | 'test' | 'stn' = 'main',
    httpClient: HttpClient = defaultHttpClient()
  ) {
    this.network = normalizeBsvNetwork(network)
    this.URL = `https://api.whatsonchain.com/v1/bsv/${this.network}/tx/raw`
    this.httpClient = normalizeBroadcasterHttpClient(httpClient, "What's On Chain httpClient")
    lockConfiguration(this, ['network', 'URL', 'httpClient'])
  }

  /**
   * Broadcasts a transaction via WhatsOnChain.
   *
   * @param {Transaction} tx - The transaction to be broadcasted.
   * @returns {Promise<BroadcastResponse | BroadcastFailure>} A promise that resolves to either a success or failure response.
   */
  async broadcast(tx: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const rawTx = tx.toHex()

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/plain'
      },
      data: { txhex: rawTx }
    }

    try {
      const response = await this.httpClient.request<string>(this.URL, requestOptions)
      if (response.ok) {
        const expectedTxid = tx.id('hex')
        if (
          typeof expectedTxid !== 'string' ||
          !TRANSACTION_ID.test(expectedTxid) ||
          typeof response.data !== 'string' ||
          !TRANSACTION_ID.test(response.data) ||
          response.data.toLowerCase() !== expectedTxid.toLowerCase()
        ) {
          return {
            status: 'error',
            code: 'ERR_TXID_MISMATCH',
            description:
              'Broadcaster acknowledged a transaction other than the submitted transaction'
          }
        }
        return {
          status: 'success',
          txid: expectedTxid.toLowerCase(),
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
