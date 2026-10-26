import { HttpClientRequestOptions, HttpClientResponse } from './HttpClient.js'
import {
  DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_CLIENT_TIMEOUT_MS
} from './HttpClientResponseUtils.js'
import { utf8Bytes } from '../../primitives/UTF8.js'

/** Common interface for Node.js https module request objects */
export interface NodejsRequestLike {
  write: (chunk: any) => void
  on: (event: string, callback: (data: any) => void) => void
  end: () => void
  destroy?: (error?: Error) => void
  setTimeout?: (milliseconds: number, callback: () => void) => unknown
}

/** Common interface for Node.js https modules */
export interface HttpsModuleLike {
  request: (
    url: string,
    options: HttpClientRequestOptions,
    callback: (res: any) => void
  ) => NodejsRequestLike
}

/**
 * Shared implementation for handling Node.js HTTP requests.
 * Used by both NodejsHttpClient and BinaryNodejsHttpClient.
 *
 * @param https The Node.js https module (or compatible)
 * @param url The URL to make the request to
 * @param requestOptions The request configuration
 * @param serializeData Function to serialize the request data for writing
 */
export function executeNodejsRequest(
  https: HttpsModuleLike,
  url: string,
  requestOptions: HttpClientRequestOptions,
  serializeData: (data: any) => any
): Promise<HttpClientResponse> {
  return new Promise((resolve, reject) => {
    let serialized: unknown
    try {
      serialized =
        requestOptions.data === null || requestOptions.data === undefined
          ? undefined
          : serializeData(requestOptions.data)
    } catch (error) {
      reject(error)
      return
    }
    const { data: _data, ...nodeOptions } = requestOptions
    let settled = false
    let req: NodejsRequestLike
    let deadline: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (deadline !== undefined) clearTimeout(deadline)
      requestOptions.signal?.removeEventListener('abort', abort)
    }
    const rejectOnce = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const resolveOnce = (response: HttpClientResponse): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    const abort = (): void => {
      const reason =
        requestOptions.signal?.reason instanceof Error
          ? requestOptions.signal.reason
          : new DOMException('HTTP request aborted', 'AbortError')
      req?.destroy?.(reason)
      rejectOnce(reason)
    }

    req = https.request(url, nodeOptions, res => {
      const declared = res.headers?.['content-length']
      const declaredLength = typeof declared === 'string' ? Number(declared) : undefined
      if (
        (typeof declared === 'string' && !/^(0|[1-9]\d*)$/.test(declared)) ||
        (declaredLength !== undefined &&
          (!Number.isSafeInteger(declaredLength) ||
            declaredLength > DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES))
      ) {
        res.destroy?.()
        rejectOnce(new Error('HTTP response exceeds the configured size limit'))
        return
      }
      const chunks: Uint8Array[] = []
      let length = 0
      res.on('data', (chunk: string | Uint8Array) => {
        if (settled) return
        const bytes = typeof chunk === 'string' ? utf8Bytes(chunk) : new Uint8Array(chunk)
        length += bytes.byteLength
        if (!Number.isSafeInteger(length) || length > DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES) {
          res.destroy?.()
          req.destroy?.()
          rejectOnce(new Error('HTTP response exceeds the configured size limit'))
          return
        }
        chunks.push(bytes)
      })
      res.on('end', () => {
        if (settled) return
        try {
          if (declaredLength !== undefined && declaredLength !== length) {
            throw new Error('HTTP response differs from its declared length')
          }
          if (!Number.isInteger(res.statusCode) || res.statusCode < 100 || res.statusCode > 599) {
            throw new Error('HTTP response returned an invalid status code')
          }
          const bytes = new Uint8Array(length)
          let offset = 0
          for (const chunk of chunks) {
            bytes.set(chunk, offset)
            offset += chunk.byteLength
          }
          const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          const ok = res.statusCode >= 200 && res.statusCode <= 299
          const mediaType = res.headers['content-type']
          const responseData =
            body !== '' && typeof mediaType === 'string' && mediaType.startsWith('application/json')
              ? JSON.parse(body)
              : body
          resolveOnce({
            status: res.statusCode,
            statusText: res.statusMessage ?? '',
            ok,
            data: responseData
          } as HttpClientResponse)
        } catch (error) {
          rejectOnce(error)
        }
      })
      res.on('error', rejectOnce)
      res.on('aborted', () => rejectOnce(new Error('HTTP response was aborted')))
    })

    req.on('error', rejectOnce)
    if (!settled) {
      deadline = setTimeout(() => {
        const error = new Error('HTTP request timed out')
        req.destroy?.(error)
        rejectOnce(error)
      }, DEFAULT_HTTP_CLIENT_TIMEOUT_MS)
    }
    req.setTimeout?.(DEFAULT_HTTP_CLIENT_TIMEOUT_MS, () => {
      const error = new Error('HTTP request timed out')
      req.destroy?.(error)
      rejectOnce(error)
    })
    if (requestOptions.signal?.aborted === true) abort()
    else requestOptions.signal?.addEventListener('abort', abort, { once: true })

    if (settled) return
    if (serialized !== undefined) req.write(serialized)
    req.end()
  })
}
