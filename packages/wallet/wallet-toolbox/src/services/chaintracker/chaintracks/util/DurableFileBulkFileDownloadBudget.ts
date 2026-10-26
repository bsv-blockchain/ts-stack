import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { WERR_INVALID_PARAMETER } from '../../../../sdk'
import type { BulkFileDownloadBudgetApi, BulkFileDownloadBudgetSnapshot } from '../Api/BulkFileDataCacheApi'

export interface DurableFileBulkFileDownloadBudgetOptions {
  maxBytes: number
  stateFile: string
  windowMsecs?: number
  now?: () => number
  /** Maximum wait for the cross-process state lock. Default: 30 seconds. */
  lockTimeoutMsecs?: number
  /** Delay between cross-process lock attempts. Default: 25 milliseconds. */
  lockRetryMsecs?: number
}

interface BudgetState {
  version: 1
  maxBytes: number
  windowMsecs: number
  windowStartedAt: number
  consumedBytes: number
}

/**
 * Crash-safe fixed-window reservation ledger for remote bulk-header bytes.
 *
 * State is flushed before `consume` resolves, so a crash may conservatively
 * over-count an attempt but can never reset the allowance or permit an
 * unrecorded request. Deployments must place `stateFile` on durable storage.
 *
 * @public
 */
export class DurableFileBulkFileDownloadBudget implements BulkFileDownloadBudgetApi {
  private readonly maxBytes: number
  private readonly windowMsecs: number
  private readonly stateFile: string
  private readonly lockFolder: string
  private readonly lockTimeoutMsecs: number
  private readonly lockRetryMsecs: number
  private readonly now: () => number
  private tail: Promise<void> = Promise.resolve()
  private snapshotState: BudgetState

  constructor(options: DurableFileBulkFileDownloadBudgetOptions) {
    this.maxBytes = positiveInteger(options.maxBytes, 'maxBytes')
    this.windowMsecs = positiveInteger(options.windowMsecs ?? 60 * 60 * 1000, 'windowMsecs')
    this.lockTimeoutMsecs = positiveInteger(options.lockTimeoutMsecs ?? 30_000, 'lockTimeoutMsecs')
    this.lockRetryMsecs = positiveInteger(options.lockRetryMsecs ?? 25, 'lockRetryMsecs')
    if (this.lockRetryMsecs > this.lockTimeoutMsecs) {
      throw new WERR_INVALID_PARAMETER('lockRetryMsecs', 'no greater than lockTimeoutMsecs')
    }
    if (typeof options.stateFile !== 'string' || options.stateFile.trim() === '') {
      throw new WERR_INVALID_PARAMETER('stateFile', 'a non-empty path')
    }
    this.stateFile = path.resolve(options.stateFile)
    this.lockFolder = `${this.stateFile}.lock`
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new WERR_INVALID_PARAMETER('now', 'a function when defined')
    }
    this.now = options.now ?? Date.now
    this.snapshotState = this.newState(this.now())
  }

  /**
   * Load and validate the durable ledger before the service becomes ready.
   *
   * `consume` also initializes lazily, but services should await this method so
   * readiness reports the persisted allowance and corrupt state fails startup.
   */
  async initialize(): Promise<void> {
    const operation = this.tail.then(async () => {
      await this.withStateLock(async () => {
        await this.readState()
      })
    })
    this.tail = operation.then(
      () => undefined,
      () => undefined
    )
    await operation
  }

  async consume(byteCount: number): Promise<void> {
    positiveInteger(byteCount, 'byteCount')
    const operation = this.tail.then(async () => await this.consumeSerialized(byteCount))
    this.tail = operation.then(
      () => undefined,
      () => undefined
    )
    return await operation
  }

  snapshot(): BulkFileDownloadBudgetSnapshot {
    return {
      maxBytes: this.snapshotState.maxBytes,
      consumedBytes: this.snapshotState.consumedBytes,
      remainingBytes: this.snapshotState.maxBytes - this.snapshotState.consumedBytes,
      windowStartedAt: this.snapshotState.windowStartedAt,
      windowMsecs: this.snapshotState.windowMsecs
    }
  }

  private async consumeSerialized(byteCount: number): Promise<void> {
    await this.withStateLock(async () => {
      const now = this.validNow()
      let state = await this.readState()
      if (now - state.windowStartedAt >= this.windowMsecs) state = this.newState(now)
      const remaining = this.maxBytes - state.consumedBytes
      if (byteCount > remaining) {
        throw new Error(
          `Bulk-header download budget exceeded: requested ${byteCount} bytes with ` +
            `${remaining} bytes remaining in the current window.`
        )
      }
      state.consumedBytes += byteCount
      await this.writeState(state)
      this.snapshotState = state
    })
  }

  private newState(windowStartedAt: number): BudgetState {
    if (!Number.isSafeInteger(windowStartedAt) || windowStartedAt < 0) {
      throw new WERR_INVALID_PARAMETER('now()', 'a non-negative safe integer')
    }
    return {
      version: 1,
      maxBytes: this.maxBytes,
      windowMsecs: this.windowMsecs,
      windowStartedAt,
      consumedBytes: 0
    }
  }

  private async readState(): Promise<BudgetState> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.newState(this.validNow())
      throw new Error(`Unable to read durable bulk-header download budget: ${String(error)}`)
    }
    if (!isBudgetState(parsed)) throw new Error('Durable bulk-header download budget state is invalid.')
    // Configuration changes never reset an active allowance. A lower maximum
    // clamps consumption to "fully spent" and a shorter window takes effect
    // only after the longer active window has elapsed.
    const migrated: BudgetState = {
      ...parsed,
      maxBytes: this.maxBytes,
      windowMsecs: Math.max(parsed.windowMsecs, this.windowMsecs),
      consumedBytes: Math.min(parsed.consumedBytes, this.maxBytes)
    }
    this.snapshotState = migrated
    return migrated
  }

  private async writeState(state: BudgetState): Promise<void> {
    const folder = path.dirname(this.stateFile)
    await fs.mkdir(folder, { recursive: true })
    const temporary = path.join(folder, `.${path.basename(this.stateFile)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(state))
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporary, this.stateFile)
      await syncDirectory(folder)
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private validNow(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WERR_INVALID_PARAMETER('now()', 'a non-negative safe integer')
    }
    return value
  }

  private async withStateLock<T>(work: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    const ownerFile = path.join(this.lockFolder, 'owner')
    const startedAt = Date.now()
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true })
    for (;;) {
      try {
        await fs.mkdir(this.lockFolder, { mode: 0o700 })
        try {
          await fs.writeFile(ownerFile, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (error) {
          await fs.rmdir(this.lockFolder).catch(() => undefined)
          throw error
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() - startedAt >= this.lockTimeoutMsecs) {
          throw new Error(
            `Timed out acquiring durable bulk-header download budget lock ${this.lockFolder}. ` +
              'The lock is never reclaimed automatically after a crash; verify that no writer is active before removing it.'
          )
        }
        await new Promise(resolve => setTimeout(resolve, this.lockRetryMsecs))
      }
    }
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = { ok: true, value: await work() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    let releaseError: unknown
    try {
      let owner: string | undefined
      try {
        owner = await fs.readFile(ownerFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (owner === token) {
        await fs.unlink(ownerFile)
        await fs.rmdir(this.lockFolder)
      }
    } catch (error) {
      releaseError = error
    }
    if (!outcome.ok) throw outcome.error
    if (releaseError != null) throw releaseError
    return outcome.value
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new WERR_INVALID_PARAMETER(name, 'a positive safe integer')
  }
  return value
}

function isBudgetState(value: unknown): value is BudgetState {
  if (value == null || typeof value !== 'object') return false
  const state = value as Partial<BudgetState>
  return (
    state.version === 1 &&
    Number.isSafeInteger(state.maxBytes) &&
    Number.isSafeInteger(state.windowMsecs) &&
    Number.isSafeInteger(state.windowStartedAt) &&
    Number.isSafeInteger(state.consumedBytes) &&
    state.maxBytes! > 0 &&
    state.windowMsecs! > 0 &&
    state.windowStartedAt! >= 0 &&
    state.consumedBytes! >= 0 &&
    state.consumedBytes! <= state.maxBytes!
  )
}

async function syncDirectory(folder: string): Promise<void> {
  const handle = await fs.open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
