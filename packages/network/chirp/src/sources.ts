import { CHIRPError } from './errors.js'
import type { CHIRPByteSource } from './types.js'

export async function* toAsyncBytes(source: CHIRPByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    if (source.byteLength > 0) yield source
    return
  }
  if (Array.isArray(source)) {
    const bytes = Uint8Array.from(source)
    if (bytes.byteLength > 0) yield bytes
    return
  }
  if (isBlob(source)) {
    yield* readableStreamBytes(source.stream())
    return
  }
  if (isReadableStream(source)) {
    yield* readableStreamBytes(source)
    return
  }
  if (isAsyncIterable(source)) {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'CHIRP sources must yield Uint8Array chunks.')
      }
      if (chunk.byteLength > 0) yield chunk
    }
    return
  }
  throw new CHIRPError('ERR_CHIRP_SOURCE', 'Unsupported CHIRP byte source.')
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value
}

async function* readableStreamBytes(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (!(result.value instanceof Uint8Array)) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'ReadableStream must yield Uint8Array chunks.')
      }
      if (result.value.byteLength > 0) yield result.value
    }
  } finally {
    reader.releaseLock()
  }
}
