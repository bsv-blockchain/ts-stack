import {
  canonicalOutputJSONWithDirectRecords as canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  parseOutputServiceError
} from '@bsv/sdk'
import type { PrivatePurchaseCaller, PrivatePurchaseAccessPort } from './PrivatePurchasePorts.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type { OutputPurchaseEnvelope, OutputSignedPurchaseTerms } from '@bsv/sdk'
import type { PrivatePurchaseStoreOwner } from './SQLitePrivatePurchaseStore.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'

/** Common disclosure shape: each owner keeps its own native loaded type, phase,
 * format and custody checks. This does not erase or convert either owner's state. */
export interface PrivatePurchaseDisclosureOwner<Loaded> {
  load(
    id: string,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded | undefined
  disclose(
    loaded: Loaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (envelope: OutputPurchaseEnvelope) => void
  ): void
  discloseTerms(
    loaded: Loaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (terms: OutputSignedPurchaseTerms) => void
  ): void
}

/** Authenticate/sign prepared HTTP bytes first, then enqueue exactly once under
 * current native authority. Ordinary submit and BRC105 payment are untouched.
 */
export class PrivatePurchaseDisclosure<
  Loaded extends { custody: { original: PrivatePurchaseOriginal } } = NonNullable<
    ReturnType<PrivatePurchaseStoreOwner['load']>
  >
> {
  private readonly unchanged: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly store: PrivatePurchaseDisclosureOwner<Loaded>,
    private readonly contracts: PrivatePurchaseContracts,
    private readonly access: PrivatePurchaseAccessPort,
    private readonly clock: () => string,
    private readonly authorizeControl: (buyer: string) => boolean
  ) {
    outputAssert(typeof clock === 'function', 'Purchase disclosure clock is required')
    outputAssert(
      typeof authorizeControl === 'function' &&
        authorizeControl.constructor.name !== 'AsyncFunction',
      'Purchase control authority must be synchronous'
    )
    this.unchanged = [
      pin(domain, 'ledger'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'disclose'),
      pin(store, 'load'),
      pin(store, 'disclose'),
      pin(store, 'discloseTerms'),
      pin(contracts, 'restore'),
      pin(access, 'guard')
    ]
  }
  private caller(supplied: PrivatePurchaseCaller): PrivatePurchaseCaller {
    outputAssert(
      typeof supplied.current === 'function' &&
        supplied.current.constructor.name !== 'AsyncFunction',
      'Purchase disclosure requires current authentication'
    )
    return {
      buyer: outputIdentity(supplied.buyer),
      capability: outputHex32(supplied.capability),
      profile: outputString(supplied.profile),
      current: supplied.current,
      signal: supplied.signal
    }
  }
  private current(caller: PrivatePurchaseCaller): boolean {
    return (
      !caller.signal?.aborted &&
      this.unchanged.every(check => check()) &&
      permitted(caller.current()) &&
      !caller.signal?.aborted
    )
  }
  prepare(idInput: string, supplied: PrivatePurchaseCaller, options: { terms?: boolean } = {}) {
    return this.prepareCurrent(idInput, supplied, options)
  }
  /** Opt-in companion fence, evaluated against the SAME native view used to
   * decrypt and enqueue. It must not perform another ledger read. */
  prepareGuarded(
    idInput: string,
    supplied: PrivatePurchaseCaller,
    additional: ProtectedLedgerGuard,
    options: { terms?: boolean } = {}
  ) {
    outputAssert(
      typeof additional === 'function' && additional.constructor.name !== 'AsyncFunction',
      'Additional disclosure guard must be synchronous'
    )
    return this.prepareCurrent(idInput, supplied, options, additional)
  }
  private prepareCurrent(
    idInput: string,
    supplied: PrivatePurchaseCaller,
    options: { terms?: boolean },
    additional?: ProtectedLedgerGuard
  ) {
    const id = outputHex32(idInput),
      caller = this.caller(supplied),
      access = this.access.guard(id, caller.buyer, () => this.current(caller)),
      guard: ProtectedLedgerGuard =
        additional === undefined
          ? access
          : view => {
              access(view)
              if (additional) {
                const result: unknown = additional(view)
                if (result instanceof Promise) void result.catch(() => undefined)
                outputAssert(
                  result === undefined,
                  'Additional disclosure guard must finish synchronously',
                  'context-changed'
                )
                access(view)
              }
            },
      loaded = this.store.load(id, caller.buyer, this.clock, guard)
    outputAssert(loaded, 'Purchase not found', 'not-found')
    const selection = this.contracts.restore(loaded.custody.original.capability)
    outputAssert(
      caller.capability === selection.digest && caller.profile === selection.profile.id,
      'Original purchase selection differs',
      'context-changed'
    )
    const terms = options.terms === true
    let prepared: string | undefined
    const select = (result: unknown) => {
      prepared = canonicalOutputJSON(result, { bytes: selection.profile.maxResponseBytes })
    }
    if (terms) this.store.discloseTerms(loaded, caller.buyer, this.clock, guard, select)
    else this.store.disclose(loaded, caller.buyer, this.clock, guard, select)
    outputAssert(prepared !== undefined, 'Original purchase response unavailable', 'unavailable')
    const body = prepared,
      headers = Object.freeze({ ...selection.headers })
    let attempted = false
    return Object.freeze({
      body,
      headers,
      statusCode: 200,
      enqueue: (send: (body: string, headers: Readonly<Record<string, string>>) => void): void => {
        outputAssert(!attempted, 'Purchase disclosure was already attempted', 'conflict')
        outputAssert(
          typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
          'Purchase response enqueue must be synchronous'
        )
        attempted = true
        const enqueue = (current: unknown) => {
          outputAssert(
            canonicalOutputJSON(current, { bytes: selection.profile.maxResponseBytes }) === body,
            'Purchase response changed before enqueue',
            'conflict'
          )
          const result: unknown = send(body, headers)
          if (result instanceof Promise) void result.catch(() => undefined)
          outputAssert(result === undefined, 'Purchase response enqueue must finish synchronously')
        }
        if (terms) this.store.discloseTerms(loaded, caller.buyer, this.clock, guard, enqueue)
        else this.store.disclose(loaded, caller.buyer, this.clock, guard, enqueue)
      }
    })
  }
  enqueueControl(input: unknown, supplied: PrivatePurchaseCaller, send: () => void): void {
    const packet = parseOutputServiceError(input),
      caller = this.caller(supplied)
    outputAssert(
      canonicalOutputJSON(packet) ===
        canonicalOutputJSON({
          version: 1,
          error: {
            code: packet.error.code,
            message: 'Private purchase request ' + packet.error.code,
            retryable: packet.error.retryable
          }
        }),
      'Purchase control requires fixed public diagnostics'
    )
    outputAssert(
      typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
      'Purchase control enqueue must be synchronous'
    )
    const guard = () => {
      outputAssert(
        this.current(caller) &&
          permitted(this.authorizeControl(caller.buyer)) &&
          this.current(caller),
        'Purchase control authority changed',
        'unauthorized'
      )
    }
    const address = this.domain.identity.address('rules', {
        purpose: 'private-purchase-control/1'
      }),
      read = this.domain.ledger.read([address], this.clock, guard)
    this.domain.ledger.disclose(read.revision, [address], this.clock, guard, () => {
      const result: unknown = send()
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(result === undefined, 'Purchase control enqueue must finish synchronously')
    })
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const value = owner[key]
  return () => owner[key] === value
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
