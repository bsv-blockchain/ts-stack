import { jest, expect, it } from '@jest/globals'
import type { Response } from 'express'
import type {
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from '@bsv/auth-express-middleware'
import { OUTPUT_LOOKUP_PROFILE, OutputProtocolError } from '@bsv/sdk'
import {
  guardOutputLookupResponse,
  lookupResponseControlHeaders,
  type OutputLookupResponseGuardOptions
} from '../OutputLookupResponseGuard.js'
let mockInstalled: AuthenticatedResponseQueueGuard
jest.mock('@bsv/auth-express-middleware', () => ({
  guardAuthenticatedResponse(_response: Response, guard: AuthenticatedResponseQueueGuard) {
    mockInstalled = guard
  }
}))
const caller = { principal: 'synthetic-local-principal', capabilityDigest: '11'.repeat(32) }
const text = '{"synthetic":true}',
  body = new TextEncoder().encode(text)
function candidate(): AuthenticatedResponseCandidate {
  return {
    attempt: 0,
    identityKey: caller.principal,
    requestId: 'local-request',
    statusCode: 200,
    body: body.slice(),
    headers: {
      'x-bsv-overlay-capability': caller.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
    }
  }
}
function fixture() {
  const state = { data: true, control: true, omit: false, changed: false, failAfter: false }
  const options: OutputLookupResponseGuardOptions = {
    caller,
    initial: { operation: 'read', body: text },
    controlHeaders: { 'access-control-allow-origin': '*' },
    disclosure: {
      bind: () => ({
        enqueue: async (bytes, _identity, enqueue) => {
          if (!state.data) throw new OutputProtocolError('reset-required', 'private detail')
          if (!state.omit)
            enqueue(
              state.changed
                ? Uint8Array.from(bytes, (byte, index) => (index === 0 ? byte ^ 1 : byte))
                : bytes
            )
          if (state.failAfter) throw new Error('uncertain completion')
        }
      }),
      control: text => {
        const expected = new TextEncoder().encode(text)
        return {
          enqueue: async (bytes, _identity, enqueue) => {
            if (
              !state.control ||
              bytes.length !== expected.length ||
              !bytes.every((byte, index) => byte === expected[index])
            )
              throw new OutputProtocolError('unauthorized', 'Control denied')
            enqueue(bytes)
          }
        }
      }
    }
  }
  return { state, options }
}
const run = (
  value = candidate(),
  enqueue: () => void = jest.fn(),
  signal = new AbortController().signal
) => Promise.resolve(mockInstalled(value, enqueue, signal))
it.each(['identity', 'capability', 'profile', 'status'])(
  'rejects changed %s before native enqueue and binds its replacement',
  async mode => {
    const f = fixture(),
      value = { ...candidate(), identityKey: mode === 'identity' ? 'other' : caller.principal },
      native = jest.fn()
    guardOutputLookupResponse({} as Response, f.options)
    if (mode === 'capability') value.headers['x-bsv-overlay-capability'] = 'ff'.repeat(32)
    if (mode === 'profile') value.headers['x-bsv-overlay-profile'] = 'other'
    if (mode === 'status') value.statusCode = 201
    const next = await run(value, native)
    expect(native).not.toHaveBeenCalled()
    expect(next).toMatchObject({
      statusCode: mode === 'status' ? 400 : 401,
      headers: {
        'cache-control': 'private, no-store',
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
        'access-control-allow-origin': '*',
        'x-bsv-overlay-capability': caller.capabilityDigest,
        'x-bsv-overlay-profile': OUTPUT_LOOKUP_PROFILE
      }
    })
  }
)
it('sends a valid candidate once and owns original operation/caller metadata', async () => {
  const f = fixture(),
    native = jest.fn(),
    value = candidate()
  const ownCaller = { ...caller }
  f.options.caller = ownCaller
  guardOutputLookupResponse({} as Response, f.options)
  ownCaller.principal = 'changed'
  expect(await run(value, native)).toBeUndefined()
  expect(native).toHaveBeenCalledTimes(1)
})
it.each(['omit', 'changed'] as const)(
  'rejects a collaborator that %s the actual enqueue contract',
  async field => {
    const f = fixture(),
      native = jest.fn()
    f.state[field] = true
    guardOutputLookupResponse({} as Response, f.options)
    const result = await run(candidate(), native)
    expect(result).toMatchObject({ statusCode: field === 'changed' ? 400 : 503 })
    expect(native).not.toHaveBeenCalled()
  }
)
it('never replaces a response after native enqueue was attempted', async () => {
  const f = fixture(),
    native = jest.fn()
  f.state.failAfter = true
  guardOutputLookupResponse({} as Response, f.options)
  await expect(run(candidate(), native)).rejects.toThrow('uncertain completion')
  expect(native).toHaveBeenCalledTimes(1)
})
it('never delivers an aborted response or constructs a replacement for it', async () => {
  const f = fixture(),
    native = jest.fn()
  guardOutputLookupResponse({} as Response, f.options)
  await expect(run(candidate(), native, AbortSignal.abort())).rejects.toMatchObject({
    code: 'cancelled'
  })
  expect(native).not.toHaveBeenCalled()
})
it('checks replacement status, body and current permission without a third attempt', async () => {
  const f = fixture(),
    native = jest.fn()
  f.state.data = false
  guardOutputLookupResponse({} as Response, f.options)
  const result = await run(candidate(), native)
  if (!result) throw new Error('Missing replacement')
  const replacement: AuthenticatedResponseCandidate = { ...candidate(), attempt: 1, ...result }
  replacement.body.fill(0)
  await expect(run(replacement, native)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(native).not.toHaveBeenCalled()
})
it('enqueues an owned replacement exactly once when its control permission remains', async () => {
  const f = fixture(),
    native = jest.fn()
  f.state.data = false
  guardOutputLookupResponse({} as Response, f.options)
  const result = await run(candidate(), native)
  if (!result) throw new Error('Missing replacement')
  expect(new TextDecoder().decode(result.body)).not.toContain('private detail')
  await run({ ...candidate(), attempt: 1, ...result }, native)
  expect(native).toHaveBeenCalledTimes(1)
})
it.each(['error', 'close'])(
  'does not replace a rejected initial %s control response',
  async mode => {
    const f = fixture(),
      native = jest.fn()
    f.state.control = false
    f.options.initial =
      mode === 'error'
        ? { error: new OutputProtocolError('unavailable', 'private detail') }
        : { operation: 'close', body: text }
    guardOutputLookupResponse({} as Response, f.options)
    const value = candidate()
    if (mode === 'error') value.statusCode = 503
    await expect(run(value, native)).rejects.toMatchObject({ code: 'unauthorized' })
    expect(native).not.toHaveBeenCalled()
  }
)
it('copies only safe router-owned string headers for replacement signing', () => {
  const values: Record<string, unknown> = {
    'access-control-allow-origin': '*',
    vary: 'Origin',
    'access-control-expose-headers': ['not-a-string'],
    'x-private-row': 'hidden'
  }
  const res = { getHeader: (name: string) => values[name] } as Response
  expect(lookupResponseControlHeaders(res)).toEqual({
    'access-control-allow-origin': '*',
    vary: 'Origin'
  })
})

it('prevents a collaborator from enqueueing the same signed response twice', async () => {
  const f = fixture(),
    native = jest.fn()
  f.options.disclosure.bind = () => ({
    enqueue: async (bytes, _identity, enqueue) => {
      enqueue(bytes)
      enqueue(bytes)
    }
  })
  guardOutputLookupResponse({} as Response, f.options)
  await expect(run(candidate(), native)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Lookup response was already enqueued'
  })
  expect(native).toHaveBeenCalledTimes(1)
})

it('preserves all router-owned CORS string headers when signing a replacement', () => {
  const headers = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST',
    'access-control-allow-headers': 'content-type',
    'access-control-expose-headers': 'x-bsv-overlay-profile',
    vary: 'Origin'
  }
  const res = { getHeader: (name: string) => headers[name as keyof typeof headers] } as Response
  expect(lookupResponseControlHeaders(res)).toEqual(headers)
})
it.each(['identity', 'status'])(
  'rejects changed %s on the second signing attempt without another replacement',
  async mode => {
    const f = fixture(),
      native = jest.fn()
    f.state.data = false
    guardOutputLookupResponse({} as Response, f.options)
    const result = await run(candidate(), native)
    if (!result) throw new Error('Missing replacement')
    const replacement = { ...candidate(), attempt: 1 as const, ...result }
    if (mode === 'identity') replacement.headers['x-bsv-overlay-profile'] = 'changed'
    else replacement.statusCode++
    await expect(run(replacement, native)).rejects.toMatchObject({
      code: mode === 'identity' ? 'unauthorized' : 'invalid',
      message:
        mode === 'identity'
          ? 'Lookup response identity or selection changed'
          : 'Lookup response status changed'
    })
    expect(native).not.toHaveBeenCalled()
  }
)
