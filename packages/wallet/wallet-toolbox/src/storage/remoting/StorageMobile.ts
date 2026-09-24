import { WalletInterface } from '@bsv/sdk'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'
import {
  BINARY_ENCODING,
  BINARY_ENCODING_HEADER,
  BINARY_REQUEST_ENCODING_HEADER,
  parseJsonRpc,
  stringifyJsonRpc,
  validateJsonRpcResponse
} from './BinaryJson'

/**
 * `StorageClient` (mobile variant) implements the `WalletStorageProvider` interface which allows it to
 * serve as a BRC-100 wallet's active storage.
 *
 * Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
 * Typically this server uses the `StorageServer` class to implement the service.
 * Responses must complete mutual authentication. By default, the first authenticated
 * server identity is trusted for this client instance; callers can instead supply
 * `serverIdentityKey` as an independently validated pin. The distinct storage-provider
 * identity advertised by the authenticated `makeAvailable` response is authoritative
 * by default; callers can independently pin it with `storageIdentityKey`.
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
  protected rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    return this.traceRpcCall(method, params, async rpcSpan => {
      const id = this.nextRequestId()
      const body = {
        jsonrpc: '2.0',
        method,
        params,
        id
      }

      const requestUsesBinary = this.requestUsesBinary(method)
      const requestBody = await this.traceRpcStep(
        'wallet.storage.request.serialize',
        rpcSpan,
        () => stringifyJsonRpc(body, requestUsesBinary),
        { 'rpc.encoding': requestUsesBinary ? 'binary-json' : 'json' }
      )
      const response = await this.traceRpcStep(
        'wallet.storage.http',
        rpcSpan,
        () =>
          this.authenticatedFetch(this.endpointUrl, {
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
        throw this.rpcResponseError(response)
      }

      const responseUsesBinary = response.headers.get(BINARY_ENCODING_HEADER) === BINARY_ENCODING
      if (responseUsesBinary) this.serverSupportsBinary = true
      const responseText = await this.traceRpcStep('wallet.storage.response.read', rpcSpan, () => response.text(), {
        'http.response.status_code': response.status,
        'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json'
      })
      const json = await this.traceRpcStep(
        'wallet.storage.response.parse',
        rpcSpan,
        () => validateJsonRpcResponse(parseJsonRpc(responseText, responseUsesBinary), id),
        {
          'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json',
          'response.size_bytes': responseText.length
        }
      )
      if ('error' in json) {
        throw WalletErrorFromJson(json.error as object)
      }

      rpcSpan?.end({
        attributes: {
          'http.response.status_code': response.status,
          'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json'
        }
      })
      return json.result as T
    })
  }
}
