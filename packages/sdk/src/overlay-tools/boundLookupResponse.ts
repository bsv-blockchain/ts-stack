import { LookupValidationError } from './ReliableLookup.js'

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Bound actual streamed wire bytes before JSON or BEEF parsing. */
export async function boundLookupResponse(
  response: Response,
  signal?: AbortSignal
): Promise<Response> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new LookupValidationError('malformed')
  }
  const reader = response.body?.getReader()
  // Custom fetch implementations may expose parsed bodies only; their author owns byte limits.
  if (reader === undefined) return response
  const chunks: Uint8Array[] = []
  let length = 0
  const abort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      if (signal?.aborted === true) throw new Error('Lookup aborted')
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
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
  }
}
