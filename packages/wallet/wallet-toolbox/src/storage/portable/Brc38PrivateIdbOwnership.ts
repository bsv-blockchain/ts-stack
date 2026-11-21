import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

const issuer = Object.freeze({}),
  owners = new WeakSet<Brc38PrivateIdbOwnership>()
/** Actual browser lock callback ownership, not a cached schema/source verdict.
 * Reference lifecycle: https://www.w3.org/TR/web-locks/#termination-of-locks */
export class Brc38PrivateIdbOwnership {
  #held = false
  #release?: () => void
  #completion?: Promise<void>
  #failure?: unknown
  readonly #name: string
  private constructor(token: object, name: string) {
    if (token !== issuer) throw new Error('Private browser ownership requires its actual factory')
    this.#name = name
    owners.add(this)
  }
  static async acquire(
    databaseName: string,
    expiresAt: number,
    signal?: AbortSignal
  ): Promise<Brc38PrivateIdbOwnership> {
    if (
      !/^(wallet-toolbox-brc38-private-v1-|wallet-toolbox-(main|test)net-restore-v1-)[0-9a-f]{32}$/.test(
        databaseName
      ) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now()
    )
      throw new RangeError('Invalid browser owner scope')
    if (
      typeof LockManager === 'undefined' ||
      typeof Lock === 'undefined' ||
      typeof navigator === 'undefined' ||
      navigator.locks === undefined
    )
      throw new Error('Private IndexedDB import requires actual browser Web Locks')
    signal?.throwIfAborted()
    const owner = new Brc38PrivateIdbOwnership(issuer, 'brc38-private/' + databaseName),
      began = performance.now(),
      lifetime = Math.min(30000, expiresAt - Date.now()),
      request = LockManager.prototype.request,
      name = Object.getOwnPropertyDescriptor(Lock.prototype, 'name')?.get,
      mode = Object.getOwnPropertyDescriptor(Lock.prototype, 'mode')?.get
    if (name === undefined || mode === undefined) throw new Error('Private browser lock intrinsics unavailable')
    let accept!: () => void,
      reject!: (cause: unknown) => void,
      abandoned = false,
      timer: ReturnType<typeof setTimeout> | undefined
    const granted = new Promise<void>((resolve, failure) => {
      accept = resolve
      reject = failure
    })
    owner.#completion = request
      .call(navigator.locks, owner.#name, { mode: 'exclusive', ifAvailable: true }, async (lock: Lock | null) => {
        if (lock === null) {
          reject(new Error('Private browser source already has an owner'))
          return
        }
        if (name.call(lock) !== owner.#name || mode.call(lock) !== 'exclusive') {
          reject(new Error('Actual private browser lock scope differs'))
          return
        }
        if (abandoned || signal?.aborted || Date.now() >= expiresAt || performance.now() - began >= lifetime) {
          reject(
            signal?.aborted
              ? signal.reason
              : new SnapshotResourceLimitError('Private browser owner acquisition expired')
          )
          return
        }
        owner.#held = true
        const held = new Promise<void>(resolve => {
          owner.#release = resolve
        })
        accept()
        try {
          await held
        } finally {
          owner.#held = false
        }
      })
      .then(
        () => undefined,
        cause => {
          owner.#held = false
          owner.#failure = cause
          reject(cause)
        }
      )
    try {
      await Promise.race([
        granted,
        new Promise<never>((_resolve, failure) => {
          timer = setTimeout(() => {
            abandoned = true
            failure(new SnapshotResourceLimitError('Private browser ownership acquisition deadline reached'))
          }, lifetime)
        })
      ])
      signal?.throwIfAborted()
      owner.assertOwned()
      return owner
    } catch (cause) {
      abandoned = true
      try {
        await owner.release()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'Private browser owner acquisition retains lock cleanup',
          () => owner.release()
        )
      }
      throw cause
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  assertOwned(): void {
    if (!owners.has(this) || !this.#held || this.#completion === undefined || this.#failure !== undefined)
      throw new Error('Actual private browser lock ownership ended')
  }
  async release(): Promise<void> {
    this.#release?.()
    this.#held = false
    const completion = this.#completion
    if (completion === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        completion,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Private browser lock release still pending')), 30000)
        })
      ])
    } catch (cause) {
      throw new Brc38StagingCleanupError([cause], 'Private browser retains actual lock release', () => this.release())
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
