import type { Response } from 'express'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import {
  OUTPUT_PROFILES,
  OutputProtocolError,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupAcquired,
  parseOutputJSON
} from '@bsv/sdk'
import type {
  PrivateAcquisitionHTTPCaller,
  PrivateAcquisitionHTTPDisclosure,
  PrivateAcquisitionHTTPPrepared
} from './PrivateAcquisitionHTTPPorts.js'
import { privateAcquisitionHTTPError } from './PrivateAcquisitionHTTPPolicy.js'

/** Exact signed response and current authority are checked inside the native send gate. */
export function guardPrivateAcquisitionResponse(
  res: Response,
  options: {
    disclosure: PrivateAcquisitionHTTPDisclosure
    caller: PrivateAcquisitionHTTPCaller
    initial: { prepared: PrivateAcquisitionHTTPPrepared } | { error: unknown }
    controlHeaders: Readonly<Record<string, string>>
  }
): void {
  const caller = { ...options.caller },
    disclosure = options.disclosure
  const prepared = 'prepared' in options.initial ? options.initial.prepared : undefined
  let control =
    'error' in options.initial ? privateAcquisitionHTTPError(options.initial.error) : undefined
  const headers = {
    ...options.controlHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-bsv-overlay-capability': caller.capability,
    'x-bsv-overlay-profile': OUTPUT_PROFILES.acquisition
  }
  let challengeSeller: string | undefined
  if (prepared) {
    const packet = parseOutputJSON(prepared.body)
    const quote =
      prepared.statusCode === 402
        ? parseOutputPaidLookupChallenge(packet)
        : parseOutputPaidLookupAcquired(packet).challenge
    challengeSeller = quote.seller
    if (quote.buyer !== caller.buyer)
      throw new OutputProtocolError('unauthorized', 'Acquisition response belongs to another buyer')
    if (
      prepared.statusCode === 402 &&
      (prepared.headers['x-bsv-payment-version'] !== '1.0' ||
        prepared.headers['x-bsv-payment-satoshis-required'] !== quote.satoshis ||
        prepared.headers['x-bsv-payment-derivation-prefix'] !== quote.derivationPrefix)
    )
      throw new OutputProtocolError(
        'invalid',
        'Acquisition challenge headers differ from original quote'
      )
  }
  guardAuthenticatedResponse(res, (candidate, enqueue, signal) => {
    const data = candidate.attempt === 0 && prepared !== undefined
    let attempted = false,
      active = false
    const send = () => {
      if (!active || attempted)
        throw new OutputProtocolError(
          'conflict',
          'Private acquisition enqueue is outside its single synchronous attempt'
        )
      if (
        signal.aborted ||
        caller.signal.aborted ||
        caller.current() !== true ||
        candidate.identityKey !== caller.buyer ||
        candidate.headers['x-bsv-overlay-capability'] !== caller.capability ||
        candidate.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.acquisition ||
        candidate.headers['cache-control'] !== 'private, no-store' ||
        candidate.headers['content-type'] !== 'application/json; charset=utf-8'
      )
        throw new OutputProtocolError(
          'unauthorized',
          'Private acquisition response identity or selection changed'
        )
      const paymentHeaders = [
        'x-bsv-payment-version',
        'x-bsv-payment-satoshis-required',
        'x-bsv-payment-derivation-prefix'
      ]
      for (const name of paymentHeaders)
        if (
          candidate.headers[name] !==
          (data && prepared.statusCode === 402 ? prepared.headers[name] : undefined)
        )
          throw new OutputProtocolError('invalid', 'Acquisition payment response header changed')
      if (data && candidate.headers['x-bsv-auth-identity-key'] !== challengeSeller)
        throw new OutputProtocolError('unauthorized', 'Acquisition response seller changed')
      const bytes = data ? Buffer.from(prepared.body) : control?.body
      if (
        !bytes ||
        candidate.statusCode !== (data ? prepared.statusCode : control!.statusCode) ||
        candidate.body.length !== bytes.length ||
        !candidate.body.every((byte, i) => byte === bytes[i])
      )
        throw new OutputProtocolError(
          'invalid',
          'Private acquisition response differs from its prepared body'
        )
      attempted = true
      enqueue()
    }
    const runOwner = (invoke: () => unknown) => {
      active = true
      try {
        const result = invoke()
        if (result instanceof Promise) void result.catch(() => undefined)
        if (result !== undefined)
          throw new OutputProtocolError(
            'invalid',
            'Private acquisition enqueue owner must finish synchronously'
          )
      } finally {
        active = false
      }
    }
    try {
      if (data)
        runOwner(() =>
          prepared.enqueue((body, selected) => {
            if (
              body !== prepared.body ||
              selected['x-bsv-overlay-capability'] !== caller.capability ||
              selected['x-bsv-overlay-profile'] !== caller.profile
            )
              throw new OutputProtocolError(
                'context-changed',
                'Original acquisition response selector changed'
              )
            send()
          })
        )
      else {
        if (!control)
          throw new OutputProtocolError('invalid', 'Private acquisition control is missing')
        runOwner(() => disclosure.enqueueControl(control!.packet, caller, send))
      }
      if (!attempted) throw new Error('Private acquisition owner did not enqueue')
    } catch (error) {
      if (attempted || signal.aborted || caller.signal.aborted || !data) throw error
      control = privateAcquisitionHTTPError(error)
      return { statusCode: control.statusCode, body: control.body.slice(), headers }
    }
  })
}
