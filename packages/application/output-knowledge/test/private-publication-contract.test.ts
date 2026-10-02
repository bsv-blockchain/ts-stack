import { expect, it } from '@jest/globals'
import { signOutputPacket, Utils, outputPacketDigest } from '@bsv/sdk'
import { PrivatePublicationContracts } from '../src/private/PrivatePublicationContracts.js'
import { transactions } from './evidence-fixture.js'
import { contractFixture as fixture } from './private-publication-service-fixture.js'

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
  ).toThrow()
})
it.each(
  [[], ['urn:test:a', 'urn:test:a'], Array.from({ length: 33 }, (_, i) => `urn:test:${i}`)].map(
    schemas => ({ schemas })
  )
)('requires a nonempty unique bounded schema installation: %j', ({ schemas }) => {
  const f = fixture()
  expect(() => new PrivatePublicationContracts({ ...f.installation, schemas }, f.trust)).toThrow()
})
