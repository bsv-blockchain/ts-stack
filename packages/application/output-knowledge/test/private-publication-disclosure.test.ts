import { expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PrivatePublicationDisclosure } from '../src/private/PrivatePublicationDisclosure.js'
import { PrivatePublicationAccess } from '../src/private/PrivatePublicationAccess.js'
import { verifiedFixture } from './private-verified-publication-fixture.js'
import { allow } from './private-publication-fixture.js'
import { privatePublicationOperation } from '../src/private/PrivatePublicationProgress.js'

function fixture() {
  const f = verifiedFixture(),
    initial = f.stage()
  f.store.advance(initial.publicationId, '1', { kind: 'reserve-admission' }, () => '20', allow)
  const admitting = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.advance(
    initial.publicationId,
    admitting.record.revision,
    {
      kind: 'admitted',
      admission: {
        operationId: privatePublicationOperation(initial),
        txid: initial.txid,
        assessmentContextId: 'original-assessment',
        steak: {
          [initial.topic]: {
            outputsToAdmit: [initial.outputIndex],
            coinsToRetain: [],
            coinsRemoved: []
          }
        }
      }
    },
    () => '20',
    allow
  )
  const binding = f.store.loadVerified(initial.publicationId, () => '20', allow)!
  f.store.bindVerified(initial.publicationId, binding.record.revision, () => '20', allow)
  let allowed = true,
    current = true,
    now = '20'
  const access = new PrivatePublicationAccess(f.native.owner, initial.topic, () => allowed)
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    access,
    () => now
  )
  const caller = {
    publisher: initial.publisher,
    capability: f.contract.retained.selection.digest,
    profile: f.contract.retained.selection.profile.id,
    current: () => current
  }
  const status = { version: 1 as const, publicationId: initial.publicationId }
  return {
    ...f,
    disclosure,
    caller,
    status,
    access,
    revoke() {
      allowed = false
    },
    disconnect() {
      current = false
    },
    time(value: string) {
      now = value
    }
  }
}
it('prepares public projection and enqueues only the exact body/selector once under the native gate', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  const response = f.disclosure.prepare(f.status, f.caller)
  expect(JSON.parse(response.body)).toMatchObject({
    status: 'ready',
    publicationId: f.status.publicationId
  })
  expect(response.body).not.toContain('AQID')
  expect(response.headers).toEqual(f.contract.retained.selection.headers)
  response.enqueue(send)
  expect(send).toHaveBeenCalledWith(response.body, response.headers)
  expect(() => response.enqueue(send)).toThrow('already attempted')
  expect(send).toHaveBeenCalledTimes(1)
})
it('rechecks current publisher policy after signing and before actual enqueue', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  f.revoke()
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
})
it('rechecks authenticated session and cancellation after preparation', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    abort = new AbortController()
  const response = f.disclosure.prepare(f.status, { ...f.caller, signal: abort.signal })
  abort.abort()
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
  const second = f.disclosure.prepare(f.status, f.caller)
  f.disconnect()
  expect(() => second.enqueue(send)).toThrow('Private publication not found')
})
it('rejects stale ready response if a separate connection records readiness loss', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  const peer = f.reopen(),
    loaded = peer.loadVerified(f.status.publicationId, () => '20', allow)!
  peer.advance(
    f.status.publicationId,
    loaded.record.revision,
    { kind: 'unavailable', reason: 'Asset unavailable' },
    () => '21',
    allow
  )
  expect(() => response.enqueue(send)).toThrow('changed before disclosure')
  expect(send).not.toHaveBeenCalled()
  const replacement = f.disclosure.prepare(f.status, f.caller)
  expect(JSON.parse(replacement.body)).toMatchObject({ status: 'unavailable' })
})
it('preserves original selection for response recovery after manifest expiry', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>()
  f.time('101')
  const response = f.disclosure.prepare(f.status, f.caller)
  response.enqueue(send)
  expect(send).toHaveBeenCalledTimes(1)
})
it('rejects wrong publisher or original selector before response preparation', () => {
  const f = fixture()
  expect(() =>
    f.disclosure.prepare(f.status, {
      ...f.caller,
      publisher: new PrivateKey(64).toPublicKey().toString()
    })
  ).toThrow('Private publication not found')
  expect(() =>
    f.disclosure.prepare(f.status, { ...f.caller, capability: '99'.repeat(32) })
  ).toThrow('Original publication capability selector differs')
})
it('does not retry or claim rollback after enqueue itself throws', () => {
  const f = fixture(),
    send = jest.fn(() => {
      throw new Error('Late transport error')
    })
  const response = f.disclosure.prepare(f.status, f.caller)
  expect(() => response.enqueue(send)).toThrow('Late transport error')
  expect(() => response.enqueue(send)).toThrow('already attempted')
  expect(send).toHaveBeenCalledTimes(1)
})
it('requires a synchronous physical enqueue and does not execute an async function', () => {
  const f = fixture(),
    send = jest.fn(async () => {})
  const response = f.disclosure.prepare(f.status, f.caller)
  // The native async function identity remains visible without a mock wrapper.
  let calls = 0
  expect(() =>
    response.enqueue(async () => {
      calls++
    })
  ).toThrow('must be synchronous')
  expect(calls).toBe(0)
  expect(send).not.toHaveBeenCalled()
})
it('detects replacement of installed current access at the final gate', () => {
  const f = fixture(),
    send = jest.fn<(body: string, headers: Readonly<Record<string, string>>) => void>(),
    response = f.disclosure.prepare(f.status, f.caller)
  f.access.guard = () => allow
  expect(() => response.enqueue(send)).toThrow('Private publication not found')
  expect(send).not.toHaveBeenCalled()
})

it('requires installed current control authority and accepts only fixed bounded public errors', () => {
  const f = fixture(),
    send = jest.fn<() => void>()
  const packet = {
    version: 1,
    error: { code: 'not-found', message: 'Private publication request not-found', retryable: false }
  }
  expect(() => f.disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    'authority must be installed'
  )
  let allowed = true
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    f.store,
    f.contract.contracts,
    f.access,
    () => '20',
    () => allowed
  )
  expect(() =>
    disclosure.enqueueControl(
      { ...packet, error: { ...packet.error, message: 'Secret row diagnostic' } },
      f.caller,
      send
    )
  ).toThrow('fixed public diagnostics')
  disclosure.enqueueControl(packet, f.caller, send)
  expect(send).toHaveBeenCalledTimes(1)
  allowed = false
  expect(() => disclosure.enqueueControl(packet, f.caller, send)).toThrow(
    'control authority changed'
  )
  expect(send).toHaveBeenCalledTimes(1)
})
