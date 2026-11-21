import { mapAwaitFromSync } from '../../utility/promiseFromSync'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

const typedPrototype: object = Object.getPrototypeOf(Uint8Array.prototype)
const lengthGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')!.get!
const bufferGetter = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')!.get!
const tagGetter = Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)!.get!
const backingGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!
const copy = Uint8Array.prototype.set

/** Native extent checks precede allocation. Shared backing and non-byte views
 * refuse without consulting caller-controlled length/buffer/slice properties. */
export function detachBrc38PrivateChunk(input: Uint8Array, maximum: number): Uint8Array {
  if (Reflect.apply(tagGetter, input, []) !== 'Uint8Array')
    throw new TypeError('Private staging requires an ordinary native byte view')
  Reflect.apply(backingGetter, Reflect.apply(bufferGetter, input, []), [])
  const size = Reflect.apply(lengthGetter, input, []) as number
  if (size > maximum) throw new SnapshotResourceLimitError('Private staging chunk policy reached')
  const bytes = new Uint8Array(size)
  Reflect.apply(copy, bytes, [input])
  return bytes
}

function notification() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
function acceptance() {
  let resolve!: () => void, reject!: (cause: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
interface PrivateChunkSlot {
  bytes: Uint8Array
  accepted: ReturnType<typeof acceptance>
}

/** One producer and one private reader, with no unbounded queue. A write
 * settles only when the reader advances past its detached chunk. Consume or
 * detach yielded bytes before advancing; owned bytes are then erased. The parser
 * alone consumes this plaintext; nothing here authenticates or activates it. */
export class Brc38PrivateChunkPipe implements AsyncIterable<Uint8Array> {
  #state: 'open' | 'ended' | 'failed' = 'open'
  #failure: { cause: unknown } | undefined
  #claimed = false
  #writing = false
  #available = notification()
  #slot: PrivateChunkSlot | undefined
  #inFlight: ReturnType<typeof acceptance> | undefined
  constructor(readonly maximumChunkBytes: number) {
    if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 1 || maximumChunkBytes > 65536)
      throw new RangeError('Private chunk limit must be an integer from 1 to 65536')
  }
  #open(): void {
    if (this.#failure !== undefined) throw this.#failure.cause
    if (this.#state !== 'open') throw new Error('Private staging pipe is ended')
  }
  async append(input: Uint8Array): Promise<void> {
    this.#open()
    if (this.#writing) throw new Error('Private staging pipe already owns a write')
    const bytes = detachBrc38PrivateChunk(input, this.maximumChunkBytes)
    this.#writing = true
    const accepted = acceptance()
    this.#inFlight = accepted
    this.#slot = { bytes, accepted }
    this.#available.resolve()
    try {
      await accepted.promise
      if (this.#failure !== undefined) throw this.#failure.cause
    } finally {
      bytes.fill(0)
      this.#writing = false
      this.#inFlight = undefined
    }
  }
  end(): void {
    this.#open()
    if (this.#writing || this.#slot !== undefined)
      throw new Error('Await private staging write settlement before ending')
    this.#state = 'ended'
    this.#available.resolve()
  }
  fail(cause: unknown): void {
    if (this.#failure !== undefined) return
    this.#failure = { cause }
    this.#state = 'failed'
    this.#slot?.bytes.fill(0)
    this.#slot = undefined
    this.#inFlight?.reject(cause)
    this.#available.resolve()
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.#claimed) throw new Error('Private staging pipe reader is already owned')
    this.#claimed = true
    return this.#read()
  }
  #nextSlot(): Promise<PrivateChunkSlot | undefined> {
    return mapAwaitFromSync(
      () => this.#available.promise,
      () => {
        if (this.#failure !== undefined) throw this.#failure.cause
        const slot = this.#slot
        if (slot !== undefined) {
          this.#slot = undefined
          this.#available = notification()
        }
        return slot
      }
    )
  }
  async *#slots() {
    while (true) yield this.#nextSlot()
  }
  async *#read(): AsyncGenerator<Uint8Array> {
    try {
      for await (const slot of this.#slots()) {
        if (slot === undefined) return
        let advanced = false
        try {
          yield slot.bytes
          advanced = true
        } finally {
          slot.bytes.fill(0)
          if (advanced) slot.accepted.resolve()
          else this.fail(new Error('Private staging reader stopped before authentication'))
        }
      }
    } finally {
      if (this.#state === 'open') this.fail(new Error('Private staging reader stopped before authentication'))
    }
  }
}
