import {
  canonicalOutputJSONWithInlineStrings as canonicalOutputJSON,
  outputAssert,
  outputHex32,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputPurchaseEnvelope
} from '@bsv/sdk'
import type { PrivatePurchaseCaller } from './PrivatePurchasePorts.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type { PrivatePurchaseAliasRecoveryReport } from './PrivatePurchaseAliasCoordinator.js'

interface PreparedPurchaseResponse {
  readonly statusCode: 200
  readonly body: string
  readonly headers: Readonly<Record<string, string>>
  enqueue(send: (body: string, headers: Readonly<Record<string, string>>) => void): void
}
export interface PrivatePurchaseAliasDisclosureBase {
  prepare(
    id: string,
    caller: PrivatePurchaseCaller,
    options?: { terms?: boolean }
  ): PreparedPurchaseResponse
  prepareGuarded(
    id: string,
    caller: PrivatePurchaseCaller,
    additional: ProtectedLedgerGuard,
    options?: { terms?: boolean }
  ): PreparedPurchaseResponse
  enqueueControl(input: unknown, caller: PrivatePurchaseCaller, send: () => void): void
}
export interface PrivatePurchaseAliasReports {
  currentAlias(
    id: string,
    caller: PrivatePurchaseCaller
  ): Promise<PrivatePurchaseAliasRecoveryReport | undefined>
}

/** Explicit HTTP companion. The native disclosure keeps historical custody,
 * authentication and one synchronous enqueue. Fresh chain evidence is optional
 * and is fenced inside that SAME native view. It is never release evidence.
 * No report, secret, chain verdict or result is cached between requests. */
export class PrivatePurchaseAliasDisclosure {
  private readonly prepareOriginal: PrivatePurchaseAliasDisclosureBase['prepare']
  private readonly prepareGuarded: PrivatePurchaseAliasDisclosureBase['prepareGuarded']
  private readonly controlOriginal: PrivatePurchaseAliasDisclosureBase['enqueueControl']
  private readonly assess: PrivatePurchaseAliasReports['currentAlias']
  constructor(
    private readonly base: PrivatePurchaseAliasDisclosureBase,
    private readonly reports: PrivatePurchaseAliasReports
  ) {
    outputAssert(
      typeof base.prepare === 'function' &&
        typeof base.prepareGuarded === 'function' &&
        typeof base.enqueueControl === 'function' &&
        typeof reports.currentAlias === 'function',
      'Alias disclosure requires installed native and currentness owners'
    )
    this.prepareOriginal = base.prepare
    this.prepareGuarded = base.prepareGuarded
    this.controlOriginal = base.enqueueControl
    this.assess = reports.currentAlias
  }
  private installed(): void {
    outputAssert(
      this.base.prepare === this.prepareOriginal &&
        this.base.prepareGuarded === this.prepareGuarded &&
        this.base.enqueueControl === this.controlOriginal &&
        this.reports.currentAlias === this.assess,
      'Alias disclosure owner changed',
      'context-changed'
    )
  }
  prepare(
    id: string,
    caller: PrivatePurchaseCaller,
    options: { terms?: boolean } = {}
  ): PreparedPurchaseResponse {
    this.installed()
    return this.prepareOriginal.call(this.base, id, caller, options)
  }
  async prepareAsync(
    idInput: string,
    caller: PrivatePurchaseCaller,
    options: { terms?: boolean } = {}
  ): Promise<PreparedPurchaseResponse> {
    const id = outputHex32(idInput)
    this.installed()
    if (options.terms === true) return this.prepare(id, caller, options)
    let report: PrivatePurchaseAliasRecoveryReport | undefined
    try {
      report = await this.assess.call(this.reports, id, caller)
    } catch (error) {
      // A previously retained alias may be invalid in this selected ancestry
      // after a fork. Failure of this OPTIONAL assessment cannot retract an
      // independently owned historical grant. The original preparation below
      // still checks native custody/authentication; no invalid report is sent.
      if (
        !optionalReportUnavailable(error) &&
        !(error instanceof OutputProtocolError && error.code === 'invalid')
      )
        throw error
    }
    this.installed()
    const historical = this.prepare(id, caller, options)
    if (!report) return historical
    const alias = Object.getOwnPropertyDescriptor(report, 'currentAlias')
    if (alias === undefined || !('value' in alias) || alias.value === undefined) return historical
    const guard = Object.getOwnPropertyDescriptor(report, 'guard')?.value
    outputAssert(
      typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
      'Alias disclosure requires an owned synchronous native guard'
    )
    const maximum: unknown = Object.getOwnPropertyDescriptor(report, 'maximumResponseBytes')?.value
    outputAssert(
      typeof maximum === 'number' &&
        Number.isSafeInteger(maximum) &&
        maximum > 0 &&
        maximum <= 4194304,
      'Alias report response allowance is invalid'
    )
    const original = parseOutputPurchaseEnvelope(
      parseOutputJSON(historical.body, { bytes: maximum })
    )
    outputAssert(
      Object.getOwnPropertyDescriptor(report, 'acquisitionId')?.value === id &&
        original.result.acquisitionId === id &&
        'purchaseCommitment' in original.result &&
        original.result.purchaseCommitment ===
          Object.getOwnPropertyDescriptor(report, 'purchaseCommitment')?.value,
      'Alias report changes original purchase identity',
      'conflict'
    )
    const fence: ProtectedLedgerGuard = view => {
      this.installed()
      outputAssert(
        Object.getOwnPropertyDescriptor(report!, 'guard')?.value === guard,
        'Alias report guard changed',
        'context-changed'
      )
      const result: unknown = guard.call(report, view)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined,
        'Alias report guard must finish synchronously',
        'context-changed'
      )
    }
    let prepared: PreparedPurchaseResponse, body: string
    try {
      const envelope = parseOutputPurchaseEnvelope({
        ...original,
        currentAlias: alias.value
      })
      body = canonicalOutputJSON(envelope, { bytes: maximum })
      prepared = this.prepareGuarded.call(this.base, id, caller, fence, options)
      outputAssert(
        prepared.body === historical.body,
        'Historical response changed during alias preparation',
        'conflict'
      )
    } catch (error) {
      // A missing, changed or oversized optional report does not re-gate the
      // historical grant. This fallback has ONLY the original native guard.
      if (!optionalReportUnavailable(error)) throw error
      return historical
    }
    let attempted = false
    return Object.freeze({
      statusCode: 200 as const,
      body,
      headers: prepared.headers,
      enqueue: (send: (body: string, headers: Readonly<Record<string, string>>) => void): void => {
        outputAssert(!attempted, 'Alias disclosure was already attempted', 'conflict')
        attempted = true
        this.installed()
        prepared.enqueue((current, headers) => {
          outputAssert(
            current === historical.body,
            'Historical response changed before alias enqueue',
            'conflict'
          )
          outputAssert(
            typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
            'Alias response enqueue must be synchronous'
          )
          const result: unknown = send(body, headers)
          if (result instanceof Promise) void result.catch(() => undefined)
          outputAssert(result === undefined, 'Alias response enqueue must finish synchronously')
        })
      }
    })
  }
  enqueueControl(input: unknown, caller: PrivatePurchaseCaller, send: () => void): void {
    this.installed()
    this.controlOriginal.call(this.base, input, caller, send)
  }
}
function optionalReportUnavailable(error: unknown): boolean {
  return (
    error instanceof OutputProtocolError &&
    ['limited', 'unavailable', 'context-changed', 'cancelled'].includes(error.code)
  )
}
