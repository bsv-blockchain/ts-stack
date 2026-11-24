import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputPacketDigest,
  OutputProtocolError
} from '@bsv/sdk'
import { PrivateServiceDomain } from './PrivateServiceDomain.js'
import { PrivatePublicationContracts } from './PrivatePublicationContracts.js'
import { parsePrivatePublicationProgress } from './PrivatePublicationProgress.js'
import { privatePublicationFenceAddress } from './PrivatePublicationRecords.js'
import type { ProtectedLedgerRecord } from './ProtectedLedgerCodec.js'

export interface PrivatePublicationWorkItem {
  publicationId: string
  publisher: string
  recordRevision: string
  phase: 'staged' | 'admitting' | 'binding'
  capability: string
  profile: string
}

/** Installed internal-worker authority. No enumeration or protected payload reaches a remote route. */
export class PrivatePublicationWork {
  private readonly installed: ReturnType<PrivatePublicationContracts['configuration']>
  private readonly methods: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePublicationContracts,
    private readonly clock: () => string,
    private readonly workerCurrent: () => boolean
  ) {
    outputAssert(
      typeof workerCurrent === 'function' && workerCurrent.constructor.name !== 'AsyncFunction',
      'Private publication worker authority must be synchronous'
    )
    this.installed = contracts.configuration()
    outputAssert(
      this.installed.seller === domain.scope.seller &&
        canonicalOutputJSON(this.installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Private work custody installation differs',
      'context-changed'
    )
    this.methods = [
      pin(domain, 'ledger'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'enumerate'),
      pin(contracts, 'restore')
    ]
  }

  isCurrent(signal?: AbortSignal): boolean {
    if (signal?.aborted || !this.methods.every(check => check())) return false
    const allowed: unknown = this.workerCurrent()
    if (allowed instanceof Promise) {
      void allowed.catch(() => undefined)
      return false
    }
    return allowed === true && !signal?.aborted
  }
  private guard(signal?: AbortSignal) {
    return () => {
      outputAssert(
        this.isCurrent(signal),
        'Private publication worker context changed',
        'context-changed'
      )
    }
  }
  scan(afterKey: string | null, maximum: number, signal?: AbortSignal) {
    const page = this.domain.ledger.enumerate(
      'request-fence',
      afterKey,
      maximum,
      this.clock,
      this.guard(signal)
    )
    const entries: PrivatePublicationWorkItem[] = [],
      blocked: { key: string; status: string }[] = []
    if (!page.entries.length) return { entries, blocked, next: page.next }
    const records = this.domain.ledger.read(
      page.entries.map(({ kind, key }) => ({ kind, key })),
      this.clock,
      this.guard(signal)
    ).records
    for (const record of records) {
      if (!record) continue
      try {
        const item = this.item(record)
        if (item) entries.push(item)
      } catch (error) {
        blocked.push({
          key: record.key,
          status: error instanceof OutputProtocolError ? error.code : 'unavailable'
        })
      }
    }
    return { entries, blocked, next: page.next }
  }
  resolve(publicationId: string, signal?: AbortSignal): PrivatePublicationWorkItem | undefined {
    const id = outputHex32(publicationId)
    const record = this.domain.ledger.read(
      [privatePublicationFenceAddress(this.domain.identity, id)],
      this.clock,
      this.guard(signal)
    ).records[0]
    const item = record && this.item(record)
    outputAssert(
      !item || item.publicationId === id,
      'Private publication work address differs',
      'unavailable'
    )
    return item
  }
  private item(record: ProtectedLedgerRecord): PrivatePublicationWorkItem | undefined {
    // This kind is shared with other service fences. Never reinterpret their data.
    if (record.value.format !== 'private-publication-fence/2') {
      if (
        typeof record.value.format === 'string' &&
        record.value.format.startsWith('private-publication-fence/')
      )
        throw new OutputProtocolError(
          'unsupported',
          'Publication work requires its original verified contract'
        )
      return undefined
    }
    const state = parsePrivatePublicationProgress(record.value.state)
    if (state.topic !== this.installed.topic) return undefined
    const address = privatePublicationFenceAddress(this.domain.identity, state.publicationId)
    const reference = record.value.reference,
      original = record.value.original
    outputAssert(
      reference &&
        typeof reference === 'object' &&
        !Array.isArray(reference) &&
        original &&
        typeof original === 'object' &&
        !Array.isArray(original),
      'Private publication work record is incomplete',
      'unavailable'
    )
    outputAssert(
      record.kind === address.kind &&
        record.key === address.key &&
        canonicalOutputJSON(state.chain) === canonicalOutputJSON(this.installed.chain) &&
        state.publicationId ===
          outputPacketDigest('private-publication', {
            chain: this.installed.chain,
            publisher: state.publisher,
            topic: state.topic,
            requestId: reference.requestId
          }),
      'Private publication work binding differs',
      'unavailable'
    )
    const phase = state.progress.phase
    if (phase !== 'staged' && phase !== 'admitting' && phase !== 'binding') return undefined
    const selection = this.contracts.restore(original.capability)
    return {
      publicationId: state.publicationId,
      publisher: state.publisher,
      recordRevision: record.revision,
      phase,
      capability: selection.digest,
      profile: selection.profile.id
    }
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}
