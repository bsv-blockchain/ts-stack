import {
  canonicalOutputJSONWithDirectRecords as canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputPacketDigestWithInlineStrings as outputPacketDigest,
  outputU64,
  ownOutputJSONWithCountedRecords as ownOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import {
  ownPrivatePurchaseAdmissionOutcome,
  type PrivatePurchaseAdmissionOutcome
} from './PrivatePurchasePorts.js'
import { privatePurchaseOperation } from './PrivatePurchaseProgress.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import {
  protectedInteger,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'

const FORMAT = 'private-purchase-admission-journal/1'
export type PrivatePurchaseAdmissionJournalEvent =
  | { type: 'intent'; txid: string; operationId: string }
  | { type: 'outcome'; outcome: Exclude<PrivatePurchaseAdmissionOutcome, { status: 'unresolved' }> }
  | { type: 'recovery'; txid: string; operationId: string; eligibilityId: string }
export interface PrivatePurchaseAdmissionJournalEntry {
  event: PrivatePurchaseAdmissionJournalEvent
  observedAt: string
}
export interface PrivatePurchaseAdmissionJournalPlan {
  revision: string
  changes(view: ProtectedLedgerView): readonly ProtectedLedgerChange[]
  checkCurrent: ProtectedLedgerGuard
}

/** Explicit protected companion. Every event and every outstanding completion
 * is prepaid before signed terms leave the service. Alias eviction cannot erase
 * an operation or rejection. This journal grants no Bitcoin, policy or admission
 * authority, and never reopens or migrates historical alias installations. */
export class SQLitePrivatePurchaseAdmissionJournal {
  readonly id: string
  private readonly maximumEvents: number
  private readonly eventBytes = 131072 + 8192
  private readonly ledger: PrivateServiceDomain['ledger']
  private readonly identity: PrivateServiceDomain['identity']
  private readonly installedId: string
  private readonly pins: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePurchaseContracts,
    maximumEvents: number
  ) {
    this.maximumEvents = protectedInteger(maximumEvents, 60)
    outputAssert(this.maximumEvents >= 4, 'Admission journal requires completion capacity')
    this.ledger = domain.ledger
    this.identity = domain.identity
    this.id = outputPacketDigest('purchase', {
      purpose: FORMAT,
      scope: domain.scope,
      maximumEvents: this.maximumEvents
    })
    this.installedId = this.id
    this.pins = [
      pin(this.ledger, 'read'),
      pin(this.ledger, 'commit'),
      pin(this.identity, 'address'),
      pin(contracts, 'original')
    ]
  }
  installedOn(domain: PrivateServiceDomain, contracts: PrivatePurchaseContracts): void {
    this.current()
    outputAssert(
      domain === this.domain && contracts === this.contracts,
      'Admission journal differs from its physical purchase owner',
      'context-changed'
    )
  }
  private current(): void {
    outputAssert(
      this.id === this.installedId &&
        this.domain.ledger === this.ledger &&
        this.domain.identity === this.identity &&
        this.pins.every(check => check()),
      'Admission journal installation changed',
      'context-changed'
    )
  }
  private authorized(guard: ProtectedLedgerGuard): ProtectedLedgerGuard {
    outputAssert(
      typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
      'Admission journal guard must be synchronous'
    )
    return view => {
      this.current()
      const result: unknown = guard(view)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(result === undefined, 'Admission journal guard changed', 'context-changed')
      this.current()
    }
  }
  private binding(input: PrivatePurchaseOriginal): OutputJSONObject {
    this.current()
    const original = this.contracts.original(input)
    return {
      owner: this.id,
      acquisitionId: original.terms.body.acquisitionId,
      // The effect owner records createdAt in its later committing writer.
      // Reserve against the complete signed promise, not that local observation.
      originalDigest: outputPacketDigest('purchase', {
        request: original.request,
        terms: original.terms,
        capability: original.capability
      })
    }
  }
  private addresses(binding: OutputJSONObject) {
    return Array.from({ length: this.maximumEvents + 1 }, (_, index) =>
      this.identity.address('admission', {
        purpose: FORMAT,
        acquisitionId: binding.acquisitionId,
        index
      })
    )
  }
  reserve(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): void {
    const binding = this.binding(original),
      addresses = this.addresses(binding),
      read = this.ledger.read(addresses, clock, this.authorized(guard))
    if (read.records[0]) {
      this.read(original, clock, guard)
      return
    }
    outputAssert(
      read.records.every(row => row === undefined),
      'Admission journal reservation is partial',
      'unavailable'
    )
    const changes: ProtectedLedgerChange[] = addresses.map(
      (address, index): ProtectedLedgerChange => ({
        ...address,
        expectedRevision: null,
        reservedBytes: index === 0 ? 8192 : this.eventBytes,
        reservedUpdates: index === 0 ? this.maximumEvents : 1,
        value:
          index === 0
            ? { format: FORMAT, binding, next: 0 }
            : { format: FORMAT, binding, index: index - 1, entry: null }
      })
    )
    this.ledger.commit(read.revision, changes, clock, this.authorized(guard), {
      maximumBatchBytes: 8192 + this.maximumEvents * (this.eventBytes + 1024)
    })
  }
  private event(
    input: unknown,
    original: PrivatePurchaseOriginal
  ): PrivatePurchaseAdmissionJournalEvent {
    const owned = ownOutputJSON(input, { bytes: this.eventBytes }).value
    closedOutputObject(owned, ['type'], ['txid', 'operationId', 'eligibilityId', 'outcome'])
    if (owned.type === 'outcome') {
      closedOutputObject(owned, ['type', 'outcome'])
      const outcome = ownPrivatePurchaseAdmissionOutcome(owned.outcome)
      outputAssert(
        outcome.status !== 'unresolved',
        'Unknown admission is not a terminal journal outcome'
      )
      outputAssert(
        outcome.operationId === privatePurchaseOperation(original, outcome.txid),
        'Journal outcome changes its original admission operation'
      )
      return { type: 'outcome', outcome }
    }
    outputAssert(
      owned.type === 'intent' || owned.type === 'recovery',
      'Unsupported admission journal event',
      'unsupported'
    )
    closedOutputObject(owned, [
      'type',
      'txid',
      'operationId',
      ...(owned.type === 'recovery' ? ['eligibilityId'] : [])
    ])
    const txid = outputHex32(owned.txid),
      operationId = outputHex32(owned.operationId)
    outputAssert(
      operationId === privatePurchaseOperation(original, txid),
      'Journal intent changes its original admission operation'
    )
    return owned.type === 'intent'
      ? { type: 'intent', txid, operationId }
      : { type: 'recovery', txid, operationId, eligibilityId: outputHex32(owned.eligibilityId) }
  }
  private states(entries: readonly PrivatePurchaseAdmissionJournalEntry[]) {
    const states = new Map<string, 'pending' | 'admitted' | 'rejected'>()
    const recoveries = new Set<string>()
    for (const { event } of entries) {
      const txid = event.type === 'outcome' ? event.outcome.txid : event.txid,
        prior = states.get(txid)
      if (event.type === 'intent') {
        outputAssert(prior === undefined, 'Journal cannot restart a retained operation', 'conflict')
        states.set(txid, 'pending')
      } else if (event.type === 'outcome') {
        outputAssert(prior === 'pending', 'Journal outcome lacks its durable intent', 'conflict')
        states.set(txid, event.outcome.status)
      } else {
        const key = `${txid}:${event.eligibilityId}`
        outputAssert(
          prior === 'rejected' && !recoveries.has(key),
          'Unchanged or ineligible recovery cannot restart rejected work',
          'conflict'
        )
        recoveries.add(key)
        states.set(txid, 'pending')
      }
    }
    return { states, recoveries }
  }
  private snapshot(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ) {
    const binding = this.binding(original),
      addresses = this.addresses(binding),
      read = this.ledger.read(addresses, clock, this.authorized(guard))
    outputAssert(
      read.records.every(row => row !== undefined),
      'Admission journal custody is missing',
      'unavailable'
    )
    const records = read.records.map(row => row!),
      header = records[0].value
    closedOutputObject(header, ['format', 'binding', 'next'])
    outputAssert(
      header.format === FORMAT &&
        canonicalOutputJSON(header.binding) === canonicalOutputJSON(binding) &&
        typeof header.next === 'number' &&
        Number.isSafeInteger(header.next) &&
        header.next >= 0 &&
        header.next <= this.maximumEvents &&
        records[0].reservedBytes === 8192 &&
        records[0].reservedUpdates === this.maximumEvents - header.next,
      'Admission journal header or capacity differs',
      'unavailable'
    )
    const next = header.next,
      entries: PrivatePurchaseAdmissionJournalEntry[] = []
    let previous = outputU64(original.createdAt)
    for (let index = 0; index < this.maximumEvents; index++) {
      const row = records[index + 1],
        value = row.value
      closedOutputObject(value, ['format', 'binding', 'index', 'entry'])
      outputAssert(
        value.format === FORMAT &&
          canonicalOutputJSON(value.binding) === canonicalOutputJSON(binding) &&
          value.index === index &&
          row.reservedBytes === this.eventBytes &&
          row.reservedUpdates === (index < next ? 0 : 1),
        'Admission journal slot or capacity differs',
        'unavailable'
      )
      if (index >= next) {
        outputAssert(value.entry === null, 'Unused journal slot is occupied', 'unavailable')
        continue
      }
      closedOutputObject(value.entry, ['event', 'observedAt'])
      const event = this.event(value.entry.event, original),
        observedAt = outputU64(value.entry.observedAt)
      outputAssert(
        observedAt >= previous &&
          observedAt <= outputU64(read.observedAt) &&
          (event.type !== 'outcome' ||
            event.outcome.status !== 'admitted' ||
            outputU64(event.outcome.acceptedAt) <= observedAt),
        'Admission journal time differs',
        'unavailable'
      )
      previous = observedAt
      entries.push({ event, observedAt: observedAt.toString() })
    }
    const state = this.states(entries)
    outputAssert(
      this.maximumEvents - next >=
        [...state.states.values()].filter(status => status === 'pending').length,
      'Admission journal lacks outstanding completion capacity',
      'unavailable'
    )
    const checkCurrent: ProtectedLedgerGuard = view => {
      this.authorized(guard)(view)
      outputAssert(
        view.revision === read.revision &&
          addresses.every(
            (address, index) => view.get(address)?.revision === records[index].revision
          ),
        'Admission journal changed before effect',
        'conflict'
      )
    }
    return {
      binding,
      addresses,
      records,
      entries,
      next,
      state,
      revision: read.revision,
      checkCurrent
    }
  }
  read(original: PrivatePurchaseOriginal, clock: () => string, guard: ProtectedLedgerGuard) {
    const saved = this.snapshot(original, clock, guard)
    return { entries: structuredClone(saved.entries), checkCurrent: saved.checkCurrent }
  }
  prepare(
    original: PrivatePurchaseOriginal,
    input: PrivatePurchaseAdmissionJournalEvent,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAdmissionJournalPlan {
    const event = this.event(input, original),
      saved = this.snapshot(original, clock, guard),
      recoveryUntil =
        event.type === 'recovery' ? outputU64(original.terms.body.recoveryUntil) : undefined,
      next = saved.next + 1,
      state = this.states([...saved.entries, { event, observedAt: '0' }])
    outputAssert(
      next <= this.maximumEvents &&
        this.maximumEvents - next >=
          [...state.states.values()].filter(status => status === 'pending').length,
      'Admission journal must preserve every outstanding completion',
      'limited'
    )
    if (recoveryUntil !== undefined)
      outputAssert(
        outputU64(clock()) < recoveryUntil,
        'Unadmitted recovery promise elapsed',
        'limited'
      )
    return Object.freeze({
      revision: saved.revision,
      checkCurrent: saved.checkCurrent,
      changes: (view: ProtectedLedgerView): readonly ProtectedLedgerChange[] => {
        saved.checkCurrent(view)
        if (recoveryUntil !== undefined)
          outputAssert(
            outputU64(view.observedAt) < recoveryUntil,
            'Unadmitted recovery promise elapsed',
            'limited'
          )
        const observedAt = outputU64(view.observedAt).toString()
        outputAssert(
          event.type !== 'outcome' ||
            event.outcome.status !== 'admitted' ||
            outputU64(event.outcome.acceptedAt) <= outputU64(observedAt),
          'Admission acceptance follows its native journal time',
          'context-changed'
        )
        return [
          {
            ...saved.addresses[0],
            expectedRevision: saved.records[0].revision,
            reservedBytes: 8192,
            reservedUpdates: this.maximumEvents - next,
            value: { format: FORMAT, binding: structuredClone(saved.binding), next }
          },
          {
            ...saved.addresses[next],
            expectedRevision: saved.records[next].revision,
            reservedBytes: this.eventBytes,
            reservedUpdates: 0,
            value: {
              format: FORMAT,
              binding: structuredClone(saved.binding),
              index: saved.next,
              entry: { event: structuredClone(event) as unknown as OutputJSONObject, observedAt }
            }
          }
        ]
      }
    })
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Admission journal method is required')
  return () => owner[key] === method
}
