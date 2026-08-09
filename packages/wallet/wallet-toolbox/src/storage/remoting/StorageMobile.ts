import { WalletInterface } from '@bsv/sdk'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'
import {
  BINARY_ENCODING,
  BINARY_ENCODING_HEADER,
  BINARY_REQUEST_ENCODING_HEADER,
  parseJsonRpc,
  stringifyJsonRpc
} from './BinaryJson'

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
  constructor(wallet: WalletInterface, endpointUrl: string, options: StorageClientOptions = {}) {
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
    return await this.traceRpcCall(method, params, async rpcSpan => {
      const id = this.nextId++
      const body = {
        jsonrpc: '2.0',
        method,
        params,
        id
      }

      const requestUsesBinary = this.binaryRequests && this.serverSupportsBinary
      const requestBody = await this.traceRpcStep(
        'wallet.storage.request.serialize',
        rpcSpan,
        () => stringifyJsonRpc(body, requestUsesBinary),
        { 'rpc.encoding': requestUsesBinary ? 'binary-json' : 'json' }
      )
      const response = await this.traceRpcStep(
        'wallet.storage.http',
        rpcSpan,
        async () =>
          await this.authClient.fetch(this.endpointUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              [BINARY_ENCODING_HEADER]: BINARY_ENCODING,
              ...(requestUsesBinary ? { [BINARY_REQUEST_ENCODING_HEADER]: BINARY_ENCODING } : {})
            },
            body: requestBody
          }),
        {
          'http.request.method': 'POST',
          'rpc.encoding': requestUsesBinary ? 'binary-json' : 'json'
        }
      )

      if (!response.ok) {
        throw new Error(`WalletStorageClient rpcCall: network error ${response.status} ${response.statusText}`)
      }

      const responseUsesBinary = response.headers.get(BINARY_ENCODING_HEADER) === BINARY_ENCODING
      if (responseUsesBinary) this.serverSupportsBinary = true
      const responseText = await this.traceRpcStep(
        'wallet.storage.response.read',
        rpcSpan,
        async () => await response.text(),
        {
          'http.response.status_code': response.status,
          'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json'
        }
      )
      const json = await this.traceRpcStep(
        'wallet.storage.response.parse',
        rpcSpan,
        () => parseJsonRpc(responseText, responseUsesBinary),
        {
          'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json',
          'response.size_bytes': responseText.length
        }
      )
      if (json.error) {
        const { code, message, data } = json.error
        const err = new Error(`RPC Error: ${message}`)
        // You could attach more info here if you like:
        ;(err as any).code = code
        ;(err as any).data = data
        throw err
      }

      rpcSpan?.end({
        attributes: {
          'http.response.status_code': response.status,
          'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json'
        }
      })
      return json.result
    })
  }
}
