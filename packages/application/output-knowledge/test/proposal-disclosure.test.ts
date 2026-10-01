import { afterEach, expect, it } from '@jest/globals'
import { canonicalOutputJSON, outputPacketDigest, signOutputPacket } from '@bsv/sdk'
import {
  ProposalResponseDisclosure,
  type BoundProposalResponse
} from '../src/proposals/ProposalResponseDisclosure.js'
import { ProposalService } from '../src/proposals/ProposalService.js'
import { proposalDisclosureFixture } from './proposal-disclosure-fixture.js'
import { author, authorKey, outsider, recipient, signed } from './proposal-fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalDisclosureFixture>>[] = []
async function make(profile?: Parameters<typeof proposalDisclosureFixture>[0]) {
  const f = await proposalDisclosureFixture(profile)
  fixtures.push(f)
  return f
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(f => f.close()))
})

it('enforces the original profile byte limits on actual request text and complete outgoing bytes', async () => {
  const f = await make({ maxRequestBytes: 2048, maxResponseBytes: 4096 })
  const result = await f.service.get(f.query, f.caller)
  const exact = ' '.repeat(2048 - new TextEncoder().encode(f.query).byteLength) + f.query
  await enqueue(f, f.disclosure.bind('get', exact, result, f.caller))
  const oversized = f.disclosure.bind('get', ' ' + exact, result, f.caller)
  await expect(enqueue(f, oversized)).rejects.toMatchObject({
    code: 'limited',
    message: 'Proposal response exceeds its selected contract'
  })
  const tooLarge = f.disclosure.bind('get', f.query, { padding: 'x'.repeat(4096) }, f.caller)
  await expect(enqueue(f, tooLarge)).rejects.toMatchObject({
    code: 'limited',
    message: 'Proposal response exceeds its selected contract'
  })
})

it('restores either original publication or admission selector and rechecks access on finalization', async () => {
  const f = await make()
  const newer = signOutputPacket(
    'capabilities',
    { ...f.manifest.body, issuedAt: '11', expiresAt: '101' },
    authorKey
  )
  f.options.manifest = () => newer
  const caller = { ...f.caller, capabilityDigest: outputPacketDigest('capabilities', newer.body) }
  const text = canonicalOutputJSON(f.request)
  const result = await f.service.finalize(text, caller)
  for (const who of [caller, f.caller]) {
    const bound = f.disclosure.bind('finalize', text, result, who)
    await enqueue(f, bound)
    f.state.allowed = false
    await expect(enqueue(f, bound)).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Proposal caller is not currently authorized'
    })
    f.state.allowed = true
  }
})

it('requires exact true from local access and a valid exact U64 clock', async () => {
  const f = await make(),
    response = await f.service.get(f.query, f.caller)
  for (const result of [false, undefined, null, 1, 'true', Promise.resolve(true)]) {
    const disclosure = new ProposalResponseDisclosure({
      lifecycle: f.lifecycle,
      trust: f.trust,
      now: () => '11',
      access: () => result as boolean
    })
    await expect(
      enqueue(f, disclosure.bind('get', f.query, response, f.caller))
    ).rejects.toMatchObject({ code: 'not-found', message: 'Proposal not found' })
  }
  for (const now of ['-1', '01', '18446744073709551616']) {
    f.state.now = now
    await expect(
      enqueue(f, f.disclosure.bind('get', f.query, response, f.caller))
    ).rejects.toMatchObject({ code: 'invalid' })
  }
})

async function enqueue(
  f: Awaited<ReturnType<typeof make>>,
  bound: BoundProposalResponse,
  identity = author,
  bytes = new TextEncoder().encode(bound.body)
) {
  let queued = false
  await f.storage.enqueueResponse(
    { reference: bound.reference, bytes },
    (entry, body) => bound.validate(entry, body, identity),
    body => {
      expect(body).toEqual(bytes)
      queued = true
      return undefined
    }
  )
  expect(queued).toBe(true)
}

it('binds original text and exact successful wire responses under the real journal gate', async () => {
  const f = await make()
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  expect(ack.reference).toEqual({ kind: 'proposal', proposalId: f.request.proposalId })
  await enqueue(f, ack)
  const response = await f.service.get(f.query, f.caller)
  const bound = f.disclosure.bind('get', f.query, response, f.caller)
  expect(bound.reference.kind).toBe('channel')
  await enqueue(f, bound)
  response.proposal.body.payload = 'AA=='
  f.caller.caller = outsider
  await enqueue(f, bound)
  expect(Object.isFrozen(bound)).toBe(true)
  expect(Object.isFrozen(bound.reference)).toBe(true)
})

it('permits recipients only for reads and requires exact current host authority', async () => {
  const f = await make()
  const read = await f.service.get(f.query, { ...f.caller, caller: recipient })
  const bound = f.disclosure.bind('get', f.query, read, { ...f.caller, caller: recipient })
  await enqueue(f, bound, recipient)
  f.state.allowed = false
  await expect(enqueue(f, bound, recipient)).rejects.toMatchObject({
    code: 'not-found',
    message: 'Proposal not found'
  })
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  await expect(enqueue(f, ack)).rejects.toMatchObject({ code: 'unauthorized' })
  f.state.allowed = true
  const wrong = f.disclosure.bind('put', f.publication, f.ack, { ...f.caller, caller: recipient })
  await expect(enqueue(f, wrong, recipient)).rejects.toMatchObject({ code: 'unauthorized' })
})

it('rejects a changed channel head while preserving the historical publication acknowledgement', async () => {
  const f = await make(),
    result = await f.service.get(f.query, f.caller)
  const bound = f.disclosure.bind('get', f.query, result, f.caller)
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  const next = signed({ revision: '1', previous: f.request.proposalId })
  await f.service.put({ version: 1, proposal: next }, f.caller)
  await expect(enqueue(f, bound)).rejects.toMatchObject({ code: 'reset-required' })
  await enqueue(f, ack)
  const latest = f.disclosure.bind('get', f.query, await f.service.get(f.query, f.caller), f.caller)
  await enqueue(f, latest)
})

it('checks signed active expiry without waiting for a timer and keeps historical ACK recovery', async () => {
  const f = await make()
  const bound = f.disclosure.bind('get', f.query, await f.service.get(f.query, f.caller), f.caller)
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  f.state.now = '99'
  await enqueue(f, bound)
  f.state.now = '100'
  await expect(enqueue(f, bound)).rejects.toMatchObject({ code: 'expired' })
  await enqueue(f, ack)
  const expired = await f.service.get(f.query, f.caller)
  expect(expired.state.status).toBe('expired')
  const terminal = f.disclosure.bind('get', f.query, expired, f.caller)
  f.state.now = '1099'
  await enqueue(f, terminal)
  f.state.now = '1100'
  await expect(enqueue(f, terminal)).rejects.toMatchObject({ code: 'expired' })
  await expect(enqueue(f, ack)).rejects.toMatchObject({ code: 'expired' })
})

it('recovers retained contracts after discovery changes and manifest expiry, but rejects new selectors', async () => {
  const f = await make()
  const response = await f.service.get(f.query, f.caller)
  const bound = f.disclosure.bind('get', f.query, response, f.caller)
  const changed = signOutputPacket(
    'capabilities',
    { ...f.manifest.body, issuedAt: '12', expiresAt: '13' },
    authorKey
  )
  f.options.manifest = () => changed
  f.state.now = '99'
  await enqueue(f, bound)
  const wrong = f.disclosure.bind('get', f.query, response, {
    ...f.caller,
    capabilityDigest: outputPacketDigest('capabilities', changed.body)
  })
  await expect(enqueue(f, wrong)).rejects.toMatchObject({ code: 'context-changed' })
  f.state.now = '101'
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  await enqueue(f, ack)
})

it('binds finalizing and terminal state to its original job, retaining unresolved recovery past expiry', async () => {
  const f = await make(),
    request = canonicalOutputJSON(f.request)
  const result = await f.service.finalize(request, f.caller)
  expect(result.state.status).toBe('finalizing')
  const bound = f.disclosure.bind('finalize', request, result, f.caller)
  f.state.now = '2000'
  await enqueue(f, bound)
  f.options.admission.recover = async job => ({
    status: 'admitted',
    operationId: job.operationId,
    txid: job.txid,
    steak: {},
    assessmentContextId: 'original-topic-assessment'
  })
  await f.service.reconcile(f.request.proposalId)
  await expect(enqueue(f, bound)).rejects.toMatchObject({ code: 'reset-required' })
  const complete = await f.service.finalize(request, f.caller)
  expect(complete.state.status).toBe('finalized')
  await enqueue(f, f.disclosure.bind('finalize', request, complete, f.caller))
})

it('rejects invented finalization, missing context, missing records and mismatched record selectors', async () => {
  const f = await make()
  const entry = (await f.storage.getProposalEntry(f.request.proposalId))!
  const invented = f.disclosure.bind(
    'finalize',
    canonicalOutputJSON(f.request),
    { version: 1, proposalId: f.request.proposalId, state: entry.transition.next.state },
    f.caller
  )
  await expect(enqueue(f, invented)).rejects.toMatchObject({ code: 'unavailable' })
  const bound = f.disclosure.bind('get', f.query, await f.service.get(f.query, f.caller), f.caller),
    bytes = new TextEncoder().encode(bound.body)
  expect(() => bound.validate(undefined, bytes, author)).toThrow('Proposal not found')
  const missing = structuredClone(entry)
  delete missing.local
  expect(() => bound.validate(missing, bytes, author)).toThrow('recovery context is missing')
  const other = signed({ channel: 'ff'.repeat(32) })
  await f.service.put({ version: 1, proposal: other }, f.caller)
  const different = (await f.storage.getProposalEntry(outputPacketDigest('proposal', other.body)))!
  expect(() => bound.validate(different, bytes, author)).toThrow('response record differs')
  const ack = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  expect(() => ack.validate(different, new TextEncoder().encode(ack.body), author)).toThrow(
    'response record differs'
  )
})

it('rejects changed actual bytes and identities without enqueueing', async () => {
  const f = await make(),
    bound = f.disclosure.bind('put', f.publication, f.ack, f.caller)
  await expect(enqueue(f, bound, outsider)).rejects.toMatchObject({ code: 'unauthorized' })
  await expect(
    enqueue(f, bound, author, new TextEncoder().encode(bound.body + ' '))
  ).rejects.toMatchObject({ code: 'invalid' })
  const bytes = new TextEncoder().encode(bound.body)
  bytes[0] = 0
  await expect(enqueue(f, bound, author, bytes)).rejects.toMatchObject({ code: 'invalid' })
  const malformed = f.disclosure.bind('put', f.publication, { ...f.ack, extra: true }, f.caller)
  await expect(enqueue(f, malformed)).rejects.toMatchObject({ code: 'reset-required' })
})

it('does not depend on unrelated channels and survives a journal restart', async () => {
  const f = await make(),
    bound = f.disclosure.bind('get', f.query, await f.service.get(f.query, f.caller), f.caller)
  const otherService = new ProposalService({ ...f.options, storage: f.open() })
  await otherService.put({ version: 1, proposal: signed({ channel: 'ff'.repeat(32) }) }, f.caller)
  await enqueue(f, bound)
  await f.storage.close()
  const reopened = f.open()
  let sent = false
  await reopened.enqueueResponse(
    { reference: bound.reference, bytes: new TextEncoder().encode(bound.body) },
    (entry, bytes) => bound.validate(entry, bytes, author),
    () => {
      sent = true
      return undefined
    }
  )
  expect(sent).toBe(true)
})

it('validates original framing, operation, scope, author signature and synchronous configuration', async () => {
  const f = await make()
  for (const request of ['{}', '{"version":1,"version":1}', ' '.repeat(1048577)])
    expect(() => f.disclosure.bind('put', request, f.ack, f.caller)).toThrow()
  expect(() => f.disclosure.bind('put', { version: 1 } as never, f.ack, f.caller)).toThrow(
    'original request text'
  )
  expect(() => f.disclosure.bind('other' as never, '{}', f.ack, f.caller)).toThrow('operation')
  expect(() =>
    f.disclosure.bind(
      'put',
      canonicalOutputJSON({ version: 2, proposal: f.proposal }),
      f.ack,
      f.caller
    )
  ).toThrow('version')
  for (const operation of ['get', 'finalize'] as const) {
    const value = JSON.parse(operation === 'get' ? f.query : canonicalOutputJSON(f.request))
    value.service = 'other'
    expect(() => f.disclosure.bind(operation, canonicalOutputJSON(value), {}, f.caller)).toThrow(
      'Proposal not found'
    )
  }
  const corrupt = structuredClone(f.proposal)
  corrupt.body.payload = 'AA=='
  expect(() =>
    f.disclosure.bind(
      'put',
      canonicalOutputJSON({ version: 1, proposal: corrupt }),
      f.ack,
      f.caller
    )
  ).toThrow()
  for (const callbacks of [
    { now: async () => '11', access: () => true },
    { now: () => '11', access: async () => true },
    { now: undefined, access: () => true }
  ])
    expect(
      () =>
        new ProposalResponseDisclosure({
          lifecycle: f.lifecycle,
          trust: f.trust,
          ...callbacks
        } as never)
    ).toThrow('synchronous')
})
