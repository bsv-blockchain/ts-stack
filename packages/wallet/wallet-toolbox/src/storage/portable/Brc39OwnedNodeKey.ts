import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { toArray } from '@bsv/sdk/primitives/utils'
import { readyArgon2idBackend } from '../../utility/Argon2idBackend'
import type { Brc39StreamHeader } from './Brc39Frame'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Admission remains occupied until actual worker exit/backend settlement.
 * Refusing concurrent KDFs bounds portable WASM allocation to one selected
 * memory parameter per loaded module instance. V8 resourceLimits do not cap WASM memory. */
let occupied = false
async function bounded(pending: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('BRC-39 KDF cleanup deadline ended')),
          milliseconds
        )
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
function eraseAttached(bytes: Uint8Array): void {
  // A successfully transferred ArrayBuffer is already detached in this realm.
  if (bytes.byteLength !== 0) bytes.fill(0)
}
/** Portable Node derivation runs off the main thread. A ready registered host
 * backend remains authoritative, with no fallback on failure. Native promises
 * cannot be terminated: a stalled one retains a concrete cleanup owner.
 * Deadline/abort revokes delivery; cleanup waits for actual exit/settlement. */
export async function deriveBrc39OwnedNodeKey(
  header: Brc39StreamHeader,
  password: string,
  maximumPasswordBytes: number,
  signal?: AbortSignal,
  maximumMilliseconds = 30000
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(maximumPasswordBytes) ||
    maximumPasswordBytes < 1 ||
    maximumPasswordBytes > 65536 ||
    !Number.isSafeInteger(maximumMilliseconds) ||
    maximumMilliseconds < 1 ||
    maximumMilliseconds > 30000
  )
    throw new RangeError('Invalid BRC-39 Node KDF bound')
  for (const [value, maximum] of [
    [header.iterations, 0xffffffff],
    [header.memoryKiB, 0xffffffff],
    [header.parallelism, 255]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new RangeError('Invalid BRC-39 Node KDF parameter')
  }
  if (!(header.salt instanceof Uint8Array) || header.salt.length < 1 || header.salt.length > 255)
    throw new TypeError('Invalid BRC-39 Node KDF salt')
  // Capture every scalar before admitting asynchronous work. A caller cannot
  // retarget a native request by mutating its original header while queued.
  const iterations = header.iterations,
    memoryKiB = header.memoryKiB,
    parallelism = header.parallelism
  signal?.throwIfAborted()
  if (typeof password !== 'string' || password.length > maximumPasswordBytes)
    throw new SnapshotResourceLimitError('BRC-39 password exceeds the selected stream policy')
  const normalized = password.normalize('NFC')
  if (normalized.length > maximumPasswordBytes)
    throw new SnapshotResourceLimitError('BRC-39 normalized password exceeds the selected stream policy')
  const bytes = new Uint8Array(toArray(normalized, 'utf8')),
    salt = new Uint8Array(header.salt)
  let worker: Worker | undefined, terminal: Promise<void> | undefined, key: Uint8Array | undefined
  let backendCleanup: Brc38StagingCleanupError | undefined,
    backendCleanupPending: Promise<void> | undefined,
    backendCleanupFailed = false
  let abandoned = false,
    admitted = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    abort: (() => void) | undefined
  const began = performance.now(),
    deadline = Date.now() + maximumMilliseconds
  const erase = () => {
    eraseAttached(bytes)
    eraseAttached(salt)
    key?.fill(0)
    key = undefined
  }
  const cleanup = async () => {
    abandoned = true
    key?.fill(0)
    key = undefined
    if (worker !== undefined) {
      // A terminate request is not proof of exit. The original exit observer is
      // retained even if termination rejects, so retry can still await drain.
      void worker.terminate().catch(() => {})
    }
    if (terminal !== undefined)
      await bounded(
        terminal.then(
          () => {},
          () => {}
        ),
        30000
      )
    if (backendCleanup !== undefined) {
      if (backendCleanupPending === undefined || backendCleanupFailed) {
        backendCleanupFailed = false
        backendCleanupPending = backendCleanup.retryCleanup().catch(cause => {
          backendCleanupFailed = true
          throw cause
        })
        void backendCleanupPending.catch(() => {})
      }
      await bounded(backendCleanupPending, 30000)
    }
    erase()
    if (admitted) {
      occupied = false
      admitted = false
    }
  }
  try {
    if (bytes.length > maximumPasswordBytes)
      throw new SnapshotResourceLimitError('BRC-39 encoded password exceeds the selected stream policy')
    if (salt.length < 1 || salt.length > 255)
      throw new SnapshotResourceLimitError('BRC-39 salt exceeds the selected stream policy')
    if (occupied) throw new SnapshotResourceLimitError('Another BRC-39 Node derivation retains admission')
    occupied = true
    admitted = true
    const backend = readyArgon2idBackend()
    if (backend !== undefined) {
      terminal = Promise.resolve()
        .then(async () => {
          const result = await backend.deriveKey(
            Object.freeze({ password: bytes, salt, iterations, memorySize: memoryKiB, parallelism, hashLength: 32 })
          )
          if (!(result instanceof Uint8Array)) throw new TypeError('Invalid BRC-39 host key')
          if (result.length !== 32) {
            result.fill(0)
            throw new TypeError('Invalid BRC-39 host key length')
          }
          if (abandoned) result.fill(0)
          else key = result
        })
        .catch(cause => {
          if (cause instanceof Brc38StagingCleanupError) backendCleanup = cause
          throw cause
        })
        .finally(() => {
          eraseAttached(bytes)
          eraseAttached(salt)
        })
    } else {
      worker = new Worker(join(__dirname, 'Brc39Argon2Worker.js'), {
        execArgv: [],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        stdin: false,
        stdout: true,
        stderr: true
      })
      // Worker errors/output contain no password or key and are not logged.
      // Unexpected output is drained with an explicit bound and revokes delivery.
      let output = 0,
        failure: Error | undefined,
        received = false
      const ownWorker = worker
      const rejectOutput = (chunk: Buffer) => {
        output += chunk.byteLength
        if (output > 4096 && failure === undefined) {
          failure = new SnapshotResourceLimitError('BRC-39 KDF worker output bound reached')
          abandoned = true
          key?.fill(0)
          key = undefined
          void ownWorker.terminate().catch(() => {})
        }
      }
      ownWorker.stdout!.on('data', rejectOutput)
      ownWorker.stderr!.on('data', rejectOutput)
      terminal = new Promise<void>((resolve, reject) => {
        ownWorker.on('message', (value: unknown) => {
          if (!(value instanceof ArrayBuffer)) {
            failure = new TypeError('Invalid BRC-39 worker reply')
            return
          }
          const result = new Uint8Array(value)
          if (received || result.length !== 32 || abandoned) {
            result.fill(0)
            if (!abandoned) failure = new TypeError('Invalid BRC-39 worker key delivery')
          } else {
            received = true
            key = result
          }
        })
        ownWorker.once('error', error => {
          failure = error instanceof Error ? error : new Error('BRC-39 KDF worker failed', { cause: error })
        })
        ownWorker.once('exit', code => {
          if (failure !== undefined) reject(failure)
          else if (code !== 0 || !received) reject(new Error('BRC-39 KDF worker did not complete'))
          else resolve()
        })
      })
      ownWorker.postMessage({ password: bytes.buffer, salt: salt.buffer, iterations, memoryKiB, parallelism }, [
        bytes.buffer,
        salt.buffer
      ])
    }
    void terminal.catch(() => {})
    await Promise.race([
      terminal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('BRC-39 KDF deadline ended')),
          maximumMilliseconds
        )
        if (signal !== undefined) {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }
      })
    ])
    signal?.throwIfAborted()
    if (Date.now() >= deadline || performance.now() - began >= maximumMilliseconds || key === undefined)
      throw new SnapshotResourceLimitError('BRC-39 KDF delivery deadline ended')
    const result = key
    key = undefined
    erase()
    occupied = false
    admitted = false
    return result
  } catch (cause) {
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError([cause, error_], 'BRC-39 KDF retains actual worker/backend cleanup', cleanup)
    }
    throw cause
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort !== undefined) signal!.removeEventListener('abort', abort)
  }
}
