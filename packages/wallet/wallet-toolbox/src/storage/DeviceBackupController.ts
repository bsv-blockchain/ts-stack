import { mapAwaitFromSync } from '../utility/promiseFromSync'
import type { WalletStorageProvider } from '../sdk/WalletStorage.interfaces'
import type { Chain } from '../sdk/types'
import type { WalletStorageManager } from './WalletStorageManager'
import type { SyncSessionOptions, SyncSessionResult } from './sync/syncSession'
import { Brc38StagingCleanupError } from './portable/Brc38StagingCleanupError'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'

/** Device data only. Destination IDs are host catalog references, never tokens,
 * keys, paths, provider instances, primary selections or recovery checkpoints. */
export interface DeviceBackupPreferences {
  readonly version: 1
  readonly automaticSync: boolean
  readonly backupDestinations: readonly string[]
}
export interface DeviceBackupPreferenceStore {
  read: () => Promise<unknown>
  /** Atomically replace this device preference record. Do not reset wallet data. */
  write: (preferences: DeviceBackupPreferences) => Promise<void>
}
export interface DeviceBackupProfile {
  readonly profileId: string
  readonly identityKey: string
  readonly chain: Chain
  readonly manager: WalletStorageManager
  /** Resolve through this profile's authenticated host catalog. Each call must
   * return a newly owned provider; no shared authentication or database binding. */
  readonly openDestination: (destinationId: string, signal: AbortSignal) => Promise<WalletStorageProvider>
  /** Close only the provider returned by openDestination, including pending I/O. */
  readonly closeDestination: (provider: WalletStorageProvider) => Promise<void>
}
export interface DeviceBackupRunOptions extends Pick<
  SyncSessionOptions,
  'maxItems' | 'maxRoughSize' | 'snapshotLifetimeMs'
> {
  signal?: AbortSignal
  onProgress?: (
    profileId: string,
    destinationId: string,
    progress: Parameters<NonNullable<SyncSessionOptions['onProgress']>>[0]
  ) => void
  onJournalProgress?: (
    profileId: string,
    destinationId: string,
    progress: Parameters<NonNullable<SyncSessionOptions['onJournalProgress']>>[0]
  ) => void
}
export interface DeviceBackupResult {
  readonly profileId: string
  readonly destinationId: string
  readonly result: SyncSessionResult
}
async function lifecycleDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const began = performance.now(),
    deadline = Date.now() + 30000
  try {
    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SnapshotResourceLimitError('Device backup host lifecycle deadline ended')),
          30000
        )
      })
    ])
    if (Date.now() >= deadline || performance.now() - began >= 30000)
      throw new SnapshotResourceLimitError('Device backup host lifecycle delivery deadline ended')
    return result
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
function catalogId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  )
    throw new TypeError('Backup destination/profile must be a bounded host catalog ID')
  return value
}
/** Versionless legacy records retain their two known preferences. Unknown
 * future versions and malformed values refuse rather than resetting settings.
 * This function does not migrate any provider schema or wallet recovery data. */
export function migrateDeviceBackupPreferences(value: unknown): DeviceBackupPreferences {
  if (value === undefined || value === null)
    return Object.freeze({ version: 1, automaticSync: false, backupDestinations: Object.freeze([]) })
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid device backup preferences')
  const input = value as Record<string, unknown>
  if (input.version !== undefined && input.version !== 1)
    throw new TypeError('Unsupported device backup preference version')
  if (input.automaticSync !== undefined && typeof input.automaticSync !== 'boolean')
    throw new TypeError('Invalid automatic backup preference')
  const destinations = input.backupDestinations ?? []
  if (!Array.isArray(destinations) || destinations.length > 16)
    throw new TypeError('Invalid backup destination catalog')
  const copied = destinations.map(catalogId)
  if (new Set(copied).size !== copied.length) throw new TypeError('Duplicate backup destination catalog ID')
  return Object.freeze({
    version: 1,
    automaticSync: input.automaticSync === true,
    backupDestinations: Object.freeze(copied)
  })
}

/** Platform-neutral host lifecycle integration. Each run uses the original
 * manager's negotiated synchronization and destination-owned durable checkpoint.
 * Progress is observational and is never persisted as recovery authority.
 * No timer starts in the constructor: hosts call syncAutomatically on their
 * foreground cadence and await suspend before replacing/closing profile stores. */
export class DeviceBackupController {
  private preferences: DeviceBackupPreferences
  private readonly profiles: readonly DeviceBackupProfile[]
  private readonly seenDestinations = new WeakSet<WalletStorageProvider>()
  private suspended = false
  private closed = false
  private active?: { abort: AbortController; done: Promise<readonly DeviceBackupResult[]> }
  private retainedCleanup?: Brc38StagingCleanupError
  private preferenceWrite = false
  private preferenceUpdate?: Promise<void>
  private constructor(
    private readonly store: DeviceBackupPreferenceStore,
    profiles: readonly DeviceBackupProfile[],
    preferences: DeviceBackupPreferences
  ) {
    this.preferences = preferences
    this.profiles = Object.freeze(profiles.map(profile => Object.freeze({ ...profile })))
  }
  static async open(
    store: DeviceBackupPreferenceStore,
    profiles: readonly DeviceBackupProfile[]
  ): Promise<DeviceBackupController> {
    if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 16)
      throw new RangeError('Device backup needs 1 to 16 profiles')
    const ids = new Set<string>(),
      managers = new Set<WalletStorageManager>()
    const selected = profiles.map(profile => {
      const copy = Object.freeze({ ...profile })
      if (
        ids.has(catalogId(copy.profileId)) ||
        managers.has(copy.manager) ||
        typeof copy.identityKey !== 'string' ||
        copy.identityKey.length < 1 ||
        copy.identityKey.length > 256 ||
        !['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'].includes(copy.chain) ||
        typeof copy.openDestination !== 'function' ||
        typeof copy.closeDestination !== 'function'
      )
        throw new TypeError('Backup profiles require independent managers and bounded identity/network bindings')
      ids.add(copy.profileId)
      managers.add(copy.manager)
      return copy
    })
    const controller = new DeviceBackupController(store, selected, migrateDeviceBackupPreferences(await store.read()))
    await controller.checkProfiles()
    return controller
  }
  getPreferences(): DeviceBackupPreferences {
    return migrateDeviceBackupPreferences(this.preferences)
  }
  setPreferences(selected: DeviceBackupPreferences): Promise<void> {
    if (this.closed || this.preferenceWrite)
      throw new Error('Device backup preferences are closed or already being written')
    const copied = migrateDeviceBackupPreferences(selected)
    this.preferenceWrite = true
    const pending = Promise.resolve()
      .then(async () => {
        // Revoke this run before changing its destination selection; acknowledged
        // pages remain durable. A new run negotiates from each destination again.
        await this.cancelActive()
        if (this.closed) throw new Error('Device backup closed before preference write')
        if (this.retainedCleanup !== undefined) throw this.retainedCleanup
        const actualWrite = Promise.resolve().then(() => this.store.write(copied))
        const settled = actualWrite.then(
          () => {
            this.preferences = copied
          },
          () => {}
        )
        try {
          await lifecycleDeadline(actualWrite)
        } catch (cause) {
          const cleanup = () =>
            mapAwaitFromSync(
              () => lifecycleDeadline(settled),
              () => {
                this.retainedCleanup = undefined
              }
            )
          try {
            await cleanup()
          } catch (error_) {
            this.retainedCleanup = new Brc38StagingCleanupError(
              [cause, error_],
              'Device backup retains actual preference write settlement',
              cleanup
            )
            throw this.retainedCleanup
          }
          throw cause
        }
      })
      .finally(() => {
        this.preferenceWrite = false
        this.preferenceUpdate = undefined
      })
    this.preferenceUpdate = pending
    void pending.catch(() => {})
    return pending
  }
  private async checkProfiles(): Promise<void> {
    const active = new Set<WalletStorageProvider>()
    for (const profile of this.profiles) {
      const auth = { ...(await profile.manager.getAuth()) },
        settings = profile.manager.getActiveSettings()
      const provider = profile.manager.getActive()
      if (auth.identityKey !== profile.identityKey || settings.chain !== profile.chain || active.has(provider))
        throw new Error('Device backup profile identity, network or independent primary binding changed')
      active.add(provider)
    }
  }
  syncAutomatically(options: DeviceBackupRunOptions = {}): Promise<readonly DeviceBackupResult[]> {
    if (!this.preferences.automaticSync || this.suspended) return Promise.resolve(Object.freeze([]))
    return this.syncNow(options)
  }
  syncNow(selected: DeviceBackupRunOptions = {}): Promise<readonly DeviceBackupResult[]> {
    if (this.closed || this.suspended || this.preferenceWrite || this.active !== undefined)
      throw new Error('Device backup is closed, suspended or already owned')
    if (this.retainedCleanup !== undefined) throw this.retainedCleanup
    const options = Object.freeze({ ...selected }),
      preferences = this.getPreferences(),
      abort = new AbortController()
    const signal = options.signal
    const cancel = () => abort.abort(signal?.reason)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted === true) cancel()
    const done = Promise.resolve()
      .then(() => this.run(preferences, options, abort.signal))
      .finally(() => {
        signal?.removeEventListener('abort', cancel)
        if (this.active?.abort === abort) this.active = undefined
      })
    this.active = { abort, done }
    // Hosts may suspend without separately consuming the run rejection.
    void done.catch(() => {})
    return done
  }
  private async run(
    preferences: DeviceBackupPreferences,
    options: DeviceBackupRunOptions,
    signal: AbortSignal
  ): Promise<readonly DeviceBackupResult[]> {
    const results: DeviceBackupResult[] = []
    await this.checkProfiles()
    for (const profile of this.profiles) {
      for (const destinationId of preferences.backupDestinations) {
        if (signal.aborted) return Object.freeze(results)
        const writer = await this.openOwnedDestination(profile, destinationId, signal)
        let cause: unknown,
          failed = false,
          destinationCloseAttempted = false
        try {
          await this.checkProfiles()
          if (!signal.aborted) {
            const auth = { ...(await profile.manager.getAuth()) }
            const settings = await writer.makeAvailable()
            if (auth.identityKey !== profile.identityKey || settings.chain !== profile.chain)
              throw new Error('Backup destination identity/network preflight failed')
            const result = await profile.manager.syncToWriterResumable(auth, writer, {
              signal,
              maxItems: options.maxItems,
              maxRoughSize: options.maxRoughSize,
              snapshotLifetimeMs: options.snapshotLifetimeMs,
              onProgress: progress => options.onProgress?.(profile.profileId, destinationId, progress),
              onJournalProgress: progress => options.onJournalProgress?.(profile.profileId, destinationId, progress)
            })
            results.push(Object.freeze({ profileId: profile.profileId, destinationId, result }))
          }
        } catch (error) {
          failed = true
          cause = error
        }
        const drain = async () => {
          if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
          destinationCloseAttempted = true
          await this.closeOwnedDestination(profile, writer)
        }
        try {
          await drain()
        } catch (error_) {
          const retry = async () => {
            if (cause instanceof Brc38StagingCleanupError) await cause.retryCleanup()
            if (error_ instanceof Brc38StagingCleanupError) await error_.retryCleanup()
            if (!destinationCloseAttempted) await this.closeOwnedDestination(profile, writer)
            this.retainedCleanup = undefined
          }
          this.retainedCleanup = new Brc38StagingCleanupError(
            failed ? [cause, error_] : [error_],
            'Device backup retains actual destination provider cleanup',
            retry
          )
          throw this.retainedCleanup
        }
        if (failed) {
          throw cause
        }
      }
    }
    return Object.freeze(results)
  }
  private acceptDestination(writer: WalletStorageProvider): void {
    if (
      typeof writer !== 'object' ||
      writer === null ||
      this.seenDestinations.has(writer) ||
      this.profiles.some(profile => profile.manager.getActive() === writer)
    )
      throw new Error('Backup factory returned a reused or active profile provider; ownership is not accepted')
    this.seenDestinations.add(writer)
  }
  private async openOwnedDestination(
    profile: DeviceBackupProfile,
    destinationId: string,
    signal: AbortSignal
  ): Promise<WalletStorageProvider> {
    const pending = Promise.resolve().then(() => profile.openDestination(destinationId, signal))
    let writer: WalletStorageProvider | undefined,
      accepted = false,
      closed = false,
      refused = false,
      failed = false,
      failure: unknown
    let retainedClose: Brc38StagingCleanupError | undefined
    const settled = pending.then(
      value => {
        writer = value
      },
      cause => {
        failed = true
        failure = cause
      }
    )
    const cleanup = async () => {
      // A timeout does not cancel this actual factory promise. Late output must
      // pass ownership admission and close before another run can be accepted.
      await lifecycleDeadline(settled)
      if (failed) {
        if (failure instanceof Brc38StagingCleanupError) await failure.retryCleanup()
        return
      }
      if (writer === undefined) throw new TypeError('Backup factory returned no provider')
      if (!accepted) {
        this.acceptDestination(writer)
        accepted = true
      }
      if (retainedClose !== undefined) {
        await retainedClose.retryCleanup()
        closed = true
      } else if (!closed) {
        try {
          await this.closeOwnedDestination(profile, writer)
          closed = true
        } catch (cause) {
          if (cause instanceof Brc38StagingCleanupError) retainedClose = cause
          throw cause
        }
      }
    }
    try {
      const opened = await lifecycleDeadline(pending)
      try {
        this.acceptDestination(opened)
        accepted = true
      } catch (cause) {
        refused = true
        throw cause
      }
      return opened
    } catch (cause) {
      // An ownership refusal provides no authority to close a foreign provider.
      if (refused) throw cause
      try {
        await cleanup()
      } catch (error_) {
        this.retainedCleanup = new Brc38StagingCleanupError(
          [cause, error_],
          'Device backup retains actual destination factory settlement and cleanup',
          cleanup
        )
        throw this.retainedCleanup
      }
      throw cause
    }
  }
  private async closeOwnedDestination(profile: DeviceBackupProfile, writer: WalletStorageProvider): Promise<void> {
    let completed = false,
      failure: unknown
    let nestedCleanup: Promise<void> | undefined,
      nestedFailed = false
    let pending!: Promise<void>, settled!: Promise<void>
    const begin = () => {
      completed = false
      failure = undefined
      pending = Promise.resolve().then(() => profile.closeDestination(writer))
      settled = pending.then(
        () => {
          completed = true
        },
        cause => {
          failure = cause
        }
      )
    }
    begin()
    const cleanup = async () => {
      // Every retry retains its actual close promise; another close cannot
      // start while either the original or a previous retry is still pending.
      await lifecycleDeadline(settled)
      if (completed) return
      if (failure instanceof Brc38StagingCleanupError) {
        if (nestedCleanup === undefined || nestedFailed) {
          nestedFailed = false
          nestedCleanup = failure.retryCleanup().catch(cause => {
            nestedFailed = true
            throw cause
          })
          void nestedCleanup.catch(() => {})
        }
        await lifecycleDeadline(nestedCleanup)
        nestedCleanup = undefined
      }
      begin()
      await lifecycleDeadline(pending)
    }
    try {
      await lifecycleDeadline(pending)
    } catch (cause) {
      throw new Brc38StagingCleanupError([cause], 'Device backup retains actual provider close settlement', cleanup)
    }
  }
  private async cancelActive(): Promise<void> {
    const current = this.active
    if (current === undefined) return
    current.abort.abort(new Error('Device backup lifecycle requested suspension'))
    await current.done
  }
  /** Resolves only after the real run and destination cleanup have settled. */
  async suspend(): Promise<void> {
    this.suspended = true
    await this.drainLifecycle()
  }
  private drainLifecycle(): Promise<void> {
    return mapAwaitFromSync(
      () => Promise.allSettled([this.cancelActive(), this.preferenceUpdate ?? Promise.resolve()]),
      outcomes => {
        const failures = outcomes
          .filter((value): value is PromiseRejectedResult => value.status === 'rejected')
          .map(value => value.reason)
        if (this.retainedCleanup !== undefined && !failures.includes(this.retainedCleanup))
          failures.push(this.retainedCleanup)
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'Device backup lifecycle drain failed')
      }
    )
  }
  resume(): void {
    if (this.closed || this.active !== undefined || this.retainedCleanup !== undefined || this.preferenceWrite)
      throw new Error('Device backup cannot resume before retained ownership is drained')
    this.suspended = false
  }
  async retryCleanup(): Promise<void> {
    const original = this.retainedCleanup
    if (original !== undefined) {
      await original.retryCleanup()
      if (this.retainedCleanup === original) this.retainedCleanup = undefined
    }
  }
  async close(): Promise<void> {
    this.closed = true
    this.suspended = true
    await this.drainLifecycle()
  }
}
