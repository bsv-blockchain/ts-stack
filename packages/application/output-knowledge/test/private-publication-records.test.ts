import { expect, it } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { PrivateKey } from '@bsv/sdk'
import { PrivateServiceIdentity } from '../src/private/PrivateServiceIdentity.js'
import {
  createPrivatePublicationRecords as create,
  parsePrivatePublicationRecords as parse,
  parsePrivatePublicationBlob,
  privatePublicationBlobAddress,
  privatePublicationFenceAddress
} from '../src/private/PrivatePublicationRecords.js'
import {
  advancePrivatePublicationProgress as advance,
  privatePublicationOperation
} from '../src/private/PrivatePublicationProgress.js'

const key = createSecretKey(Buffer.alloc(32, 91))
const selected = () => ({
  publisher: new PrivateKey(1).toPublicKey().toString(),
  chain: { network: 'main', genesisHash: '11'.repeat(32) },
  lookup: { service: 'ls_synthetic', rulesDigest: '22'.repeat(32) }
})
const identity = () =>
  new PrivateServiceIdentity(
    { seller: selected().publisher, chain: selected().chain },
    { resolve: () => key },
    'index'
  )
const request = () => ({
  version: 1,
  requestId: 'synthetic-publish-1',
  topic: 'tm_synthetic',
  evidence: { txid: '33'.repeat(32), outputIndex: 1, beef: 'AQ==' },
  assetId: '44'.repeat(32),
  schema: 'urn:synthetic:private:1',
  privateValues: 'Ag=='
})
const records = () => create(request(), identity(), selected(), '10', '20')

it('keeps one owned protected blob distinct from each permanent operation fence', () => {
  const first = records()
  const decoded = parse(first.fence, first.blob, identity())
  expect(decoded.request).toEqual(request())
  expect(decoded.fence).toEqual(first.fence)
  expect(first.fence.reference).not.toHaveProperty('privateValues')
  const second = create(
    { ...request(), requestId: 'synthetic-publish-2' },
    identity(),
    selected(),
    '10',
    '20'
  )
  expect(second.blob).toEqual(first.blob)
  expect(second.fence.state.blobKey).toBe(first.fence.state.blobKey)
  expect(privatePublicationFenceAddress(identity(), second.fence.state.publicationId)).not.toEqual(
    privatePublicationFenceAddress(identity(), first.fence.state.publicationId)
  )
})
it('permits independently verified proof variants without changing the semantic fence', () => {
  const first = records(),
    variant = structuredClone(first.fence)
  variant.reference.evidence.beef = 'Aw=='
  expect(parse(variant, first.blob, identity()).fence.state).toEqual(first.fence.state)
})
it('allows recovered admission after the staging deadline without resetting identity', () => {
  const first = records()
  first.fence.state = advance(first.fence.state, { kind: 'reserve-admission' }, '11')
  first.fence.state = advance(
    first.fence.state,
    {
      kind: 'admitted',
      admission: {
        operationId: privatePublicationOperation(first.fence.state),
        txid: request().evidence.txid,
        assessmentContextId: 'synthetic-context',
        steak: { tm_synthetic: { outputsToAdmit: [1], coinsToRetain: [] } }
      }
    },
    '100'
  )
  expect(parse(first.fence, first.blob, identity()).fence.state.progress.phase).toBe('binding')
})
it.each(['topic', 'assetId', 'schema', 'privateValues'] as const)(
  'refuses a changed retained %s without rewriting its fence',
  field => {
    const first = records()
    if (field === 'privateValues') first.blob.privateValues = 'BA=='
    else first.blob.binding[field] = field === 'assetId' ? '55'.repeat(32) : 'changed'
    expect(() => parse(first.fence, first.blob, identity())).toThrow('retained binding differs')
  }
)
it.each([
  'publicationId',
  'requestDigest',
  'blobKey',
  'publisher',
  'topic',
  'txid',
  'outputIndex',
  'chain'
] as const)('cross-checks retained progress %s with the request and blob', field => {
  const first = records()
  const state = first.fence.state
  if (field === 'publisher') state.publisher = new PrivateKey(2).toPublicKey().toString()
  else if (field === 'outputIndex') state.outputIndex = 2
  else if (field === 'chain') state.chain.genesisHash = '55'.repeat(32)
  else state[field] = field === 'topic' ? 'changed' : '55'.repeat(32)
  expect(() => parse(first.fence, first.blob, identity())).toThrow('retained binding differs')
})
it('does not permit a second private-values field to shadow the protected blob', () => {
  const first = records()
  expect(() =>
    parse(
      { ...first.fence, reference: { ...first.fence.reference, privateValues: 'BA==' } },
      first.blob,
      identity()
    )
  ).toThrow()
})
it('owns all fields before an installed custody callback can modify the selection', () => {
  const choice = selected(),
    original = structuredClone(choice),
    input = request(),
    originalRequest = request()
  let active = false
  const owner = new PrivateServiceIdentity(
    { seller: choice.publisher, chain: choice.chain },
    {
      resolve() {
        if (active) {
          choice.publisher = new PrivateKey(2).toPublicKey().toString()
          choice.lookup.service = 'changed'
          input.privateValues = 'BA=='
        }
        return key
      }
    },
    'index'
  )
  active = true
  const first = create(input, owner, choice, '10', '20')
  expect(first.fence.state.publisher).toBe(original.publisher)
  expect(first.fence.state.lookup).toEqual(original.lookup)
  expect(first.blob.privateValues).toBe(originalRequest.privateValues)
  const parsed = parse(first.fence, first.blob, identity())
  parsed.blob.privateValues = 'BQ=='
  parsed.fence.state.lookup.service = 'mutated'
  expect(first.blob.privateValues).toBe(originalRequest.privateValues)
  expect(first.fence.state.lookup).toEqual(original.lookup)
})
it('checks format, unknown fields and payload bounds when loading a blob', () => {
  const first = records()
  for (const patch of [
    { format: 'future' },
    { extra: true },
    { privateValues: '!' },
    { binding: { ...first.blob.binding, outputIndex: -1 } },
    { privateValues: Buffer.alloc(1048577).toString('base64') }
  ]) {
    expect(() => parsePrivatePublicationBlob({ ...first.blob, ...patch })).toThrow()
  }
  for (const patch of [{ format: 'future' }, { extra: true }]) {
    expect(() => parse({ ...first.fence, ...patch }, first.blob, identity())).toThrow()
  }
})
it('separates blob identity by output, schema and chain, independent of the request ID', () => {
  const first = records(),
    original = privatePublicationBlobAddress(identity(), first.blob.binding)
  for (const patch of [
    { outputIndex: 2 },
    { txid: '55'.repeat(32) },
    { topic: 'other' },
    { schema: 'urn:synthetic:private:2' },
    { chain: { ...selected().chain, network: 'test' } }
  ]) {
    expect(
      privatePublicationBlobAddress(identity(), { ...first.blob.binding, ...patch })
    ).not.toEqual(original)
  }
})
it('rejects unknown critical extensions rather than losing their semantic fence', () => {
  const input = {
    ...request(),
    extensions: { 'urn:synthetic:extension': { value: 1 } },
    critical: ['urn:synthetic:extension']
  }
  expect(() => create(input, identity(), selected(), '10', '20')).toThrow()
  const first = create(input, identity(), selected(), '10', '20', input.critical)
  expect(() => parse(first.fence, first.blob, identity())).toThrow()
  expect(parse(first.fence, first.blob, identity(), input.critical).request).toEqual(input)
})
