import { canonicalOutputJSON, outputPrivatePublicationRequestDigest } from '@bsv/sdk'
import { parsePrivatePublicationContractRecord } from '../src/private/PrivatePublicationContractRecord.js'
import { parsePrivatePublicationContractMetadata } from '../src/private/PrivatePublicationContractRecord.js'
import { expect, it } from '@jest/globals'
import { signOutputPacket, Utils, outputPacketDigest } from '@bsv/sdk'
import { PrivatePublicationContracts } from '../src/private/PrivatePublicationContracts.js'
import { transactions } from './evidence-fixture.js'
import { contractFixture as fixture } from './private-publication-service-fixture.js'

it('keeps both public restoration defaults and checks original protected values independently', () => {
  const f = fixture()
  const { privateValues: _secret, ...reference } = f.request
  expect(
    parsePrivatePublicationContractMetadata(
      f.record,
      f.prepared.fence.state,
      reference,
      f.contracts,
      f.policy
    )
  ).toEqual(f.record)
  expect(f.restore()).toEqual(f.record)
  expect(() =>
    parsePrivatePublicationContractRecord(
      f.record,
      f.prepared.fence.state,
      { ...f.request, privateValues: 'BAUG' },
      f.contracts,
      f.policy
    )
  ).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private publication original contract binding differs'
    })
  )
})

it('retains original selection for recovery after its manifest can no longer start new work', () => {
  const f = fixture()
  expect(f.restore()).toEqual(f.record)
  expect(f.contracts.restore(f.retained.record)).toEqual(f.retained.selection)
  expect(() => f.contracts.retain(f.retained.record.manifest, '102')).toThrow()
  const restored = f.restore()
  restored.capability.manifest.body.baseURL = 'https://changed.example'
  restored.verificationContext.view.id = 'changed'
  expect(f.restore()).toEqual(f.record)
})
it('owns installation state independently of caller mutation', () => {
  const f = fixture(),
    installed = f.contracts.configuration()
  f.installation.schemas.push('urn:test:uninstalled')
  f.installation.topic = 'changed'
  installed.topic = 'also-changed'
  expect(f.contracts.configuration().topic).toBe('tm_synthetic')
  expect(f.contracts.configuration().schemas).toEqual(['urn:test:private-material'])
})
it.each(['schema', 'capacity', 'rules'] as const)(
  'rejects a signed profile with changed installed %s',
  change => {
    const f = fixture(),
      body = structuredClone(f.body)
    if (change === 'schema')
      body.services[0].profiles[0].parameters.schemas = ['urn:test:uninstalled']
    if (change === 'capacity') body.services[0].profiles[0].parameters.maxPrivateBytes = 100001
    if (change === 'rules') {
      body.services[0].rules.parameters.mode = 'changed'
      body.services[0].rulesDigest = outputPacketDigest('service-rules', body.services[0].rules)
    }
    expect(() => f.contracts.retain(signOutputPacket('capabilities', body, f.key), '20')).toThrow(
      expect.objectContaining({
        code:
          change === 'schema'
            ? 'unsupported'
            : change === 'capacity'
              ? 'limited'
              : 'context-changed'
      })
    )
  }
)
it.each(['publicationId', 'requestDigest', 'rawTransaction', 'verificationContext'] as const)(
  'requires the exact original %s in protected recovery',
  field => {
    const f = fixture(),
      value = structuredClone(f.record)
    if (field === 'publicationId' || field === 'requestDigest') value[field] = 'ff'.repeat(32)
    if (field === 'rawTransaction')
      value.rawTransaction = Utils.toBase64(transactions.get('Q')!.toBinary())
    if (field === 'verificationContext')
      value.verificationContext.view.chain.genesisHash = 'ff'.repeat(32)
    expect(() => f.restore(value)).toThrow(expect.objectContaining({ code: 'unavailable' }))
  }
)
it('requires the original immutable validation policy and rejects a tampered retained manifest', () => {
  const f = fixture(),
    changed = structuredClone(f.record)
  changed.validationPolicy.digest = 'ff'.repeat(32)
  expect(() => f.restore(changed)).toThrow(expect.objectContaining({ code: 'context-changed' }))
  const tampered = structuredClone(f.record)
  tampered.capability.manifest.body.expiresAt = '200'
  expect(() => f.restore(tampered)).toThrow()
})
it('rejects trailing bytes rather than normalizing protected raw transaction material', () => {
  const f = fixture()
  const bytes = [...Utils.toArray(f.record.rawTransaction, 'base64'), 0]
  expect(() => f.restore({ ...f.record, rawTransaction: Utils.toBase64(bytes) })).toThrow()
})
it.each([0, 1048577, 1.5])('rejects invalid installed byte capacity %s', maximumPrivateBytes => {
  const f = fixture()
  expect(
    () => new PrivatePublicationContracts({ ...f.installation, maximumPrivateBytes }, f.trust)
  ).toThrow(
    maximumPrivateBytes === 1.5
      ? 'Protocol numbers must be safe integers'
      : 'Invalid installed private capacity'
  )
})
it.each(
  [[], ['urn:test:a', 'urn:test:a'], Array.from({ length: 33 }, (_, i) => `urn:test:${i}`)].map(
    schemas => ({ schemas })
  )
)('requires a nonempty unique bounded schema installation: %j', ({ schemas }) => {
  const f = fixture()
  expect(() => new PrivatePublicationContracts({ ...f.installation, schemas }, f.trust)).toThrow(
    schemas.length === 2
      ? 'Duplicate installed private schema'
      : 'Invalid installed private schemas'
  )
})

it('accepts exact installed capacity and schema-count ceilings', () => {
  const f = fixture()
  const schemas = Array.from({ length: 32 }, (_, i) => `urn:test:schema-${i}`)
  const contracts = new PrivatePublicationContracts(
    { ...f.installation, maximumPrivateBytes: 1048576, schemas },
    f.trust
  )
  expect(contracts.configuration().maximumPrivateBytes).toBe(1048576)
  expect(contracts.configuration().schemas).toEqual(schemas)
  const body = structuredClone(f.body)
  body.services[0].profiles[0].parameters = { schemas, maxPrivateBytes: 1048576 }
  expect(
    contracts.retain(signOutputPacket('capabilities', body, f.key), '20').selection.profile
      .parameters
  ).toEqual({ schemas, maxPrivateBytes: 1048576 })
})
it('does not coerce numeric-string capacity and requires positive finite freshness', () => {
  const f = fixture()
  expect(
    () =>
      new PrivatePublicationContracts(
        { ...f.installation, maximumPrivateBytes: '10' as unknown as number },
        f.trust
      )
  ).toThrow('Invalid installed private capacity')
  expect(
    () => new PrivatePublicationContracts(f.installation, { ...f.trust, maximumAgeSeconds: '0' })
  ).toThrow('Publication capability freshness must be positive')
})
it('enforces the complete installation byte bound before parsing individual fields', () => {
  const f = fixture()
  expect(
    () => new PrivatePublicationContracts({ ...f.installation, topic: 'x'.repeat(17000) }, f.trust)
  ).toThrow(expect.objectContaining({ code: 'limited' }))
})
it('requires every advertised schema even if one schema is installed', () => {
  const f = fixture(),
    body = structuredClone(f.body)
  body.services[0].profiles[0].parameters.schemas = [
    f.installation.schemas[0],
    'urn:test:uninstalled'
  ]
  expect(() => f.contracts.retain(signOutputPacket('capabilities', body, f.key), '20')).toThrow(
    'Publication profile selects an uninstalled schema'
  )
})
it('retains supported critical manifest extensions independently of caller mutation', () => {
  const f = fixture(),
    extension = 'urn:test:private-publication-manifest'
  const supported = [extension]
  const contracts = new PrivatePublicationContracts(f.installation, {
    ...f.trust,
    supportedExtensions: supported
  })
  supported.length = 0
  const body = {
    ...f.body,
    extensions: { [extension]: { context: 'original' } },
    critical: [extension]
  }
  const retained = contracts.retain(signOutputPacket('capabilities', body, f.key), '20')
  expect(contracts.restore(retained.record)).toEqual(retained.selection)
  expect(() => f.contracts.retain(retained.record.manifest, '20')).toThrow(
    expect.objectContaining({ code: 'unsupported' })
  )
})
it('reports exact installation mismatches without accepting changed capacity or rules', () => {
  const f = fixture(),
    capacity = structuredClone(f.body),
    rules = structuredClone(f.body)
  capacity.services[0].profiles[0].parameters.maxPrivateBytes =
    f.installation.maximumPrivateBytes + 1
  expect(() => f.contracts.retain(signOutputPacket('capabilities', capacity, f.key), '20')).toThrow(
    'Publication profile exceeds installed private capacity'
  )
  rules.services[0].rules.parameters.mode = 'changed'
  rules.services[0].rulesDigest = outputPacketDigest('service-rules', rules.services[0].rules)
  expect(() => f.contracts.retain(signOutputPacket('capabilities', rules, f.key), '20')).toThrow(
    'Publication service rules differ from installation'
  )
})

it('checks original policy identity and version with stable public error identities', () => {
  const f = fixture()
  expect(() => f.restore({ ...f.record, format: 'private-publication-contract/2' })).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Unsupported private publication contract'
    })
  )
  for (const validationPolicy of [
    { ...f.policy, id: 'urn:test:another-validator' },
    { ...f.policy, digest: 'aa'.repeat(32) }
  ])
    expect(() => f.restore({ ...f.record, validationPolicy })).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Private publication validation policy changed'
      })
    )
})
it.each([
  'state-topic',
  'request-topic',
  'state-chain',
  'transaction',
  'request-txid',
  'request-output',
  'output-boundary'
] as const)('binds protected original metadata independently to %s', field => {
  const f = fixture(),
    state = structuredClone(f.prepared.fence.state)
  const { privateValues: _secret, ...reference } = structuredClone(f.request)
  if (field === 'state-topic') state.topic = 'tm_other'
  if (field === 'request-topic') reference.topic = 'tm_other'
  if (field === 'state-chain') state.chain.genesisHash = 'aa'.repeat(32)
  if (field === 'transaction') {
    state.txid = transactions.get('Q')!.id('hex')
    reference.evidence.txid = state.txid
  }
  if (field === 'request-txid') reference.evidence.txid = transactions.get('Q')!.id('hex')
  if (field === 'request-output') reference.evidence.outputIndex++
  if (field === 'output-boundary') {
    state.outputIndex = transactions.get('P')!.outputs.length
    reference.evidence.outputIndex = state.outputIndex
  }
  expect(() =>
    parsePrivatePublicationContractMetadata(f.record, state, reference, f.contracts, f.policy)
  ).toThrow(
    expect.objectContaining({
      code: 'unavailable',
      message: 'Private publication original contract binding differs'
    })
  )
})
it('checks the original schema without relying on the protected material digest', () => {
  const f = fixture(),
    { privateValues: _secret, ...reference } = f.request
  expect(() =>
    parsePrivatePublicationContractMetadata(
      f.record,
      f.prepared.fence.state,
      { ...reference, schema: 'urn:test:another-schema' },
      f.contracts,
      f.policy
    )
  ).toThrow(
    expect.objectContaining({
      code: 'unsupported',
      message: 'Private publication schema is absent from original contract'
    })
  )
})
it('retains exact private capacity and refuses the first byte above the original profile', () => {
  const f = fixture()
  for (const maximum of [3, 2]) {
    const body = structuredClone(f.body)
    body.services[0].profiles[0].parameters.maxPrivateBytes = maximum
    const capability = f.contracts.retain(
      signOutputPacket('capabilities', body, f.key),
      '20'
    ).record
    const record = { ...f.record, capability }
    if (maximum === 3) expect(f.restore(record)).toEqual(record)
    else
      expect(() => f.restore(record)).toThrow(
        expect.objectContaining({
          code: 'limited',
          message: 'Private publication exceeds original private capacity'
        })
      )
  }
})
it('enforces complete retained-metadata and installed-policy byte limits before semantic parsing', () => {
  const f = fixture()
  expect(() => f.restore({ ...f.record, rawTransaction: 'A'.repeat(1048576) })).toThrow(
    expect.objectContaining({ code: 'limited' })
  )
  expect(() =>
    parsePrivatePublicationContractMetadata(
      f.record,
      f.prepared.fence.state,
      f.request,
      f.contracts,
      { ...f.policy, id: 'x'.repeat(4096) }
    )
  ).toThrow(expect.objectContaining({ code: 'limited' }))
})

it('enforces the complete original request byte boundary independently of the private-value ceiling', () => {
  const f = fixture(),
    request = { ...f.request, privateValues: Utils.toBase64(Array.from({ length: 2048 }, () => 7)) }
  const requestDigest = outputPrivatePublicationRequestDigest(request)
  const state = { ...f.prepared.fence.state, requestDigest }
  const bytes = Buffer.byteLength(canonicalOutputJSON(request))
  for (const maximum of [bytes, bytes - 1]) {
    const body = structuredClone(f.body)
    body.services[0].profiles[0].maxRequestBytes = maximum
    const capability = f.contracts.retain(
      signOutputPacket('capabilities', body, f.key),
      '20'
    ).record
    const record = { ...f.record, requestDigest, capability }
    const restore = () =>
      parsePrivatePublicationContractRecord(record, state, request, f.contracts, f.policy)
    if (maximum === bytes) expect(restore()).toEqual(record)
    else expect(restore).toThrow(expect.objectContaining({ code: 'limited' }))
  }
})
