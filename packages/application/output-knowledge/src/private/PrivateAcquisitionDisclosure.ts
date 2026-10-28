import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  parseOutputServiceError
} from '@bsv/sdk'
import type { PrivateAcquisitionCaller } from './PrivateAcquisitionPorts.js'
import type { SQLitePrivateAcquisitionStore } from './SQLitePrivateAcquisitionStore.js'
import type { PrivateAcquisitionContracts } from './PrivateAcquisitionContracts.js'
import type { PrivateAcquisitionAccess } from './PrivateAcquisitionAccess.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'

/** Sign prepared bytes, then enqueue exactly once under the current native authorization gate. */
export class PrivateAcquisitionDisclosure {
  private readonly unchanged: readonly (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly store: Pick<SQLitePrivateAcquisitionStore, 'load' | 'disclose'>,
    private readonly contracts: PrivateAcquisitionContracts,
    private readonly access: Pick<PrivateAcquisitionAccess, 'guard'>,
    private readonly clock: () => string,
    private readonly authorizeControl: (buyer: string) => boolean
  ) {
    outputAssert(typeof clock === 'function', 'Acquisition disclosure clock is required')
    outputAssert(
      typeof authorizeControl === 'function' &&
        authorizeControl.constructor.name !== 'AsyncFunction',
      'Acquisition control authority must be synchronous'
    )
    this.unchanged = [
      pin(domain, 'ledger'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'disclose'),
      pin(store, 'load'),
      pin(store, 'disclose'),
      pin(contracts, 'restore'),
      pin(access, 'guard')
    ]
  }
  private caller(supplied: PrivateAcquisitionCaller): PrivateAcquisitionCaller {
    outputAssert(
      typeof supplied.current === 'function' &&
        supplied.current.constructor.name !== 'AsyncFunction',
      'Acquisition disclosure requires current authentication'
    )
    return {
      buyer: outputIdentity(supplied.buyer),
      capability: outputHex32(supplied.capability),
      profile: outputString(supplied.profile),
      current: supplied.current,
      signal: supplied.signal
    }
  }
  private current(caller: PrivateAcquisitionCaller): boolean {
    return (
      !caller.signal?.aborted &&
      this.unchanged.every(check => check()) &&
      permitted(caller.current()) &&
      !caller.signal?.aborted
    )
  }
  prepare(
    acquisitionId: string,
    supplied: PrivateAcquisitionCaller,
    options: { challenge?: boolean } = {}
  ) {
    const id = outputHex32(acquisitionId),
      caller = this.caller(supplied)
    const guard = this.access.guard(id, caller.buyer, () => this.current(caller))
    const retained = this.store.load(id, caller.buyer, this.clock, guard)
    outputAssert(retained, 'Acquisition not found', 'not-found')
    const selection = this.contracts.restore(retained.original.capability)
    outputAssert(
      caller.capability === selection.digest && caller.profile === selection.profile.id,
      'Original acquisition selection differs',
      'context-changed'
    )
    const challenge =
      options.challenge === true &&
      retained.state.progress.phase === 'quoted' &&
      retained.state.progress.candidate === null &&
      outputU64(this.clock()) < outputU64(retained.original.challenge.payableUntil)
    const statusCode = challenge ? 402 : 200
    const responseBody = (
      response: Parameters<Parameters<SQLitePrivateAcquisitionStore['disclose']>[4]>[0]
    ) =>
      canonicalOutputJSON(challenge ? response.challenge : response, {
        bytes: selection.profile.maxResponseBytes
      })
    let body: string | undefined
    this.store.disclose(retained, caller.buyer, this.clock, guard, response => {
      body = responseBody(response)
    })
    outputAssert(body !== undefined, 'Acquisition response is unavailable', 'unavailable')
    const ownedBody = body,
      headers = Object.freeze({
        ...selection.headers,
        ...(challenge
          ? {
              'x-bsv-payment-version': '1.0',
              'x-bsv-payment-satoshis-required': retained.original.challenge.satoshis,
              'x-bsv-payment-derivation-prefix': retained.original.challenge.derivationPrefix
            }
          : {})
      })
    let attempted = false
    return Object.freeze({
      body: ownedBody,
      headers,
      statusCode,
      enqueue: (send: (body: string, headers: Readonly<Record<string, string>>) => void): void => {
        outputAssert(!attempted, 'Acquisition disclosure was already attempted', 'conflict')
        outputAssert(
          typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
          'Acquisition response enqueue must be synchronous'
        )
        attempted = true
        this.store.disclose(retained, caller.buyer, this.clock, guard, response => {
          if (challenge)
            outputAssert(
              outputU64(this.clock()) < outputU64(retained.original.challenge.payableUntil),
              'Acquisition construction deadline elapsed before challenge enqueue',
              'expired'
            )
          outputAssert(
            responseBody(response) === ownedBody,
            'Acquisition response changed before enqueue',
            'conflict'
          )
          const result: unknown = send(ownedBody, headers)
          if (result instanceof Promise) void result.catch(() => undefined)
          outputAssert(
            result === undefined,
            'Acquisition response enqueue must finish synchronously'
          )
        })
      }
    })
  }
  enqueueControl(input: unknown, supplied: PrivateAcquisitionCaller, send: () => void): void {
    const packet = parseOutputServiceError(input),
      caller = this.caller(supplied)
    outputAssert(
      canonicalOutputJSON(packet) ===
        canonicalOutputJSON({
          version: 1,
          error: {
            code: packet.error.code,
            message: 'Private acquisition request ' + packet.error.code,
            retryable: packet.error.retryable
          }
        }),
      'Acquisition control must use fixed public diagnostics'
    )
    outputAssert(
      typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
      'Acquisition control enqueue must be synchronous'
    )
    const guard = () => {
      outputAssert(
        this.current(caller) &&
          permitted(this.authorizeControl(caller.buyer)) &&
          this.current(caller),
        'Acquisition control authority changed',
        'unauthorized'
      )
    }
    const address = this.domain.identity.address('rules', {
      purpose: 'private-acquisition-control/1'
    })
    const read = this.domain.ledger.read([address], this.clock, guard)
    this.domain.ledger.disclose(read.revision, [address], this.clock, guard, () => {
      const result: unknown = send()
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(result === undefined, 'Acquisition control enqueue must finish synchronously')
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
