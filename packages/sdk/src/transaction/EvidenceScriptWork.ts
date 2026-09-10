import type Transaction from './Transaction.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import type { BdkVerifyScriptsParams } from './BdkVerifierInterface.js'
import { sha256 } from '../primitives/Hash.js'
import { toHex, toArray } from '../primitives/utils.js'
import {
  evidenceError,
  TransactionEvidenceError,
  type TransactionEvidenceLimits
} from './TransactionEvidence.js'

interface InputResult {
  valid: boolean
  inputTotal: number
}
interface Entry {
  key: string
  generation: number
  owners: Set<EvidenceScriptScope>
  promise: Promise<boolean>
  resolve: (valid: boolean) => void
  reject: (error: unknown) => void
  params: BdkVerifyScriptsParams
}

/** Binds exact script execution inputs; never an ancestor/chain verdict. */
function binding(params: BdkVerifyScriptsParams): string {
  const tx = params.tx
  const sources = tx.inputs.map(input => {
    const source = input.sourceTransaction
    const output = source?.outputs[input.sourceOutputIndex]
    if (source === undefined || output === undefined)
      throw new TransactionEvidenceError('invalid-evidence')
    return [
      source.id('hex'),
      input.sourceOutputIndex,
      output.satoshis,
      output.lockingScript.toHex()
    ]
  })
  return toHex(
    sha256(
      toArray(
        JSON.stringify([
          tx.toHex(),
          sources,
          params.blockHeight,
          params.consensus,
          params.verifyFlags,
          params.memoryLimit
        ]),
        'utf8'
      )
    )
  )
}

/** Internal cache. Only coordinator-owned transactions are bound to its scope below. */
export class EvidenceScriptWork {
  private readonly positives = new Map<string, number>()
  private readonly pending = new Map<string, Entry>()
  private outstanding = 0
  private generation = 0
  private expiryTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly limits: Readonly<TransactionEvidenceLimits>) {}

  clear(): void {
    this.generation++
    this.positives.clear()
    // Running non-abortable calls remain charged until their actual completion.
    this.pending.clear()
    clearTimeout(this.expiryTimer)
  }

  private has(key: string): boolean {
    const expires = this.positives.get(key)
    if (expires !== undefined && expires > Date.now()) return true
    this.positives.delete(key)
    return false
  }

  private remember(key: string): void {
    if (this.positives.size >= this.limits.cacheEntries)
      this.positives.delete(this.positives.keys().next().value!)
    this.positives.set(key, Date.now() + this.limits.cacheAgeMs)
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer)
    const expiresAt = Math.min(...this.positives.values())
    if (!Number.isFinite(expiresAt)) return
    this.expiryTimer = setTimeout(
      () => {
        for (const key of this.positives.keys()) this.has(key)
        this.scheduleExpiry()
      },
      Math.max(1, expiresAt - Date.now())
    )
    this.expiryTimer.unref?.()
  }

  inputs(
    scope: EvidenceScriptScope,
    params: BdkVerifyScriptsParams,
    verify: (skipScripts: boolean) => InputResult
  ): InputResult {
    scope.check()
    const key = binding(params)
    const hit = this.has(key)
    // Even a hit traverses every source, queues ancestry and recomputes input value.
    const result = verify(hit)
    scope.check()
    if (binding(params) !== key) throw new TransactionEvidenceError('invalid-evidence')
    if (result.valid && !hit) this.remember(key)
    return result
  }

  async batch(
    scope: EvidenceScriptScope,
    params: readonly BdkVerifyScriptsParams[],
    backend: BdkVerifierInterface
  ): Promise<boolean[]> {
    scope.check()
    const created: Entry[] = []
    const results = params.map(param => {
      const key = binding(param)
      if (this.has(key))
        return Promise.resolve().then(() => {
          scope.check()
          if (binding(param) !== key) throw new TransactionEvidenceError('invalid-evidence')
          return true
        })
      let entry = this.pending.get(key)
      if (entry === undefined) {
        if (this.outstanding >= this.limits.transactions)
          return Promise.reject(new TransactionEvidenceError('limit'))
        let resolve: Entry['resolve'] = () => {}
        let reject: Entry['reject'] = () => {}
        const promise = new Promise<boolean>((accept, fail) => {
          resolve = accept
          reject = fail
        })
        entry = {
          key,
          generation: this.generation,
          owners: new Set(),
          promise,
          resolve,
          reject,
          params: param
        }
        this.outstanding++
        this.pending.set(key, entry)
        created.push(entry)
      }
      const owned = entry
      owned.owners.add(scope)
      const abandon = (): void => {
        owned.owners.delete(scope)
        if (owned.owners.size === 0 && this.pending.get(key) === owned) this.pending.delete(key)
      }
      scope.signal.addEventListener('abort', abandon, { once: true })
      // The outer attempt handles cancellation. Keep non-abortable backend work
      // countable until actual settlement; one owner cannot cancel another.
      return owned.promise
        .then(valid => {
          scope.check()
          if (binding(param) !== key) throw new TransactionEvidenceError('invalid-evidence')
          return valid === true
        })
        .finally(() => {
          scope.signal.removeEventListener('abort', abandon)
          abandon()
        })
    })
    if (created.length > 0) void this.execute(created, backend)
    const settled = await Promise.allSettled(results)
    const values = settled.map(value => {
      if (value.status === 'rejected') {
        throw evidenceError(value.reason)
      }
      return value.value
    })
    scope.check()
    return values
  }

  private async execute(entries: Entry[], backend: BdkVerifierInterface): Promise<void> {
    try {
      const params = entries.map(entry => entry.params)
      if (backend.verifyScriptsBatch === undefined) {
        const settled = await Promise.allSettled(
          params.map(async param => await backend.verifyScripts(param))
        )
        entries.forEach((entry, index) => {
          this.settleEntry(entry, settled[index])
        })
        return
      }
      const values = await backend.verifyScriptsBatch(params)
      if (values.length !== entries.length) throw new TransactionEvidenceError('invalid-evidence')
      entries.forEach((entry, index) => {
        this.publishEntry(entry, values[index] === true)
      })
    } catch (error) {
      for (const entry of entries) entry.reject(evidenceError(error))
    } finally {
      for (const entry of entries) {
        this.outstanding--
        if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key)
      }
    }
  }

  private settleEntry(entry: Entry, result: PromiseSettledResult<boolean> | undefined): void {
    if (result === undefined || result.status === 'rejected') {
      entry.reject(evidenceError(result?.reason))
      return
    }
    this.publishEntry(entry, result.value === true)
  }

  private publishEntry(entry: Entry, valid: boolean): void {
    if (binding(entry.params) !== entry.key) {
      entry.reject(new TransactionEvidenceError('invalid-evidence'))
      return
    }
    let live = false
    for (const owner of entry.owners) {
      try {
        owner.check()
        live = true
      } catch {
        /* stale ownership cannot publish */
      }
    }
    if (valid && live && entry.generation === this.generation) this.remember(entry.key)
    entry.resolve(valid)
  }
}

export interface EvidenceScriptScope {
  work: EvidenceScriptWork
  signal: AbortSignal
  check: () => void
}

// No host metadata, Transaction field or serialized flag can construct this
// association. Its owner is the coordinator's byte-snapshotted candidate.
const scopes = new WeakMap<Transaction, EvidenceScriptScope>()

export async function withEvidenceScriptWork<T>(
  tx: Transaction,
  scope: EvidenceScriptScope,
  verify: () => Promise<T>
): Promise<T> {
  scopes.set(tx, scope)
  try {
    return await verify()
  } finally {
    scopes.delete(tx)
  }
}

export function evidenceScriptScope(tx: Transaction): EvidenceScriptScope | undefined {
  return scopes.get(tx)
}

export function scopedScriptBackend(
  scope: EvidenceScriptScope,
  backend: BdkVerifierInterface
): BdkVerifierInterface {
  return {
    supportsMemoryLimit: backend.supportsMemoryLimit,
    shouldVerifyScripts:
      backend.shouldVerifyScripts === undefined
        ? undefined
        : params => {
            scope.check()
            const key = binding(params)
            const ready = backend.shouldVerifyScripts!(params)
            scope.check()
            if (binding(params) !== key) throw new TransactionEvidenceError('invalid-evidence')
            return ready
          },
    verifyScripts: async params => (await scope.work.batch(scope, [params], backend))[0],
    verifyScriptsBatch: async params => await scope.work.batch(scope, params, backend)
  }
}
