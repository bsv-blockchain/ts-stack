import { CHIRPError } from './errors.js'
import type { CHIRPByteSource } from './types.js'

export async function* toAsyncBytes(
  source: CHIRPByteSource,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  throwIfAborted(signal)
  if (source instanceof Uint8Array) {
    if (source.byteLength > 0) yield source
    return
  }
  if (Array.isArray(source)) {
    const values: number[] = []
    for (let index = 0; index < source.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        !Number.isInteger(descriptor.value) ||
        descriptor.value < 0 ||
        descriptor.value > 255
      ) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'CHIRP number arrays must contain only bytes.')
      }
      values.push(descriptor.value as number)
    }
    const bytes = Uint8Array.from(values)
    if (bytes.byteLength > 0) yield bytes
    return
  }
  if (isBlob(source)) {
    yield* readableStreamBytes(source.stream(), signal)
    return
  }
  if (isReadableStream(source)) {
    yield* readableStreamBytes(source, signal)
    return
  }
  if (isAsyncIterable(source)) {
    yield* asyncIterableBytes(source, signal)
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

function iteratorReturnValue(iterator: AsyncIterator<Uint8Array>): unknown {
  const finish = iterator.return
  if (typeof finish !== 'function') return undefined
  return finish.call(iterator)
}

async function* asyncIterableBytes(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  let completed = false
  try {
    while (true) {
      const result = await raceWithSignal(Promise.resolve(iterator.next()), signal)
      if (result == null || typeof result !== 'object') {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'CHIRP iterator returned an invalid result.')
      }
      if (result.done === true) {
        completed = true
        break
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'CHIRP sources must yield Uint8Array chunks.')
      }
      if (result.value.byteLength > 0) yield result.value
    }
  } finally {
    if (!completed && typeof iterator.return === 'function') {
      let returned: unknown
      try {
        returned = iteratorReturnValue(iterator)
      } catch {
        // A hostile or broken iterator cannot block local cancellation cleanup.
        returned = undefined
      }
      void Promise.resolve(returned).catch(() => {})
    }
  }
}

async function* readableStreamBytes(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let completed = false
  try {
    while (true) {
      const result = await raceWithSignal(reader.read(), signal)
      if (result.done) {
        completed = true
        break
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'ReadableStream must yield Uint8Array chunks.')
      }
      if (result.value.byteLength > 0) yield result.value
    }
  } finally {
    if (!completed) void reader.cancel(signal?.reason).catch(() => {})
    try {
      reader.releaseLock()
    } catch {
      // A non-cooperative stream may retain its pending read after cancellation.
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The CHIRP source was aborted.', 'AbortError')
  }
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (signal == null) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The CHIRP source was aborted.', 'AbortError')
      )
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
