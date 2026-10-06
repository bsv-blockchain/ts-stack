import { WalletInterface, WalletLoggerInterface } from '@bsv/sdk'
import { WalletErrorFromJson } from '../../sdk/WalletErrorFromJson'
import { logWalletError } from '../../WalletLogger'
import { StorageClientBase, type StorageClientOptions } from './StorageClientBase'
import {
  BINARY_ENCODING,
  BINARY_ENCODING_HEADER,
  BINARY_REQUEST_ENCODING_HEADER,
  parseJsonRpc,
  stringifyJsonRpc,
  validateJsonRpcResponse
} from './BinaryJson'

interface RpcLoggerState {
  logger?: WalletLoggerInterface
  requestOptions?: Record<string, unknown>
}

const MAX_REMOTE_LOG_ENTRIES = 1000
const MAX_REMOTE_LOG_MESSAGE_LENGTH = 4096

function invalidRemoteLog(): never {
  throw new Error('Wallet storage returned invalid remote log data')
}

function validatedRemoteLog(result: unknown): WalletLoggerInterface | undefined {
  if (result == null || typeof result !== 'object' || Array.isArray(result)) return undefined
  const log = Object.getOwnPropertyDescriptor(result, 'log')
  if (log == null) return undefined
  if (!('value' in log) || log.value == null || typeof log.value !== 'object' || Array.isArray(log.value)) {
    return invalidRemoteLog()
  }
  const logProperties = Object.getOwnPropertyDescriptors(log.value)
  if (
    Object.getOwnPropertySymbols(log.value).length !== 0 ||
    Object.keys(logProperties).some(key => key !== 'logs') ||
    Object.values(logProperties).some(property => property.get != null || property.set != null) ||
    !Array.isArray(logProperties.logs?.value) ||
    logProperties.logs.value.length > MAX_REMOTE_LOG_ENTRIES
  ) {
    return invalidRemoteLog()
  }
  const logs = logProperties.logs.value.map((entry: unknown) => {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return invalidRemoteLog()
    const properties = Object.getOwnPropertyDescriptors(entry)
    const keys = Object.keys(properties)
    const booleanKeys = ['isError', 'isBegin', 'isEnd'] as const
    if (
      Object.getOwnPropertySymbols(entry).length !== 0 ||
      Object.values(properties).some(property => property.get != null || property.set != null) ||
      keys.some(key => !['when', 'indent', 'log', ...booleanKeys].includes(key)) ||
      !Number.isSafeInteger(properties.when?.value) ||
      properties.when.value < 0 ||
      !Number.isSafeInteger(properties.indent?.value) ||
      properties.indent.value < 0 ||
      properties.indent.value > 1000 ||
      typeof properties.log?.value !== 'string' ||
      properties.log.value.length > MAX_REMOTE_LOG_MESSAGE_LENGTH ||
      booleanKeys.some(key => properties[key] != null && typeof properties[key].value !== 'boolean')
    ) {
      return invalidRemoteLog()
    }
    return {
      when: properties.when.value,
      indent: properties.indent.value,
      log: properties.log.value,
      ...Object.fromEntries(booleanKeys.filter(key => properties[key] != null).map(key => [key, properties[key].value]))
    }
  })
  return { logs } as WalletLoggerInterface
}

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
 * the party making requests of the remote service. Responses must complete mutual
 * authentication. By default, the first authenticated server identity is trusted for
 * this client instance; callers can instead supply `serverIdentityKey` as an
 * independently validated pin. The distinct storage-provider identity advertised by
 * the authenticated `makeAvailable` response is authoritative by default; callers
 * can independently pin it with `storageIdentityKey`.
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
      const loggerState = this.startRpcLogging(method, params)
      const { logger } = loggerState

      try {
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

        let response: Response
        try {
          response = await this.traceRpcStep(
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
        } catch (error_: unknown) {
          logWalletError(error_, logger, 'error requesting remote service')
          throw error_
        }

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
          logWalletError(json.error, logger, 'error from remote service')
          const werr = WalletErrorFromJson(json.error as object)
          throw werr
        }

        if (logger != null) {
          // merge log data from request processing
          const remoteLog = validatedRemoteLog(json.result)
          if (remoteLog != null) logger.merge?.(remoteLog)
          logger.groupEnd()
        }

        rpcSpan?.end({
          attributes: {
            'http.response.status_code': response.status,
            'rpc.encoding': responseUsesBinary ? 'binary-json' : 'json'
          }
        })
        return json.result as T
      } catch (error_: unknown) {
        logWalletError(error_, logger, 'error setting up request to remote service')
        throw error_
      } finally {
        this.restoreRpcLogging(loggerState)
      }
    })
  }

  private startRpcLogging(method: string, params: unknown[]): RpcLoggerState {
    const requestOptions =
      typeof params[1] === 'object' && params[1] !== null ? (params[1] as Record<string, unknown>) : undefined
    const logger = requestOptions?.logger as WalletLoggerInterface | undefined
    if (logger != null && requestOptions != null) {
      // Replace logger object with seed json object to continue logging on request server.
      logger.group(`StorageClient ${method}`)
      requestOptions.logger = { indent: logger.indent || 0 }
    }
    return { logger, requestOptions }
  }

  private restoreRpcLogging({ logger, requestOptions }: RpcLoggerState): void {
    if (logger != null && requestOptions != null) {
      // Restore original logger in params
      requestOptions.logger = logger
    }
  }
}
