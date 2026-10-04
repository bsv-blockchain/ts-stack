import { chmod, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { runInSeries } from '../../utility/runInSeries'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import type { Brc39StreamQuarantine } from './Brc39StreamNode'

type Consume<T> = (chunks: AsyncIterable<Uint8Array>) => Promise<T>
export interface Brc39NodeFilePolicy {
  maximumFileBytes: number
  maximumChunkBytes: number
  signal?: AbortSignal
}
export interface Brc39NodeFileQuarantine extends Brc39StreamQuarantine {
  /** Only available after the authenticated semantic validator completes.
   * The callback owns one bounded reader; its settlement closes that reader,
   * including early completion. This method does not import or activate data. */
  withAuthenticatedChunks: <T>(consume: Consume<T>) => Promise<T>
}
type State = 'writing' | 'validating' | 'validated' | 'failed' | 'discarding' | 'discarded'

function combined(original: unknown, cleanup: unknown): AggregateError {
  return new AggregateError([original, cleanup], 'Private quarantine operation and cleanup failed', {
    cause: original
  })
}

class PrivateFile {
  private state: State = 'writing'
  private bytes = 0
  private busy = false
  private active: Promise<void> = Promise.resolve()
  private discarded?: Promise<void>
  private writer?: FileHandle
  private reader?: FileHandle
  private readonly digest = createHash('sha256')

  constructor(
    private readonly directory: string,
    private readonly filename: string,
    writer: FileHandle,
    private readonly policy: Readonly<Brc39NodeFilePolicy>,
    private readonly validate: Consume<void>
  ) {
    this.writer = writer
  }

  private check(): void {
    this.policy.signal?.throwIfAborted()
  }

  private checkNotDiscarded(): void {
    if (this.state === 'discarding') throw new Error('Private quarantine was discarded during validation')
  }

  private own<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) return Promise.reject(new Error('Private quarantine already owns an operation'))
    if (this.state === 'failed' || this.state === 'discarding' || this.state === 'discarded')
      return Promise.reject(new Error('Private quarantine is closed'))
    this.busy = true
    const result = action()
      .catch(error => {
        if (this.state !== 'discarding') this.state = 'failed'
        throw error
      })
      .finally(() => {
        this.busy = false
      })
    // Cleanup waits for settlement without changing the caller's exact result.
    this.active = result.then(
      () => {},
      () => {}
    )
    return result
  }

  appendUntrusted(input: Uint8Array): Promise<void> {
    if (this.state !== 'writing') return Promise.reject(new Error('Private quarantine is not writable'))
    if (!(input instanceof Uint8Array)) return Promise.reject(new TypeError('Private quarantine requires bytes'))
    if (input.length > this.policy.maximumChunkBytes || input.length > this.policy.maximumFileBytes - this.bytes)
      return Promise.reject(new SnapshotResourceLimitError('Private quarantine exceeds the selected byte policy'))
    if (this.busy) return Promise.reject(new Error('Private quarantine already owns an operation'))
    // Detach before asynchronous ownership. Concurrent calls refuse rather than
    // retaining an unbounded queue of detached buffers.
    const bytes = input.slice()
    return this.own(async () => {
      this.check()
      const writer = this.writer
      if (writer === undefined) throw new Error('Private quarantine writer is closed')
      const write = (bytes: Uint8Array, offset: number) => writer.write(bytes, offset, bytes.length - offset, null)
      let offset = 0
      const check = () => this.check()
      async function* writes() {
        while (offset < bytes.length) {
          check()
          yield write(bytes, offset)
        }
      }
      for await (const { bytesWritten } of writes()) {
        if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > bytes.length - offset)
          throw new Error('Private quarantine write made invalid progress')
        this.digest.update(bytes.subarray(offset, offset + bytesWritten))
        offset += bytesWritten
        this.bytes += bytesWritten
        this.check()
      }
    })
  }

  private async consume<T>(callback: Consume<T>, requireComplete: boolean): Promise<T> {
    this.check()
    const reader = await open(this.filename, 'r')
    this.reader = reader
    let offset = 0
    let complete = false
    const size = this.bytes
    const expectedDigest = this.digest.copy().digest()
    const actualDigest = createHash('sha256')
    const maximum = this.policy.maximumChunkBytes
    const check = () => this.check()
    async function* reads() {
      while (offset < size) {
        check()
        const bytes = new Uint8Array(Math.min(maximum, size - offset))
        yield reader.read(bytes, 0, bytes.length, offset)
      }
    }
    async function* chunks() {
      for await (const { buffer, bytesRead } of reads()) {
        if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > buffer.length)
          throw new Error('Private quarantine read made invalid progress')
        offset += bytesRead
        check()
        actualDigest.update(buffer.subarray(0, bytesRead))
        yield bytesRead === buffer.length ? buffer : buffer.slice(0, bytesRead)
      }
      if ((await reader.stat()).size !== size) throw new Error('Private quarantine size changed')
      if (!timingSafeEqual(actualDigest.digest(), expectedDigest)) throw new Error('Private quarantine bytes changed')
      complete = true
    }
    const iterator = chunks()
    let failure: { error: unknown } | undefined
    let result: T | undefined
    try {
      if ((await reader.stat()).size !== size) throw new Error('Private quarantine size changed')
      result = await callback(iterator)
      this.check()
      if (requireComplete && !complete)
        throw new Error('Private quarantine validator did not consume the complete file')
    } catch (error) {
      failure = { error }
    }
    await runInSeries(
      [
        async () => {
          await iterator.return(undefined)
        },
        async () => {
          await reader.close()
          this.reader = undefined
        }
      ],
      async close => {
        try {
          await close()
        } catch (cleanup) {
          failure = { error: failure === undefined ? cleanup : combined(failure.error, cleanup) }
        }
      }
    )
    if (failure !== undefined) throw failure.error
    return result as T
  }

  validateAuthenticated(): Promise<void> {
    if (this.state !== 'writing') return Promise.reject(new Error('Private quarantine cannot be validated again'))
    return this.own(async () => {
      this.check()
      const writer = this.writer
      if (writer === undefined) throw new Error('Private quarantine writer is closed')
      if (this.bytes === 0) throw new TypeError('Private quarantine is empty')
      if ((await writer.stat()).size !== this.bytes) throw new Error('Private quarantine size changed')
      await writer.sync()
      this.check()
      await writer.close()
      this.writer = undefined
      this.checkNotDiscarded()
      this.state = 'validating'
      await this.consume(this.validate, true)
      this.checkNotDiscarded()
      this.state = 'validated'
    })
  }

  withAuthenticatedChunks<T>(consume: Consume<T>): Promise<T> {
    if (this.state !== 'validated') return Promise.reject(new Error('Private quarantine has not been validated'))
    return this.own(async () => this.consume(consume, false))
  }

  discard(): Promise<void> {
    if (this.discarded !== undefined) return this.discarded
    this.state = 'discarding'
    const release = async (): Promise<void> => {
      const errors: unknown[] = []
      await runInSeries(['writer', 'reader'] as const, async kind => {
        const handle = this[kind]
        if (handle === undefined) return
        try {
          await handle.close()
          this[kind] = undefined
        } catch (error) {
          errors.push(error)
        }
      })
      try {
        await rm(this.directory, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Private quarantine cleanup failed')
      this.state = 'discarded'
    }
    this.discarded = this.active.then(release).catch(error => {
      this.discarded = undefined
      this.state = 'failed'
      throw error
    })
    return this.discarded
  }
}

/** Node-only private file quarantine. The parent is a trusted,
 * caller-owned directory, not an untrusted path or shared upload root. Only
 * the crypto pipeline may invoke validateAuthenticated after GCM completion;
 * the supplied validator must independently validate strict UTF8 and complete
 * BRC-38 semantics with bounded reads/storage. No path or provisional reader
 * is exposed. Private 0700/0600 staging, fsync and cleanup do not constitute a
 * durable import, crash-recovery transaction or activation authorization. */
export async function createBrc39NodeFileQuarantine(
  parent: string,
  validate: Consume<void>,
  options: Brc39NodeFilePolicy
): Promise<Brc39NodeFileQuarantine> {
  if (!Number.isSafeInteger(options.maximumFileBytes) || options.maximumFileBytes < 1)
    throw new RangeError('maximumFileBytes must be a positive safe integer')
  if (
    !Number.isSafeInteger(options.maximumChunkBytes) ||
    options.maximumChunkBytes < 1 ||
    options.maximumChunkBytes > 65536
  )
    throw new RangeError('maximumChunkBytes must be an integer from 1 to 65536')
  const policy = Object.freeze({ ...options })
  policy.signal?.throwIfAborted()
  const directory = await mkdtemp(join(parent, 'brc39-stage-'))
  let stage: PrivateFile | undefined
  try {
    await chmod(directory, 0o700)
    policy.signal?.throwIfAborted()
    const filename = join(directory, 'quarantine')
    const writer = await open(filename, 'wx+', 0o600)
    const owned = new PrivateFile(directory, filename, writer, policy, validate)
    stage = owned
    policy.signal?.throwIfAborted()
    const result: Brc39NodeFileQuarantine = {
      appendUntrusted: bytes => owned.appendUntrusted(bytes),
      validateAuthenticated: () => owned.validateAuthenticated(),
      withAuthenticatedChunks: consume => owned.withAuthenticatedChunks(consume),
      discard: () => owned.discard()
    }
    return Object.freeze(result)
  } catch (error) {
    try {
      if (stage === undefined) await rm(directory, { recursive: true, force: true })
      else await stage.discard()
    } catch (cleanup) {
      throw combined(error, cleanup)
    }
    throw error
  }
}
