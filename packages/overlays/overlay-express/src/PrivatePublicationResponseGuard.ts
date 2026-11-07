import type { Response } from 'express'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import { OUTPUT_PROFILES, OutputProtocolError } from '@bsv/sdk'
import type {
  PrivatePublicationHTTPCaller,
  PrivatePublicationHTTPDisclosure,
  PrivatePublicationHTTPPrepared
} from './PrivatePublicationHTTPPorts.js'
import { privatePublicationHTTPError } from './PrivatePublicationHTTPPolicy.js'

/** Exact signed response and current authority are checked inside the native send gate. */
export function guardPrivatePublicationResponse(
  res: Response,
  options: {
    disclosure: PrivatePublicationHTTPDisclosure
    caller: PrivatePublicationHTTPCaller
    initial: { prepared: PrivatePublicationHTTPPrepared } | { error: unknown }
    controlHeaders: Readonly<Record<string, string>>
  }
): void {
  const caller = { ...options.caller },
    disclosure = options.disclosure
  const prepared = 'prepared' in options.initial ? options.initial.prepared : undefined
  let control =
    'error' in options.initial ? privatePublicationHTTPError(options.initial.error) : undefined
  const headers = {
    ...options.controlHeaders,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-bsv-overlay-capability': caller.capability,
    'x-bsv-overlay-profile': OUTPUT_PROFILES.publication
  }
  guardAuthenticatedResponse(res, (candidate, enqueue, signal) => {
    const data = candidate.attempt === 0 && prepared !== undefined
    let attempted = false,
      active = false
    const send = () => {
      if (!active || attempted)
        throw new OutputProtocolError(
          'conflict',
          'Private publication enqueue is outside its single synchronous attempt'
        )
      if (
        signal.aborted ||
        caller.signal.aborted ||
        caller.current() !== true ||
        candidate.identityKey !== caller.publisher ||
        candidate.headers['x-bsv-overlay-capability'] !== caller.capability ||
        candidate.headers['x-bsv-overlay-profile'] !== OUTPUT_PROFILES.publication ||
        candidate.headers['cache-control'] !== 'private, no-store' ||
        candidate.headers['content-type'] !== 'application/json; charset=utf-8'
      )
        throw new OutputProtocolError(
          'unauthorized',
          'Private publication response identity or selection changed'
        )
      const bytes = data ? Buffer.from(prepared.body) : control?.body
      if (
        !bytes ||
        candidate.statusCode !== (data ? 200 : control!.statusCode) ||
        candidate.body.length !== bytes.length ||
        !candidate.body.every((byte, i) => byte === bytes[i])
      )
        throw new OutputProtocolError(
          'invalid',
          'Private publication response differs from its prepared body'
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
            'Private publication enqueue owner must finish synchronously'
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
                'Original publication response selector changed'
              )
            send()
          })
        )
      else {
        if (!control)
          throw new OutputProtocolError('invalid', 'Private publication control is missing')
        runOwner(() => disclosure.enqueueControl(control!.packet, caller, send))
      }
      if (!attempted) throw new Error('Private publication owner did not enqueue')
    } catch (error) {
      if (attempted || signal.aborted || caller.signal.aborted || !data) throw error
      control = privatePublicationHTTPError(error)
      return { statusCode: control.statusCode, body: control.body.slice(), headers }
    }
  })
}
