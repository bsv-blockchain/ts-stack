import {
  Beef,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputPrivatePublish,
  Transaction,
  Utils,
  type OutputPrivatePublish
} from '@bsv/sdk'
import { privatePublicationFenceAddress } from './PrivatePublicationRecords.js'
import { privateLookupBindingReceipt } from './PrivateLookupBinding.js'
import { parsePrivatePublicationProgress } from './PrivatePublicationProgress.js'
import type { ProtectedLedgerGuard, ProtectedLedgerView } from './ProtectedLedgerCodec.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  PrivatePublicationStore,
  PrivatePublicationStorageSnapshot
} from './PrivatePublicationPorts.js'
import type { PrivatePublicationPublicReference } from './PrivatePublicationAccess.js'

/** Constructed only by trusted authenticated transport; never decoded from lookup query fields. */
export interface PrivatePublicationLookupCaller {
  recipient: string
  current(): boolean
  signal?: AbortSignal
}
export interface PrivatePublicationLookupContextOptions {
  domain: PrivateServiceDomain
  store: Pick<PrivatePublicationStore, 'loadVerified'>
  topic: string
  lookup: { service: string; rulesDigest: string }
  clock(): string
  /** Current installed recipient ACL/entitlement, checked before private bytes are read. */
  authorize(
    reference: PrivatePublicationPublicReference,
    recipient: string,
    publisher: string,
    view: ProtectedLedgerView
  ): boolean
  /** Bounded synchronous pure mapping, with owned copies; no payments or external effects. */
  mapContext(
    privateValues: Uint8Array,
    reference: PrivatePublicationPublicReference,
    recipient: string
  ): Uint8Array
  maximumContextBytes: number
  maximumResponseBytes: number
  supportedExtensions?: readonly string[]
}

/**
 * Opt-in read companion for the original private overlay primitive. A request-local
 * private LookupService receives formula() and the ordinary Engine hydrates BEEF.
 * bind() checks its exact answer; after HTTP signing enqueue() rechecks the original
 * protected records and current recipient authority under the native writer gate.
 * It grants neither payment entitlement nor Bitcoin unspentness by itself. Public
 * catalogues, replay indexes and GASP never receive formula()'s private context.
 */
export class PrivatePublicationLookupContext {
  private readonly options: PrivatePublicationLookupContextOptions
  private readonly unchanged: readonly (() => boolean)[]
  constructor(options: PrivatePublicationLookupContextOptions) {
    for (const callback of [options.clock, options.authorize, options.mapContext])
      outputAssert(
        typeof callback === 'function' && callback.constructor.name !== 'AsyncFunction',
        'Private lookup callbacks must be synchronous'
      )
    for (const [value, maximum] of [
      [options.maximumContextBytes, 1048576],
      [options.maximumResponseBytes, 4194304]
    ])
      outputAssert(
        Number.isSafeInteger(value) && value > 0 && value <= maximum,
        'Invalid private lookup byte capacity'
      )
    this.options = {
      ...options,
      topic: outputString(options.topic),
      lookup: {
        service: outputString(options.lookup.service),
        rulesDigest: outputHex32(options.lookup.rulesDigest)
      },
      supportedExtensions: [...(options.supportedExtensions ?? [])]
    }
    const { domain, store } = options
    this.unchanged = [
      pin(domain, 'ledger'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'disclose'),
      pin(store, 'loadVerified')
    ]
  }

  prepare(publicationId: string, supplied: PrivatePublicationLookupCaller) {
    const id = outputHex32(publicationId),
      caller = {
        recipient: outputIdentity(supplied.recipient),
        current: supplied.current,
        signal: supplied.signal
      }
    outputAssert(
      typeof caller.current === 'function' && caller.current.constructor.name !== 'AsyncFunction',
      'Private lookup needs current authenticated context'
    )
    const guard = this.guard(id, caller),
      snapshot = this.options.store.loadVerified(id, this.options.clock, guard)
    outputAssert(snapshot, 'Private lookup unavailable', 'not-found')
    this.checkSnapshot(snapshot)
    const reference = this.reference(snapshot.fence.reference),
      privateValues = new Uint8Array(decodeOutputBytes(snapshot.blob.privateValues))
    let context: Uint8Array
    try {
      const mapped: unknown = this.options.mapContext(
        privateValues,
        structuredClone(reference),
        caller.recipient
      )
      if (mapped instanceof Promise) void mapped.catch(() => undefined)
      outputAssert(
        mapped instanceof Uint8Array && mapped.length <= this.options.maximumContextBytes,
        'Private lookup context mapping exceeds its contract',
        'limited'
      )
      context = new Uint8Array(mapped)
    } finally {
      privateValues.fill(0)
    }
    const original = records(snapshot),
      addresses = [
        privatePublicationFenceAddress(this.options.domain.identity, id),
        { kind: 'publication' as const, key: snapshot.fence.state.blobKey },
        { kind: snapshot.bindingRecord.kind, key: snapshot.bindingRecord.key }
      ]
    let disposed = false,
      bound = false
    const active = () => outputAssert(!disposed, 'Private lookup preparation disposed', 'cancelled')
    return Object.freeze({
      formula: () => {
        active()
        return [
          {
            txid: snapshot.fence.state.txid,
            outputIndex: snapshot.fence.state.outputIndex,
            context: Array.from(context)
          }
        ]
      },
      dispose: () => {
        disposed = true
        context.fill(0)
      },
      bind: (answer: unknown) => {
        active()
        outputAssert(!bound, 'Private lookup answer already bound', 'conflict')
        const body = this.answer(answer, snapshot, context),
          headers = Object.freeze({
            'content-type': 'application/json',
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff'
          })
        bound = true
        let attempted = false
        return Object.freeze({
          body,
          headers,
          enqueue: (
            send: (body: string, headers: Readonly<Record<string, string>>) => void
          ): void => {
            active()
            outputAssert(!attempted, 'Private lookup enqueue already attempted', 'conflict')
            outputAssert(
              typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
              'Private lookup enqueue must be synchronous'
            )
            attempted = true
            this.options.domain.ledger.disclose(
              snapshot.revision,
              addresses,
              this.options.clock,
              guard,
              current => {
                outputAssert(
                  current.every(
                    (record, index) =>
                      record !== undefined &&
                      canonicalOutputJSON(index === 1 ? record.value : record) === original[index]
                  ),
                  'Private lookup original records changed',
                  'conflict'
                )
                const result: unknown = send(body, headers)
                if (result instanceof Promise) void result.catch(() => undefined)
                outputAssert(
                  result === undefined,
                  'Private lookup enqueue must complete synchronously'
                )
              }
            )
          }
        })
      }
    })
  }

  private reference(input: unknown): PrivatePublicationPublicReference {
    const value = parseOutputJSON(canonicalOutputJSON(input))
    closedOutputObject(
      value,
      ['version', 'requestId', 'topic', 'evidence', 'assetId', 'schema'],
      ['extensions', 'critical']
    )
    const reference: Partial<OutputPrivatePublish> = parseOutputPrivatePublish(
      { ...value, privateValues: '' },
      this.options.supportedExtensions
    )
    delete reference.privateValues
    return reference as PrivatePublicationPublicReference
  }
  private guard(id: string, caller: PrivatePublicationLookupCaller): ProtectedLedgerGuard {
    const { domain, authorize, topic } = this.options,
      address = privatePublicationFenceAddress(domain.identity, id)
    const current = () =>
      !caller.signal?.aborted &&
      this.unchanged.every(check => check()) &&
      permitted(caller.current()) &&
      !caller.signal?.aborted
    return view => {
      outputAssert(current(), 'Private lookup unavailable', 'not-found')
      const record = view.get(address)
      if (!record) throw missing()
      const state = parsePrivatePublicationProgress(record.value.state)
      const reference = this.reference(record.value.reference),
        publisher = outputIdentity(state.publisher)
      outputAssert(
        state.publicationId === id &&
          state.topic === topic &&
          reference.topic === topic &&
          canonicalOutputJSON(state.chain) === canonicalOutputJSON(domain.scope.chain) &&
          outputPacketDigest('private-publication', {
            chain: domain.scope.chain,
            publisher,
            topic,
            requestId: reference.requestId
          }) === id,
        'Private lookup retained binding differs',
        'unavailable'
      )
      if (
        !permitted(authorize(structuredClone(reference), caller.recipient, publisher, view)) ||
        !current()
      )
        throw missing()
      const progress = state.progress
      outputAssert(
        progress !== null &&
          typeof progress === 'object' &&
          !Array.isArray(progress) &&
          progress.phase === 'ready',
        'Private lookup unavailable',
        'not-found'
      )
    }
  }
  private checkSnapshot(snapshot: PrivatePublicationStorageSnapshot): void {
    const { state } = snapshot.fence
    outputAssert(
      state.lookup.service === this.options.lookup.service &&
        state.lookup.rulesDigest === this.options.lookup.rulesDigest &&
        state.progress.phase === 'ready',
      'Private lookup installation differs',
      'unavailable'
    )
    privateLookupBindingReceipt(
      snapshot.binding,
      state,
      snapshot.blob,
      this.options.domain.identity
    )
  }
  private answer(
    input: unknown,
    snapshot: PrivatePublicationStorageSnapshot,
    context: Uint8Array
  ): string {
    const body = canonicalOutputJSON(input, { bytes: this.options.maximumResponseBytes }),
      answer = parseOutputJSON(body)
    closedOutputObject(answer, ['type', 'outputs'])
    outputAssert(
      answer.type === 'output-list' && Array.isArray(answer.outputs) && answer.outputs.length === 1,
      'Private lookup requires one exact output'
    )
    const row = answer.outputs[0]
    closedOutputObject(row, ['beef', 'outputIndex', 'context'], ['txid'])
    const bytes = byteArray(row.beef, this.options.maximumResponseBytes),
      material = byteArray(row.context, this.options.maximumContextBytes),
      state = snapshot.fence.state
    outputAssert(
      row.outputIndex === state.outputIndex &&
        (row.txid === undefined || row.txid === state.txid) &&
        material.length === context.length &&
        material.every((value, index) => value === context[index]),
      'Private lookup answer context or output differs'
    )
    const beef = Beef.fromBinary(Array.from(bytes))
    outputAssert(
      beef.atomicTxid === undefined || beef.atomicTxid === state.txid,
      'Private lookup Atomic BEEF subject differs'
    )
    const transaction = beef.findTxid(state.txid)?.tx
    outputAssert(
      transaction &&
        Utils.toBase64(transaction.toBinary()) === snapshot.original.rawTransaction &&
        Transaction.fromBinary(transaction.toBinary()).id('hex') === state.txid,
      'Private lookup hydrated raw subject differs'
    )
    return body
  }
}
function records(snapshot: PrivatePublicationStorageSnapshot): string[] {
  return [snapshot.record, snapshot.blob, snapshot.bindingRecord].map(record =>
    canonicalOutputJSON(record)
  )
}
function byteArray(input: unknown, maximum: number): Uint8Array {
  outputAssert(
    Array.isArray(input) &&
      input.length <= maximum &&
      input.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 255),
    'Invalid private lookup byte array'
  )
  return Uint8Array.from(input)
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Private lookup unavailable')
}
