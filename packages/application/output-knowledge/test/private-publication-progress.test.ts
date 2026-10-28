import { expect, it } from '@jest/globals'
import { PrivateKey, canonicalOutputJSON, outputPacketDigest, type STEAK } from '@bsv/sdk'
import { createHash } from 'node:crypto'
import {
  advancePrivatePublicationProgress as advance,
  createPrivatePublicationProgress as create,
  parsePrivatePublicationProgress as parse,
  privatePublicationOperation,
  privatePublicationResult as result,
  type PrivatePublicationEvent
} from '../src/private/PrivatePublicationProgress.js'

const selected = {
  publisher: new PrivateKey(1).toPublicKey().toString(),
  chain: { network: 'main' as const, genesisHash: '11'.repeat(32) },
  blobKey: '22'.repeat(32),
  lookup: { service: 'ls_synthetic', rulesDigest: '33'.repeat(32) }
}
const request = {
  version: 1,
  requestId: 'synthetic_publish_1',
  topic: 'tm_synthetic',
  evidence: { txid: '44'.repeat(32), outputIndex: 1, beef: 'AA==' },
  assetId: '55'.repeat(32),
  schema: 'urn:synthetic:private:1',
  privateValues: 'AQ=='
}
const staged = () => create(request, selected, '10', '20')
const admitting = () => advance(staged(), { kind: 'reserve-admission' }, '11')
const admission = () => ({
  operationId: privatePublicationOperation(staged()),
  txid: request.evidence.txid,
  assessmentContextId: 'synthetic-assessment',
  steak: { tm_synthetic: { outputsToAdmit: [1], coinsToRetain: [] } }
})
const binding = () => ({
  publicationId: staged().publicationId,
  requestDigest: staged().requestDigest,
  blobKey: selected.blobKey,
  ...selected.lookup,
  receiptDigest: '66'.repeat(32)
})
const bindingPending = () =>
  advance(admitting(), { kind: 'admitted', admission: admission() }, '12')
const ready = () => advance(bindingPending(), { kind: 'bound', binding: binding() }, '13')

it('preserves the independent permanent admission operation binding', () => {
  const state = staged()
  const expected = createHash('sha256')
    .update(
      canonicalOutputJSON({
        format: 'private-publication-admission/1',
        publicationId: state.publicationId,
        requestDigest: state.requestDigest,
        chain: selected.chain,
        publisher: selected.publisher,
        topic: request.topic,
        txid: request.evidence.txid,
        outputIndex: request.evidence.outputIndex,
        blobKey: selected.blobKey
      })
    )
    .digest('hex')
  expect(privatePublicationOperation(state)).toBe(expected)
  expect(privatePublicationOperation(ready())).toBe(expected)
})

it.each([null, [], true, 1, 'invalid'])(
  'reports malformed progress %p as a typed parse error',
  progress => {
    expect(() => parse({ ...staged(), progress })).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Invalid publication progress'
      })
    )
  }
)

it.each([null, [], true, 1, 'invalid'])(
  'reports malformed events %p as a typed parse error',
  event => {
    expect(() => advance(staged(), event as unknown as PrivatePublicationEvent, '11')).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Invalid publication event'
      })
    )
  }
)

it.each([{ kind: 'unknown' }, { kind: 'constructor' }, { kind: 42 }])(
  'never dispatches unknown event %p',
  event => {
    expect(() => advance(staged(), event as unknown as PrivatePublicationEvent, '11')).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Unknown private publication event'
      })
    )
  }
)

it('distinguishes unsupported persistence, malformed phases and inconsistent reserved operations', () => {
  expect(() => parse({ ...staged(), format: 'private-publication-progress/2' })).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Unsupported publication progress format'
    })
  )
  expect(() => parse({ ...staged(), progress: { phase: 'unknown' } })).toThrow(
    expect.objectContaining({
      code: 'invalid',
      message: 'Unknown publication progress'
    })
  )
  expect(() =>
    parse({ ...staged(), progress: { phase: 'admitting', operationId: '99'.repeat(32) } })
  ).toThrow(
    expect.objectContaining({
      code: 'conflict',
      message: 'Publication operation differs'
    })
  )
})

it('bounds whole progress and event bytes before selecting fields or dispatching', () => {
  expect(() => parse({ ...staged(), padding: 'x'.repeat(65536) })).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect(() =>
    advance(
      staged(),
      { kind: 'reserve-admission', padding: 'x'.repeat(65536) } as PrivatePublicationEvent,
      '11'
    )
  ).toThrow(expect.objectContaining({ code: 'limited' }))
})

it('preserves expired and conflict decisions for forbidden transition attempts', () => {
  const expired = expect.objectContaining({ code: 'expired' })
  const conflict = expect.objectContaining({ code: 'conflict' })
  expect(() => create(request, selected, '20', '20')).toThrow(expired)
  expect(() => advance(staged(), { kind: 'reserve-admission' }, '20')).toThrow(expired)
  expect(() => advance(admitting(), { kind: 'reserve-admission' }, '12')).toThrow(conflict)
  expect(() => advance(staged(), { kind: 'admitted', admission: admission() }, '12')).toThrow(
    conflict
  )
  expect(() =>
    advance(
      admitting(),
      { kind: 'admitted', admission: { ...admission(), txid: '99'.repeat(32) } },
      '12'
    )
  ).toThrow(conflict)
  expect(() => advance(staged(), { kind: 'bound', binding: binding() }, '12')).toThrow(conflict)
  expect(() =>
    advance(bindingPending(), { kind: 'bound', binding: { ...binding(), service: 'other' } }, '12')
  ).toThrow(conflict)
  expect(() =>
    advance(bindingPending(), { kind: 'rejected', noEffect: true, reason: 'too late' }, '12')
  ).toThrow(conflict)
  expect(() => advance(admitting(), { kind: 'expired', reason: 'uncertain' }, '100')).toThrow(
    conflict
  )
  expect(() => advance(staged(), { kind: 'unavailable', reason: 'not ready' }, '12')).toThrow(
    conflict
  )
  expect(() => advance(ready(), { kind: 'restored', binding: binding() }, '14')).toThrow(conflict)
})

it('binds public identity and semantic retry fence while omitting secret material from progress and public status', () => {
  const state = staged()
  expect(state.publicationId).toBe(
    outputPacketDigest('private-publication', {
      chain: selected.chain,
      publisher: selected.publisher,
      topic: request.topic,
      requestId: request.requestId
    })
  )
  expect(result(state)).toEqual({
    version: 1,
    publicationId: state.publicationId,
    txid: request.evidence.txid,
    status: 'pending',
    updatedAt: '10'
  })
  expect(JSON.stringify(state)).not.toContain('privateValues')
  const proofVariant = create(
    { ...request, evidence: { ...request.evidence, beef: 'Ag==' } },
    selected,
    '10',
    '20'
  )
  expect(proofVariant).toEqual(state)
  const changed = create({ ...request, privateValues: 'Aw==' }, selected, '10', '20')
  expect(changed.publicationId).toBe(state.publicationId)
  expect(changed.requestDigest).not.toBe(state.requestDigest)
  expect(privatePublicationOperation(changed)).not.toBe(privatePublicationOperation(state))
})
it('requires durable reservation, original admission and matching binding in order before ready', () => {
  expect(result(admitting()).status).toBe('pending')
  expect(result(bindingPending()).status).toBe('pending')
  expect(result(ready()).status).toBe('ready')
  expect(ready().progress).toEqual({ phase: 'ready', admission: admission(), binding: binding() })
  expect(staged().progress.phase).toBe('staged')
  expect(() => advance(staged(), { kind: 'admitted', admission: admission() }, '11')).toThrow(
    'reserved admission'
  )
  expect(() => advance(admitting(), { kind: 'bound', binding: binding() }, '11')).toThrow(
    'retained admission'
  )
})
it('keeps reserved work recoverable beyond the staging deadline and prevents false expiry', () => {
  expect(() => advance(admitting(), { kind: 'expired', reason: 'deadline' }, '100')).toThrow(
    'uncertain external effect'
  )
  const late = advance(admitting(), { kind: 'admitted', admission: admission() }, '100')
  expect(result(late)).toMatchObject({ status: 'pending', updatedAt: '100' })
  expect(result(advance(late, { kind: 'bound', binding: binding() }, '101')).status).toBe('ready')
})
it('expires only unreserved staged work at the exact boundary and never reopens a terminal fence', () => {
  expect(() => create(request, selected, '20', '20')).toThrow('deadline')
  expect(() => advance(staged(), { kind: 'reserve-admission' }, '20')).toThrow('deadline')
  expect(() => advance(staged(), { kind: 'expired', reason: 'deadline' }, '19')).toThrow()
  const expired = advance(staged(), { kind: 'expired', reason: 'deadline' }, '20')
  expect(result(expired)).toMatchObject({ status: 'expired', reason: 'deadline' })
  expect(() => advance(expired, { kind: 'reserve-admission' }, '1')).toThrow('not staged')
})
it('retains a monotonic observation across all legal transitions', () => {
  const reserved = advance(staged(), { kind: 'reserve-admission' }, '9')
  expect(reserved.updatedAt).toBe('10')
  const bound = advance(
    advance(reserved, { kind: 'admitted', admission: admission() }, '8'),
    { kind: 'bound', binding: binding() },
    '7'
  )
  expect(bound.updatedAt).toBe('10')
  expect(() => advance(staged(), { kind: 'reserve-admission' }, '18446744073709551616')).toThrow()
})
it('rejects definitive no-effect outcomes only before retained admission', () => {
  for (const before of [staged(), admitting()]) {
    const failed = advance(
      before,
      { kind: 'rejected', reason: 'domain rejected', noEffect: true },
      '12'
    )
    expect(result(failed)).toMatchObject({ status: 'rejected', reason: 'domain rejected' })
    expect(() => advance(failed, { kind: 'reserve-admission' }, '12')).toThrow()
  }
  expect(() =>
    advance(
      admitting(),
      {
        kind: 'rejected',
        reason: 'uncertain',
        noEffect: false
      } as unknown as PrivatePublicationEvent,
      '12'
    )
  ).toThrow('no-effect')
  expect(() =>
    advance(bindingPending(), { kind: 'rejected', reason: 'no', noEffect: true }, '12')
  ).toThrow('no-effect')
})
it('retains admission across unavailable and independently verified restoration', () => {
  const unavailable = advance(ready(), { kind: 'unavailable', reason: 'lookup binding lost' }, '14')
  expect(result(unavailable)).toMatchObject({
    status: 'unavailable',
    reason: 'lookup binding lost'
  })
  const restored = advance(unavailable, { kind: 'restored', binding: binding() }, '15')
  expect(restored.progress).toEqual(ready().progress)
  expect(result(restored)).toMatchObject({ status: 'ready', updatedAt: '15' })
  expect(() => advance(staged(), { kind: 'unavailable', reason: 'missing' }, '15')).toThrow(
    'not ready'
  )
  expect(() => advance(ready(), { kind: 'restored', binding: binding() }, '15')).toThrow(
    'not unavailable'
  )
})
it.each(['operationId', 'txid'])('rejects a retained admission with a different %s', field => {
  expect(() =>
    advance(
      admitting(),
      { kind: 'admitted', admission: { ...admission(), [field]: '99'.repeat(32) } },
      '12'
    )
  ).toThrow('original output')
})
it('rejects admission without the requested topic/output or with only duplicate-submit empty STEAK', () => {
  const variants: STEAK[] = [
    {},
    { other: { outputsToAdmit: [1], coinsToRetain: [] } },
    { tm_synthetic: { outputsToAdmit: [], coinsToRetain: [] } },
    { tm_synthetic: { outputsToAdmit: [0], coinsToRetain: [] } }
  ]
  for (const steak of variants) {
    expect(() =>
      advance(admitting(), { kind: 'admitted', admission: { ...admission(), steak } }, '12')
    ).toThrow('original output')
  }
})
it.each([
  { service: 'other' },
  { rulesDigest: '99'.repeat(32) },
  { publicationId: '99'.repeat(32) },
  { requestDigest: '99'.repeat(32) },
  { blobKey: '99'.repeat(32) }
])('rejects a binding for a different installed contract %p', change => {
  expect(() =>
    advance(bindingPending(), { kind: 'bound', binding: { ...binding(), ...change } }, '13')
  ).toThrow('binding differs')
})
it('owns records, admission, bindings and status without retaining caller aliases', () => {
  const first = staged(),
    snapshot = structuredClone(first),
    supplied = admission()
  const next = advance(
    advance(first, { kind: 'reserve-admission' }, '11'),
    { kind: 'admitted', admission: supplied },
    '12'
  )
  supplied.steak.tm_synthetic.outputsToAdmit.length = 0
  expect(next.progress).toEqual({ phase: 'binding', admission: admission() })
  expect(first).toEqual(snapshot)
  const loaded = parse(next)
  loaded.lookup.service = 'changed'
  expect(next.lookup).toEqual(selected.lookup)
})
it('rejects persisted state drift and unknown fields before producing any public status', () => {
  const current = ready()
  for (const change of [
    { format: 'future' },
    { outputIndex: -1 },
    { publisher: 'invalid' },
    { updatedAt: '-1' },
    { progress: { phase: 'future' } },
    { unexpected: true },
    { progress: { phase: 'admitting', operationId: '99'.repeat(32) } },
    {
      progress: {
        phase: 'ready',
        admission: admission(),
        binding: binding(),
        reason: 'not allowed'
      }
    }
  ]) {
    expect(() => result({ ...current, ...change })).toThrow()
  }
})
it('rejects accessors and unknown transition claims', () => {
  let count = 0
  const bad = Object.defineProperty({}, 'kind', {
    enumerable: true,
    get() {
      count++
      return 'bound'
    }
  })
  expect(() => advance(bindingPending(), bad as PrivatePublicationEvent, '13')).toThrow()
  expect(count).toBe(0)
  expect(() =>
    advance(
      staged(),
      { kind: 'ready', authenticated: true } as unknown as PrivatePublicationEvent,
      '13'
    )
  ).toThrow()
  expect(() =>
    advance(staged(), { kind: 'reserve-admission', paid: true } as PrivatePublicationEvent, '13')
  ).toThrow()
})
