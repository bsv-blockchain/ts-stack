import type { Response } from 'express'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import {
  canonicalOutputJSON,
  OUTPUT_LOOKUP_PROFILE,
  OutputProtocolError,
  outputServiceErrorHTTPStatus
} from '@bsv/sdk'
import { lookupHTTPError } from './OutputLookupHTTPPolicy.js'
import type { OutputLookupCaller } from './OutputLookupRoutes.js'

/** Structural private host port. Implementations own current session/access checks and native enqueue. */
export interface OutputLookupResponseBinding {
  enqueue(
    bytes: Uint8Array,
    identity: string,
    enqueue: (bytes: Uint8Array) => undefined,
    signal: AbortSignal
  ): Promise<void>
}
export interface OutputLookupDisclosure {
  bind(
    operation: 'open' | 'read',
    body: string,
    caller: OutputLookupCaller
  ): OutputLookupResponseBinding
  control(body: string, caller: OutputLookupCaller): OutputLookupResponseBinding
}
export interface OutputLookupResponseGuardOptions {
  disclosure: OutputLookupDisclosure
  caller: OutputLookupCaller
  initial: { operation: 'open' | 'read' | 'close'; body: string } | { error: unknown }
  /** Complete safe CORS/profile headers; never copied from the signed candidate. */
  controlHeaders: Readonly<Record<string, string>>
}
export function lookupResponseControl(error: unknown): { statusCode: number; body: Uint8Array } {
  const packet = lookupHTTPError(error)
  return {
    statusCode: outputServiceErrorHTTPStatus(packet.error.code),
    body: new TextEncoder().encode(canonicalOutputJSON(packet, { bytes: 4096 }))
  }
}
/** Copy only response fields owned by this router, with no row/cursor-derived headers. */
export function lookupResponseControlHeaders(res: Response): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'vary'
  ]) {
    const value = res.getHeader(name)
    if (typeof value === 'string') result[name] = value
  }
  return result
}

/** Signing stays outside storage; the bound owner admits exactly one native enqueue afterward. */
export function guardOutputLookupResponse(
  res: Response,
  options: OutputLookupResponseGuardOptions
): void {
  const { disclosure } = options,
    caller = { ...options.caller }
  const original = 'operation' in options.initial ? { ...options.initial } : undefined
  let control =
    'error' in options.initial ? lookupResponseControl(options.initial.error) : undefined
  let binding = original
    ? original.operation === 'close'
      ? disclosure.control(original.body, caller)
      : disclosure.bind(original.operation, original.body, caller)
    : disclosure.control(new TextDecoder().decode(control!.body), caller)
  const controlHeaders = {
    ...options.controlHeaders,
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-bsv-overlay-capability': caller.capabilityDigest,
    'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
  }
  guardAuthenticatedResponse(res, async (candidate, enqueue, signal) => {
    let attempted = false
    try {
      if (
        candidate.identityKey !== caller.principal ||
        candidate.headers['x-bsv-overlay-capability'] !== caller.capabilityDigest ||
        candidate.headers['x-bsv-overlay-profile'] !== OUTPUT_LOOKUP_PROFILE
      )
        throw new OutputProtocolError(
          'unauthorized',
          'Lookup response identity or selection changed'
        )
      const expectedStatus = control?.statusCode ?? 200
      if (candidate.statusCode !== expectedStatus)
        throw new OutputProtocolError('invalid', 'Lookup response status changed')
      await binding.enqueue(
        candidate.body,
        candidate.identityKey,
        bytes => {
          if (attempted)
            throw new OutputProtocolError('unavailable', 'Lookup response was already enqueued')
          if (signal.aborted) throw new OutputProtocolError('cancelled', 'Lookup enqueue cancelled')
          if (
            bytes.length !== candidate.body.length ||
            !bytes.every((byte, index) => byte === candidate.body[index])
          )
            throw new OutputProtocolError('invalid', 'Lookup native enqueue bytes changed')
          attempted = true
          enqueue()
          return undefined
        },
        signal
      )
      if (!attempted) throw new Error('Lookup owner did not enqueue the response')
    } catch (error) {
      if (
        attempted ||
        signal.aborted ||
        candidate.attempt !== 0 ||
        !original ||
        original.operation === 'close'
      )
        throw error
      control = lookupResponseControl(error)
      binding = disclosure.control(new TextDecoder().decode(control.body), caller)
      return { ...control, body: control.body.slice(), headers: controlHeaders }
    }
  })
}
