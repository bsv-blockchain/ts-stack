import { jest } from '@jest/globals'
import type { Response } from 'express'
import type {
  AuthenticatedResponseCandidate,
  AuthenticatedResponseQueueGuard
} from '@bsv/auth-express-middleware'
import { OUTPUT_PROFILES, OutputProtocolError } from '@bsv/sdk'
import {
  guardProposalResponse,
  type ProposalResponseGuardOptions
} from '../ProposalResponseGuard.js'
import { proposalHTTPError } from '../ProposalHTTPPolicy.js'

// The real HTTP tests qualify signing. This local driver deliberately supplies
// incomplete collaborators to verify the queue guard's fail-closed contract.
let mockInstalled: AuthenticatedResponseQueueGuard
jest.mock('@bsv/auth-express-middleware', () => ({
  guardAuthenticatedResponse(_res: Response, guard: AuthenticatedResponseQueueGuard) {
    mockInstalled = guard
  }
}))
const caller = { caller: 'authenticated-local-principal', capabilityDigest: '11'.repeat(32) }
const body = new TextEncoder().encode('{"safe":true}')
function candidate(): AuthenticatedResponseCandidate {
  return {
    attempt: 0,
    identityKey: caller.caller,
    requestId: 'local-request',
    statusCode: 200,
    body: body.slice(),
    headers: {
      'x-bsv-overlay-capability': caller.capabilityDigest,
      'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
    }
  }
}
function options(): ProposalResponseGuardOptions {
  return {
    caller,
    initial: {
      binding: {
        body: new TextDecoder().decode(body),
        reference: { kind: 'proposal', proposalId: '22'.repeat(32) },
        validate: () => true
      }
    },
    authorizeControl: () => true,
    controlHeaders: { 'access-control-allow-origin': '*' },
    journal: {
      responseEnqueue: 'proposal-journal-send/1',
      async enqueueResponse(value, validate, enqueue) {
        if (validate(undefined, value.bytes) !== true)
          throw new OutputProtocolError('unauthorized', 'Denied locally')
        enqueue(value.bytes)
      }
    }
  }
}
const run = (
  value = candidate(),
  native: () => void = jest.fn(),
  signal = new AbortController().signal
) => Promise.resolve(mockInstalled(value, native, signal))

it.each(['identity', 'capability', 'profile', 'status'])(
  'withholds an incorrectly bound signed candidate (%s)',
  async mode => {
    guardProposalResponse({} as Response, options())
    const value = candidate(),
      native = jest.fn()
    if (mode === 'identity') Object.assign(value, { identityKey: 'different-principal' })
    if (mode === 'capability') value.headers['x-bsv-overlay-capability'] = 'ff'.repeat(32)
    if (mode === 'profile') value.headers['x-bsv-overlay-profile'] = 'other-profile'
    if (mode === 'status') value.statusCode = 201
    const replacement = await run(value, native)
    expect(native).not.toHaveBeenCalled()
    expect(replacement).toMatchObject({
      statusCode: mode === 'status' ? 400 : 401,
      headers: {
        'cache-control': 'private, no-store',
        'access-control-allow-origin': '*',
        'x-bsv-overlay-capability': caller.capabilityDigest,
        'x-bsv-overlay-profile': OUTPUT_PROFILES.proposal
      }
    })
  }
)

it('rechecks replacement bytes, status and control permission without a third attempt', async () => {
  const setup = options()
  setup.initial = {
    binding: {
      body: '',
      reference: { kind: 'channel', channelKey: 'local-channel' },
      validate: () => {
        throw new OutputProtocolError('reset-required', 'private state changed')
      }
    }
  }
  for (const altered of ['none', 'bytes', 'length', 'status', 'authority'] as const) {
    setup.authorizeControl = () => altered !== 'authority'
    guardProposalResponse({} as Response, setup)
    const native = jest.fn(),
      replacement = await run(candidate(), native)
    expect(replacement).toBeDefined()
    if (replacement === undefined) throw new Error('Expected a signed replacement')
    const next: AuthenticatedResponseCandidate = { ...candidate(), ...replacement, attempt: 1 }
    if (altered === 'bytes') next.body[0] ^= 1
    if (altered === 'length') next.body = new Uint8Array()
    if (altered === 'status') next.statusCode = 200
    if (altered === 'none') {
      await expect(run(next, native)).resolves.toBeUndefined()
      expect(native).toHaveBeenCalledTimes(1)
    } else {
      await expect(run(next, native)).rejects.toMatchObject({ code: 'unauthorized' })
      expect(native).not.toHaveBeenCalled()
    }
  }
})

it('permits only an explicitly prepared control response and sanitizes unknown errors', async () => {
  const setup = options(),
    error = new Error('private internal path')
  setup.initial = { error }
  guardProposalResponse({} as Response, setup)
  const control = proposalHTTPError(error),
    native = jest.fn()
  expect(JSON.parse(new TextDecoder().decode(control.body))).toEqual({
    version: 1,
    error: { code: 'unavailable', message: 'Proposal request unavailable', retryable: true }
  })
  await run({ ...candidate(), ...control }, native)
  expect(native).toHaveBeenCalledTimes(1)
  guardProposalResponse({} as Response, options())
  await expect(run({ ...candidate(), attempt: 1 })).rejects.toMatchObject({ code: 'unauthorized' })
})

it('never replaces after native enqueue starts or after caller cancellation', async () => {
  const setup = options(),
    failure = new Error('native enqueue acknowledgement lost')
  guardProposalResponse({} as Response, setup)
  let attempts = 0
  await expect(
    run(candidate(), () => {
      attempts++
      throw failure
    })
  ).rejects.toBe(failure)
  expect(attempts).toBe(1)
  const controller = new AbortController()
  controller.abort()
  const native = jest.fn()
  guardProposalResponse({} as Response, setup)
  await expect(run(candidate(), native, controller.signal)).rejects.toMatchObject({
    code: 'unauthorized'
  })
  expect(native).not.toHaveBeenCalled()
})

it('fails closed when a journal returns without actually enqueueing', async () => {
  const setup = options()
  setup.journal = { responseEnqueue: 'proposal-journal-send/1', enqueueResponse: async () => {} }
  guardProposalResponse({} as Response, setup)
  const native = jest.fn(),
    replacement = await run(candidate(), native)
  expect(replacement).toMatchObject({ statusCode: 503 })
  if (replacement === undefined) throw new Error('Expected control response')
  await expect(run({ ...candidate(), ...replacement, attempt: 1 }, native)).rejects.toThrow(
    'did not enqueue'
  )
  expect(native).not.toHaveBeenCalled()
})
