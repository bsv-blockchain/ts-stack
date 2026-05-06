import {
  WalletInterface,
  WalletLoggerInterface
} from '@bsv/sdk'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { logWalletError } from '../../WalletLogger'
import { StorageClientBase } from './StorageClientBase'

/**
 * `StorageClient` implements the `WalletStorageProvider` interface which allows it to
 * serve as a BRC-100 wallet's active storage.
 *
 * Internally, it uses JSON-RPC over HTTPS to make requests of a remote server.
 * Typically this server uses the `StorageServer` class to implement the service.
 *
 * The `AuthFetch` component is used to secure and authenticate the requests to the remote server.
 *
 * `AuthFetch` is initialized with a BRC-100 wallet which establishes the identity of
 * the party making requests of the remote service.
 *
 * For details of the API implemented, follow the "See also" link for the `WalletStorageProvider` interface.
 */
export class StorageClient extends StorageClientBase {
  constructor (wallet: WalletInterface, endpointUrl: string) {
    super(wallet, endpointUrl)
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
    const logger: WalletLoggerInterface | undefined = params[1]?.['logger']

    try {
      const id = this.nextId++

      if (logger != null) {
        // Replace logger object with seed json object to continue logging on request server.
        logger.group(`StorageClient ${method}`)
        params[1]!['logger'] = { indent: logger.indent || 0 }
      }

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
      } catch (error_: unknown) {
        logWalletError(error_, logger, 'error requesting remote service')
        throw error_
      }

      if (!response.ok) {
        throw new Error(`WalletStorageClient rpcCall: network error ${response.status} ${response.statusText}`)
      }

      const json = await response.json()
      if (json.error) {
        logWalletError(json.error, logger, 'error from remote service')
        const werr = WalletErrorFromJson(json.error)
        throw werr
      }

      if (logger != null) {
        // merge log data from request processing
        logger.merge?.(json.result?.log)
        logger.groupEnd()
      }

      return json.result
    } catch (error_: unknown) {
      logWalletError(error_, logger, 'error setting up request to remote service')
      throw error_
    } finally {
      if (logger != null) {
        // Restore original logger in params
        params[1]!['logger'] = logger
      }
    }
  }
}
