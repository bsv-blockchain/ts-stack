const BufferCtor = (globalThis as any).Buffer
const BufferCompare =
  typeof BufferCtor?.compare === 'function'
    ? (BufferCtor.compare as (first: Uint8Array, second: Uint8Array) => number)
    : undefined
const SharedArrayBufferCtor = (globalThis as any).SharedArrayBuffer
const maximumCachedBytes = 16 * 1024 * 1024

/** A one-entry cache that reuses a result only after an exact native byte comparison. */
export default class ExactByteCache<T> {
  private cached?: { bytes: Uint8Array; value: T }

  get(bytes: number[] | Uint8Array): T | undefined {
    const cached = this.cached
    if (
      cached == null ||
      !(bytes instanceof Uint8Array) ||
      bytes.length !== cached.bytes.length ||
      BufferCompare == null ||
      (SharedArrayBufferCtor != null && bytes.buffer instanceof SharedArrayBufferCtor) ||
      BufferCompare(bytes, cached.bytes) !== 0
    ) {
      return undefined
    }
    return cached.value
  }

  set(bytes: number[] | Uint8Array, value: T): void {
    if (
      bytes instanceof Uint8Array &&
      bytes.length <= maximumCachedBytes &&
      BufferCompare != null &&
      !(SharedArrayBufferCtor != null && bytes.buffer instanceof SharedArrayBufferCtor)
    ) {
      this.cached = { bytes: new Uint8Array(bytes), value }
    }
  }
}
