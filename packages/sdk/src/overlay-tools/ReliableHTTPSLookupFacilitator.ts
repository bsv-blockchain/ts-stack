import {
  HTTPSOverlayLookupFacilitator,
  type LookupQuestion,
  type LookupFacilitatorAnswer
} from './LookupResolver.js'
import { withinDeadline, LookupValidationError } from './ReliableLookup.js'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Bound untrusted wire bytes before JSON or BEEF parsing in the optional adapter. */
export default class ReliableHTTPSLookupFacilitator extends HTTPSOverlayLookupFacilitator {
  constructor(httpClient: typeof fetch = globalThis.fetch.bind(globalThis), allowHTTP = false) {
    super(async (input, init) => {
      const response = await httpClient(input, init)
      if (!response.ok) return response
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel()
        throw new LookupValidationError('malformed')
      }
      const reader = response.body?.getReader()
      if (reader === undefined) throw new LookupValidationError('malformed')
      const chunks: Uint8Array[] = []
      let length = 0
      const abort = (): void => {
        void reader.cancel().catch(() => {})
      }
      init?.signal?.addEventListener('abort', abort, { once: true })
      try {
        while (true) {
          if (init?.signal?.aborted === true) throw new Error('Lookup aborted')
          const { value, done } = await reader.read()
          if (done) break
          length += value.byteLength
          if (length > MAX_RESPONSE_BYTES) throw new LookupValidationError('malformed')
          chunks.push(value)
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        return new Response(bytes, { status: response.status, headers: response.headers })
      } finally {
        init?.signal?.removeEventListener('abort', abort)
        await reader.cancel().catch(() => {})
      }
    }, allowHTTP)
  }
  override async lookup(
    url: string,
    question: LookupQuestion,
    timeout = 2000,
    signal?: AbortSignal
  ): Promise<LookupFacilitatorAnswer> {
    if (!url.startsWith('https:') && !this.allowHTTP) throw new Error('HTTPS required')
    return await withinDeadline(
      async child => await this.performLookupRequest(url, question, child),
      timeout,
      signal
    )
  }
}
