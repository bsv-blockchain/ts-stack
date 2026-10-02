import { canonicalOutputJSON, outputAssert, outputHex32, OutputProtocolError } from '@bsv/sdk'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type { PrivateAcquisitionContracts } from './PrivateAcquisitionContracts.js'
import type { SQLitePrivateAcquisitionStore } from './SQLitePrivateAcquisitionStore.js'
import { parsePrivateAcquisitionProgress } from './PrivateAcquisitionProgress.js'
import { privateAcquisitionAddress } from './PrivateAcquisitionState.js'
import type { ProtectedLedgerRecord } from './ProtectedLedgerCodec.js'

export interface PrivateAcquisitionWorkItem {
  acquisitionId: string
  buyer: string
  recordRevision: string
  phase: 'quoted' | 'funding-pending' | 'funded' | 'delivery-pending'
  capability: string
  profile: string
}

/** Local worker metadata only. Remote acquisition routes never expose this enumeration. */
export class PrivateAcquisitionWork {
  private readonly installed: ReturnType<PrivateAcquisitionContracts['configuration']>
  private readonly methods: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly store: Pick<SQLitePrivateAcquisitionStore, 'load'>,
    private readonly contracts: PrivateAcquisitionContracts,
    private readonly clock: () => string,
    private readonly workerCurrent: () => boolean
  ) {
    outputAssert(typeof clock === 'function', 'Acquisition worker clock is required')
    outputAssert(
      typeof workerCurrent === 'function' && workerCurrent.constructor.name !== 'AsyncFunction',
      'Acquisition worker authority must be synchronous'
    )
    this.installed = contracts.configuration()
    outputAssert(
      this.installed.seller === domain.scope.seller &&
        canonicalOutputJSON(this.installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Acquisition work custody installation differs',
      'context-changed'
    )
    this.methods = [
      pin(domain, 'ledger'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'enumerate'),
      pin(store, 'load'),
      pin(contracts, 'restore')
    ]
  }
  isCurrent(signal?: AbortSignal): boolean {
    if (signal?.aborted || !this.methods.every(check => check())) return false
    const permitted: unknown = this.workerCurrent()
    if (permitted instanceof Promise) {
      void permitted.catch(() => undefined)
      return false
    }
    return permitted === true && !signal?.aborted
  }
  private guard(signal?: AbortSignal) {
    return () => {
      outputAssert(
        this.isCurrent(signal),
        'Acquisition worker authority changed',
        'context-changed'
      )
    }
  }
  scan(afterKey: string | null, maximum: number, signal?: AbortSignal) {
    const guard = this.guard(signal)
    const page = this.domain.ledger.enumerate('acquisition', afterKey, maximum, this.clock, guard)
    const entries: PrivateAcquisitionWorkItem[] = [],
      blocked: { key: string; status: string }[] = []
    if (!page.entries.length) return { entries, blocked, next: page.next }
    const records = this.domain.ledger.read(
      page.entries.map(({ kind, key }) => ({ kind, key })),
      this.clock,
      guard
    ).records
    for (const record of records) {
      guard()
      if (!record) continue
      try {
        const item = this.item(record, signal)
        if (item) entries.push(item)
      } catch (error) {
        guard()
        blocked.push({
          key: record.key,
          status: error instanceof OutputProtocolError ? error.code : 'unavailable'
        })
      }
    }
    guard()
    return { entries, blocked, next: page.next }
  }
  resolve(acquisitionId: string, signal?: AbortSignal): PrivateAcquisitionWorkItem | undefined {
    const id = outputHex32(acquisitionId),
      guard = this.guard(signal)
    const record = this.domain.ledger.read(
      [privateAcquisitionAddress(this.domain.identity, 'acquisition', id)],
      this.clock,
      guard
    ).records[0]
    const item = record && this.item(record, signal)
    outputAssert(
      !item || item.acquisitionId === id,
      'Acquisition work address differs',
      'unavailable'
    )
    guard()
    return item
  }
  private item(
    record: ProtectedLedgerRecord,
    signal?: AbortSignal
  ): PrivateAcquisitionWorkItem | undefined {
    if (record.value.format !== 'private-acquisition-state/1') {
      if (
        typeof record.value.format === 'string' &&
        record.value.format.startsWith('private-acquisition-state/')
      )
        throw new OutputProtocolError(
          'unsupported',
          'Acquisition work requires its original state format'
        )
      return undefined
    }
    const progress = parsePrivateAcquisitionProgress(record.value.progress)
    const id = progress.challenge.acquisitionId,
      address = privateAcquisitionAddress(this.domain.identity, 'acquisition', id)
    outputAssert(
      record.kind === address.kind && record.key === address.key,
      'Acquisition work record address differs',
      'unavailable'
    )
    const quote = this.domain.ledger.read(
      [privateAcquisitionAddress(this.domain.identity, 'quote', id)],
      this.clock,
      this.guard(signal)
    ).records[0]
    outputAssert(quote, 'Acquisition work original is unavailable', 'unavailable')
    const request = quote.value.request
    outputAssert(
      request &&
        typeof request === 'object' &&
        !Array.isArray(request) &&
        typeof request.service === 'string',
      'Acquisition work request is unavailable',
      'unavailable'
    )
    if (request.service !== this.installed.service) return undefined
    // Reload through the native owner: it validates original custody and the full
    // state/payload binding and may observe a newer revision than enumeration.
    const current = this.store.load(id, progress.challenge.buyer, this.clock, this.guard(signal))
    outputAssert(current, 'Acquisition work original is unavailable', 'unavailable')
    outputAssert(
      current.original.challenge.seller === this.installed.seller &&
        current.original.request.service === this.installed.service &&
        canonicalOutputJSON(current.original.request.listing.chain) ===
          canonicalOutputJSON(this.installed.chain),
      'Acquisition work installation differs',
      'context-changed'
    )
    const phase = current.state.progress.phase
    if (
      phase !== 'quoted' &&
      phase !== 'funding-pending' &&
      phase !== 'funded' &&
      phase !== 'delivery-pending'
    )
      return undefined
    const selected = this.contracts.restore(current.original.capability)
    return {
      acquisitionId: id,
      buyer: current.original.challenge.buyer,
      recordRevision: current.row.revision,
      phase,
      capability: selected.digest,
      profile: selected.profile.id
    }
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}
