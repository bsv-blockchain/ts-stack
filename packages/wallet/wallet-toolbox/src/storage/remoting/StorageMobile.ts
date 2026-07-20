import { WalletInterface } from '@bsv/sdk'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'
import { BINARY_ENCODING, BINARY_ENCODING_HEADER, parseJsonRpc, stringifyJsonRpc } from './BinaryJson'

/**
 * `StorageClient` (mobile variant) implements the `WalletStorageProvider` interface which allows it to
 * serve as a BRC-100 wallet's active storage.
 *
 * Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
 * Typically this server uses the `StorageServer` class to implement the service.
 *
 * This mobile variant omits the full logger support present in `StorageClient` to keep
 * the bundle lean for mobile / browser environments.
 *
 * For details of the API implemented, follow the "See also" link for the `WalletStorageProvider` interface.
 */
export class StorageClient extends StorageClientBase {
  constructor (wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
    super(wallet, endpointUrl, options)
  }

  /// ///////////////////////////////////////////////////////////////////////////
  // JSON-RPC helper
  /// ///////////////////////////////////////////////////////////////////////////

  /**
   * Make a JSON-RPC call to the remote server.
   * @param method The WalletStorage method name to call.
   * @param params The array of parameters to pass to the method in order.
   */
  protected async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const id = this.nextId++
      const body = {
        jsonrpc: '2.0',
        method,
        params,
        id
      }

      let response: Response
      try {
        response = await this.authClient.fetch(this.endpointUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', [BINARY_ENCODING_HEADER]: BINARY_ENCODING },
          body: stringifyJsonRpc(body, this.binaryRequests && this.serverSupportsBinary)
        })
      } catch (error_: unknown) {
        throw error_
      }

      if (!response.ok) {
        throw new Error(`WalletStorageClient rpcCall: network error ${response.status} ${response.statusText}`)
      }

      if (response.headers.get(BINARY_ENCODING_HEADER) === BINARY_ENCODING) this.serverSupportsBinary = true
      const json = parseJsonRpc(await response.text())
      if (json.error) {
        const { code, message, data } = json.error
        const err = new Error(`RPC Error: ${message}`)
        // You could attach more info here if you like:
        ;(err as any).code = code
        ;(err as any).data = data
        throw err
      }

      return json.result
    } catch (error_: unknown) {
      throw error_
    }
  }
}
