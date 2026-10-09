import {
  ownOutputJSONWithCountedRecords as ownOutputJSON,
  Beef,
  canonicalOutputJSONWithInlineRecords as canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputPacketDigestWithInlineStrings as outputPacketDigest,
  parseOutputJSONWithOwnedRecords as parseOutputJSON,
  parseOutputPurchaseSubmitWithOwnedRecords as parseOutputPurchaseSubmit,
  Utils,
  type OutputJSONObject,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import { assembleOutputEvidence } from '../EvidenceAssembler.js'
import type {
  PrivatePurchaseEvidence,
  PrivatePurchaseEvidencePlan,
  PrivatePurchaseEvidenceView
} from './PrivatePurchaseEvidence.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import {
  protectedInteger,
  type ProtectedLedgerAddress,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord
} from './ProtectedLedgerCodec.js'

const FORMAT = 'private-purchase-evidence/1'
const CHUNK = 196608
export interface PrivatePurchaseEvidenceLimits {
  maximumCandidateBytes: number
  /** Includes the first retained candidate; exact duplicates consume no update. */
  maximumUpdates: number
  maximumTransactions: number
  maximumDependencies: number
}
interface Snapshot {
  binding: OutputJSONObject
  records: ProtectedLedgerRecord[]
  candidate: OutputPurchaseSubmit | null
  updates: number
  checkCurrent: ProtectedLedgerGuard
}
const text = (candidate: OutputPurchaseSubmit, maximum: number) =>
  canonicalOutputJSON(candidate, { bytes: maximum })
const digest = (value: string) => Utils.toHex(Hash.sha256(Utils.toArray(value, 'utf8')))

/** Bounded encrypted same-transaction proof custody on an existing native owner.
 * Reserve every future chunk and update before terms leave the host. Open/read
 * never creates missing custody. Only a caller holding independent incoming and
 * combined proof validations may retain a proposal. No signing/admission occurs.
 */
export class SQLitePrivatePurchaseEvidence implements PrivatePurchaseEvidence {
  readonly id: string
  private readonly limits: PrivatePurchaseEvidenceLimits
  private readonly chunks: number
  private readonly pins: (() => boolean)[]
  private readonly ownerId: string
  private readonly ledger: PrivateServiceDomain['ledger']
  private readonly identity: PrivateServiceDomain['identity']
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePurchaseContracts,
    limits: PrivatePurchaseEvidenceLimits
  ) {
    const owned = ownOutputJSON(limits).value
    closedOutputObject(owned, [
      'maximumCandidateBytes',
      'maximumUpdates',
      'maximumTransactions',
      'maximumDependencies'
    ])
    this.limits = {
      maximumCandidateBytes: protectedInteger(owned.maximumCandidateBytes, 4194304),
      maximumUpdates: protectedInteger(owned.maximumUpdates, 64),
      maximumTransactions: protectedInteger(owned.maximumTransactions, 4096),
      maximumDependencies: protectedInteger(owned.maximumDependencies, 16384)
    }
    this.chunks = Math.ceil((Math.ceil(this.limits.maximumCandidateBytes / 3) * 4) / CHUNK)
    this.id = outputPacketDigest('purchase', {
      purpose: FORMAT,
      scope: domain.scope,
      limits: this.limits
    })
    this.ownerId = this.id
    this.ledger = domain.ledger
    this.identity = domain.identity
    this.pins = [
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'commit'),
      pin(domain.identity, 'address'),
      pin(contracts, 'original')
    ]
  }
  private current(): void {
    outputAssert(
      this.id === this.ownerId &&
        this.domain.ledger === this.ledger &&
        this.domain.identity === this.identity &&
        this.pins.every(check => check()),
      'Purchase evidence installation changed',
      'context-changed'
    )
  }
  private authorized(guard: ProtectedLedgerGuard): ProtectedLedgerGuard {
    outputAssert(
      typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
      'Purchase proof guard must be synchronous'
    )
    return view => {
      this.current()
      const result: unknown = guard(view)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined,
        'Purchase proof guard did not complete synchronously',
        'context-changed'
      )
    }
  }
  private binding(input: PrivatePurchaseOriginal): OutputJSONObject {
    this.current()
    const original = this.contracts.original(input)
    return {
      owner: this.id,
      acquisitionId: original.terms.body.acquisitionId,
      requestDigest: original.terms.body.requestDigest,
      recipient: original.request.recipient,
      originalDigest: outputPacketDigest('purchase', {
        request: original.request,
        terms: original.terms,
        capability: original.capability
      })
    }
  }
  private addresses(binding: OutputJSONObject): ProtectedLedgerAddress[] {
    return Array.from({ length: this.chunks + 1 }, (_, index) =>
      this.domain.identity.address('candidate', {
        purpose: FORMAT,
        acquisitionId: binding.acquisitionId,
        index
      })
    )
  }
  private header(
    binding: OutputJSONObject,
    updates: number,
    candidate: OutputPurchaseSubmit | null
  ): OutputJSONObject {
    return {
      format: FORMAT,
      binding,
      updates,
      txid: candidate?.txid ?? null,
      digest: candidate ? digest(text(candidate, this.limits.maximumCandidateBytes)) : null
    }
  }
  private chunk(index: number, data: string): OutputJSONObject {
    return { format: FORMAT, index, data }
  }
  reserve(input: PrivatePurchaseOriginal, clock: () => string, guard: ProtectedLedgerGuard): void {
    const binding = this.binding(input),
      addresses = this.addresses(binding),
      read = this.domain.ledger.read(addresses, clock, this.authorized(guard))
    if (read.records[0]) {
      this.snapshot(input, clock, guard)
      return
    }
    outputAssert(
      read.records.every(record => record === undefined),
      'Purchase proof custody is partial',
      'unavailable'
    )
    const changes = addresses.map((address, index): ProtectedLedgerChange => ({
      ...address,
      expectedRevision: null,
      reservedBytes: index === 0 ? 8192 : CHUNK + 1024,
      reservedUpdates: this.limits.maximumUpdates,
      value: index === 0 ? this.header(binding, 0, null) : this.chunk(index, '')
    }))
    this.domain.ledger.commit(
      read.revision,
      changes,
      clock,
      view => {
        this.current()
        this.authorized(guard)(view)
      },
      { maximumBatchBytes: this.maximumBatchBytes() }
    )
  }
  private maximumBatchBytes(): number {
    return this.chunks * (CHUNK + 2048) + 16384
  }
  private decode(
    records: ProtectedLedgerRecord[],
    binding: OutputJSONObject
  ): { candidate: OutputPurchaseSubmit | null; updates: number } {
    const header = records[0].value
    closedOutputObject(header, ['format', 'binding', 'updates', 'txid', 'digest'])
    outputAssert(
      header.format === FORMAT &&
        canonicalOutputJSON(header.binding) === canonicalOutputJSON(binding),
      'Purchase proof binding changed',
      'context-changed'
    )
    const updates = header.updates
    outputAssert(
      typeof updates === 'number' &&
        Number.isSafeInteger(updates) &&
        updates >= 0 &&
        updates <= this.limits.maximumUpdates,
      'Invalid purchase proof update count',
      'unavailable'
    )
    const data = records
      .slice(1)
      .map((record, offset) => {
        const chunk = record.value
        closedOutputObject(chunk, ['format', 'index', 'data'])
        outputAssert(
          chunk.format === FORMAT &&
            chunk.index === offset + 1 &&
            typeof chunk.data === 'string' &&
            chunk.data.length <= CHUNK &&
            record.revision === records[0].revision &&
            record.reservedUpdates === this.limits.maximumUpdates - updates &&
            record.reservedBytes === CHUNK + 1024,
          'Purchase proof chunk differs from its native generation',
          'unavailable'
        )
        return chunk.data as string
      })
      .join('')
    outputAssert(
      records[0].reservedUpdates === this.limits.maximumUpdates - updates &&
        records[0].reservedBytes === 8192,
      'Purchase proof completion budget changed',
      'unavailable'
    )
    if (updates === 0) {
      outputAssert(
        data === '' && header.txid === null && header.digest === null,
        'Empty purchase proof custody differs',
        'unavailable'
      )
      return { candidate: null, updates }
    }
    const bytes = decodeOutputBytes(data, this.limits.maximumCandidateBytes),
      candidate = parseOutputPurchaseSubmit(
        parseOutputJSON(Uint8Array.from(bytes), { bytes: this.limits.maximumCandidateBytes })
      )
    outputAssert(
      candidate.acquisitionId === binding.acquisitionId &&
        candidate.txid === header.txid &&
        digest(text(candidate, this.limits.maximumCandidateBytes)) === header.digest,
      'Retained purchase proof differs from its commitment',
      'unavailable'
    )
    return { candidate, updates }
  }
  private snapshot(
    input: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Snapshot {
    const binding = this.binding(input),
      addresses = this.addresses(binding),
      read = this.domain.ledger.read(addresses, clock, this.authorized(guard))
    outputAssert(
      read.records.every(record => record !== undefined),
      'Original purchase proof custody is missing',
      'unavailable'
    )
    const records = read.records as ProtectedLedgerRecord[],
      decoded = this.decode(records, binding),
      revision = records[0].revision,
      checkCurrent: ProtectedLedgerGuard = view => {
        this.current()
        outputAssert(
          view.get(addresses[0])?.revision === revision,
          'Original purchase proof view changed',
          'context-changed'
        )
      }
    return { binding, records, ...decoded, checkCurrent }
  }
  read(
    input: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseEvidenceView {
    const saved = this.snapshot(input, clock, guard)
    return { candidate: structuredClone(saved.candidate), checkCurrent: saved.checkCurrent }
  }
  private assembled(input: PrivatePurchaseOriginal, candidate: OutputPurchaseSubmit) {
    return assembleOutputEvidence(
      { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
      input.request.listing.chain,
      {
        bytes: this.limits.maximumCandidateBytes,
        transactions: this.limits.maximumTransactions,
        dependencies: this.limits.maximumDependencies
      }
    )
  }
  private combined(
    input: PrivatePurchaseOriginal,
    saved: OutputPurchaseSubmit | null,
    incoming: OutputPurchaseSubmit
  ): OutputPurchaseSubmit {
    const next = this.assembled(input, incoming)
    outputAssert(
      next.target && next.missing.length === 0,
      'Complete purchase proof is required',
      'unavailable'
    )
    if (saved === null) return incoming
    if (
      text(saved, this.limits.maximumCandidateBytes) ===
      text(incoming, this.limits.maximumCandidateBytes)
    )
      return saved
    outputAssert(
      saved.txid === incoming.txid,
      'Purchase proofs name different transactions',
      'conflict'
    )
    const prior = this.assembled(input, saved)
    outputAssert(
      prior.target?.rawTransaction === next.target.rawTransaction,
      'Purchase proofs name different raw transactions',
      'conflict'
    )
    const previous = new Map(prior.transactions.map(tx => [tx.txid, tx.rawTransaction]))
    for (const tx of next.transactions) {
      const raw = previous.get(tx.txid)
      outputAssert(
        raw === undefined || raw === tx.rawTransaction,
        'Purchase dependency raw transaction changed',
        'conflict'
      )
    }
    const merged = Beef.fromBinaryStrict(
      decodeOutputBytes(saved.beef, this.limits.maximumCandidateBytes)
    )
    merged.mergeBeef(
      Uint8Array.from(decodeOutputBytes(incoming.beef, this.limits.maximumCandidateBytes))
    )
    // Target-only serialization discards newly supplied shared proof rows.
    // Plain BEEF retains the bounded union with the same explicit raw target.
    const candidate = { ...incoming, beef: Utils.toBase64(merged.toBinary()) }
    text(candidate, this.limits.maximumCandidateBytes)
    this.assembled(input, candidate)
    return candidate
  }
  propose(
    input: PrivatePurchaseOriginal,
    value: OutputPurchaseSubmit,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseEvidencePlan {
    const incoming = parseOutputPurchaseSubmit(
        parseOutputJSON(text(value, this.limits.maximumCandidateBytes), {
          bytes: this.limits.maximumCandidateBytes
        })
      ),
      saved = this.snapshot(input, clock, guard)
    outputAssert(
      incoming.acquisitionId === saved.binding.acquisitionId,
      'Purchase proof names another acquisition',
      'conflict'
    )
    const candidate = this.combined(input, saved.candidate, incoming),
      owned = text(candidate, this.limits.maximumCandidateBytes),
      duplicate =
        saved.candidate !== null &&
        owned === text(saved.candidate, this.limits.maximumCandidateBytes)
    outputAssert(
      duplicate || saved.updates < this.limits.maximumUpdates,
      'Original purchase proof update capacity is exhausted',
      'limited'
    )
    const plan: PrivatePurchaseEvidencePlan = {
      candidate: structuredClone(candidate),
      checkCurrent: saved.checkCurrent,
      retain: (nextClock, nextGuard) => {
        this.current()
        outputAssert(
          text(plan.candidate, this.limits.maximumCandidateBytes) === owned,
          'Validated purchase proof proposal changed',
          'context-changed'
        )
        const read = this.domain.ledger.read(
          [{ kind: saved.records[0].kind, key: saved.records[0].key }],
          nextClock,
          view => {
            this.authorized(nextGuard)(view)
            saved.checkCurrent(view)
          }
        )
        if (duplicate) return
        const encoded = Utils.toBase64(Utils.toArray(owned, 'utf8')),
          changes = saved.records.map((record, index): ProtectedLedgerChange => ({
            kind: record.kind,
            key: record.key,
            expectedRevision: record.revision,
            reservedBytes: record.reservedBytes,
            reservedUpdates: record.reservedUpdates - 1,
            value:
              index === 0
                ? this.header(saved.binding, saved.updates + 1, candidate)
                : this.chunk(index, encoded.slice((index - 1) * CHUNK, index * CHUNK))
          }))
        this.domain.ledger.commit(
          read.revision,
          changes,
          nextClock,
          view => {
            this.authorized(nextGuard)(view)
            saved.checkCurrent(view)
          },
          { maximumBatchBytes: this.maximumBatchBytes() }
        )
      }
    }
    return plan
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Purchase evidence capability required')
  return () => owner[key] === method
}
