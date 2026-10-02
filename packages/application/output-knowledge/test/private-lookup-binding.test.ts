import { expect, it } from '@jest/globals'
import { createHash } from 'node:crypto'
import { canonicalOutputJSON } from '@bsv/sdk'
import {
  createPrivateLookupBinding,
  activatePrivateLookupBinding,
  parsePrivateLookupBinding,
  privateLookupBindingAddress,
  privateLookupBindingReceipt
} from '../src/private/PrivateLookupBinding.js'
import { advancePrivatePublicationProgress } from '../src/private/PrivatePublicationProgress.js'
import {
  fixture,
  staged,
  selected,
  request,
  clock,
  allow,
  admission
} from './private-publication-fixture.js'

function prepared() {
  const f = fixture(),
    state = staged(f.store),
    loaded = f.store.load(state.publicationId, clock, allow)!
  const reserved = createPrivateLookupBinding(loaded.blob, state.lookup, f.owner.identity)
  const admitting = advancePrivatePublicationProgress(state, { kind: 'reserve-admission' }, '11')
  const waiting = advancePrivatePublicationProgress(
    admitting,
    { kind: 'admitted', admission: admission(state) },
    '12'
  )
  const active = activatePrivateLookupBinding(reserved, waiting, loaded.blob, f.owner.identity)
  return { f, state, blob: loaded.blob, reserved, waiting, active }
}
it('requires retained original admission before activation or a per-publication receipt', () => {
  const { f, state, blob, reserved, waiting, active } = prepared()
  expect(reserved.phase).toBe('reserved')
  expect(active.phase).toBe('active')
  expect(() => activatePrivateLookupBinding(reserved, state, blob, f.owner.identity)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
  expect(() => privateLookupBindingReceipt(reserved, waiting, blob, f.owner.identity)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(() => privateLookupBindingReceipt(active, state, blob, f.owner.identity)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
})
it('uses separate opaque lookup addresses for each exact blob, service and rules installation', () => {
  const { f, reserved } = prepared()
  const base = privateLookupBindingAddress(f.owner.identity, reserved)
  expect(base.kind).toBe('publication')
  expect(base.key).not.toBe(reserved.blobKey)
  for (const alternative of [
    { ...reserved, blobKey: 'ff'.repeat(32) },
    { ...reserved, lookup: { ...reserved.lookup, service: 'ls_other' } },
    {
      ...reserved,
      lookup: { ...reserved.lookup, rulesDigest: 'ff'.repeat(32) }
    }
  ])
    expect(privateLookupBindingAddress(f.owner.identity, alternative)).not.toEqual(base)
  expect(base).toEqual(
    f.owner.identity.address('publication', {
      purpose: 'private-lookup-binding',
      blobKey: reserved.blobKey,
      ...reserved.lookup
    })
  )
})
it('binds the whole original activation and publication identity into the receipt digest', () => {
  const { f, active, waiting, blob } = prepared()
  const receipt = privateLookupBindingReceipt(active, waiting, blob, f.owner.identity)
  const publication = {
    publicationId: waiting.publicationId,
    requestDigest: waiting.requestDigest,
    blobKey: waiting.blobKey,
    ...waiting.lookup
  }
  const expected = createHash('sha256')
    .update(
      canonicalOutputJSON({
        format: 'private-lookup-binding-receipt/1',
        binding: active,
        publication
      })
    )
    .digest('hex')
  expect(receipt).toEqual({ ...publication, receiptDigest: expected })
  const parsed = parsePrivateLookupBinding(active, blob, f.owner.identity)
  parsed.lookup.service = 'changed'
  expect(privateLookupBindingReceipt(active, waiting, blob, f.owner.identity)).toEqual(receipt)
})
it('shares one exact active binding across request IDs while preserving independent receipts', () => {
  const { f, active, waiting, blob } = prepared()
  const second = f.store.stage(
    { ...request(), requestId: 'synthetic-publish-2' },
    selected(),
    '20',
    clock,
    allow
  )
  const admissionReserved = advancePrivatePublicationProgress(
    second,
    { kind: 'reserve-admission' },
    '11'
  )
  const next = advancePrivatePublicationProgress(
    admissionReserved,
    { kind: 'admitted', admission: admission(second) },
    '12'
  )
  expect(activatePrivateLookupBinding(active, next, blob, f.owner.identity)).toEqual(active)
  const firstReceipt = privateLookupBindingReceipt(active, waiting, blob, f.owner.identity)
  const nextReceipt = privateLookupBindingReceipt(active, next, blob, f.owner.identity)
  expect(nextReceipt.blobKey).toBe(firstReceipt.blobKey)
  expect(nextReceipt.publicationId).not.toBe(firstReceipt.publicationId)
  expect(nextReceipt.receiptDigest).not.toBe(firstReceipt.receiptDigest)
})
it.each(['blobKey', 'topic', 'chain', 'assetId', 'schema'] as const)(
  'requires the exact protected %s relationship',
  field => {
    const { f, active, blob } = prepared(),
      changed = structuredClone(active)
    if (field === 'blobKey') changed.blobKey = 'ff'.repeat(32)
    else if (field === 'chain') changed.binding.chain.genesisHash = 'ff'.repeat(32)
    else changed.binding[field] = field === 'assetId' ? 'ff'.repeat(32) : 'changed'
    expect(() => parsePrivateLookupBinding(changed, blob, f.owner.identity)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  }
)
it.each(['txid', 'membership', 'other-topic'] as const)(
  'rejects incompatible retained admission %s',
  field => {
    const { f, active, blob } = prepared()
    if (active.phase !== 'active') throw new Error('Expected active binding')
    const changed = structuredClone(active)
    if (field === 'txid') changed.admission.txid = 'ff'.repeat(32)
    if (field === 'membership') changed.admission.steak.tm_synthetic.outputsToAdmit = []
    if (field === 'other-topic')
      changed.admission.steak.tm_other = {
        outputsToAdmit: [],
        coinsToRetain: []
      }
    expect(() => parsePrivateLookupBinding(changed, blob, f.owner.identity)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  }
)
it('does not overwrite an active original assessment with another publication assessment', () => {
  const { f, active, waiting, blob } = prepared()
  if (waiting.progress.phase !== 'binding') throw new Error('Expected binding progress')
  waiting.progress.admission.assessmentContextId = 'different-original-assessment'
  expect(() => activatePrivateLookupBinding(active, waiting, blob, f.owner.identity)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
  expect(() => privateLookupBindingReceipt(active, waiting, blob, f.owner.identity)).toThrow(
    expect.objectContaining({ code: 'conflict' })
  )
})
it('refuses unexpected phases or speculative admission attached to a reserved binding', () => {
  const { f, reserved, blob } = prepared()
  expect(() =>
    parsePrivateLookupBinding({ ...reserved, phase: 'unknown' }, blob, f.owner.identity)
  ).toThrow()
  expect(() =>
    parsePrivateLookupBinding({ ...reserved, admission: {} }, blob, f.owner.identity)
  ).toThrow()
  expect(() =>
    parsePrivateLookupBinding(
      { ...reserved, format: 'private-lookup-binding/2' },
      blob,
      f.owner.identity
    )
  ).toThrow(expect.objectContaining({ code: 'unsupported' }))
})
it('rejects a current publication selecting a different lookup service or rules', () => {
  const { f, reserved, waiting, blob } = prepared()
  for (const lookup of [
    { ...waiting.lookup, service: 'ls_other' },
    { ...waiting.lookup, rulesDigest: 'ff'.repeat(32) }
  ]) {
    expect(() =>
      activatePrivateLookupBinding(reserved, { ...waiting, lookup }, blob, f.owner.identity)
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
  }
})
