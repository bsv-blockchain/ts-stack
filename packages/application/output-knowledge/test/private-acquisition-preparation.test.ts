import { expect, it } from '@jest/globals'
import { ownPrivateAcquisitionPreparation } from '../src/private/PrivateAcquisitionPorts.js'
import { acquisitionRecordFixture } from './private-acquisition-records.fixture.js'
async function fixture() {
  const f = await acquisitionRecordFixture()
  return {
    terms: f.terms,
    evidence: f.evidence,
    verificationContext: f.verificationContext,
    schema: f.input.schema,
    maximumContextBytes: 65536,
    maximumAcceptanceBytes: 131072,
    material: 'AQID'
  }
}
it('owns bounded local material separately from network metadata without truncation', async () => {
  const input = await fixture()
  input.material = Buffer.alloc(4194304, 73).toString('base64')
  const owned = ownPrivateAcquisitionPreparation(input)
  expect(owned.material).toBe(input.material)
  input.terms.satoshis = '900'
  expect(owned.terms.satoshis).toBe('100')
  expect(() =>
    ownPrivateAcquisitionPreparation({
      ...input,
      material: Buffer.alloc(4194305).toString('base64')
    })
  ).toThrow()
})
it.each(['getter', 'hidden', 'extra', 'symbol', 'prototype', 'missing'] as const)(
  'refuses %s preparation records without executing an accessor',
  async kind => {
    const input = await fixture()
    let called = false
    if (kind === 'getter')
      Object.defineProperty(input, 'material', {
        get: () => {
          called = true
          return 'AQID'
        }
      })
    if (kind === 'hidden')
      Object.defineProperty(input, 'material', { value: 'AQID', enumerable: false })
    if (kind === 'extra') Object.assign(input, { extra: 1 })
    if (kind === 'symbol') Object.assign(input, { [Symbol('private')]: 1 })
    if (kind === 'prototype') Object.setPrototypeOf(input, null)
    if (kind === 'missing') delete (input as Partial<typeof input>).material
    expect(() => ownPrivateAcquisitionPreparation(input)).toThrow()
    expect(called).toBe(false)
  }
)
it.each([0, -1, 1.5, 4194305])(
  'rejects invalid context allowance %s',
  async maximumContextBytes => {
    const input = await fixture()
    expect(() => ownPrivateAcquisitionPreparation({ ...input, maximumContextBytes })).toThrow()
  }
)
it('rejects malformed terms, evidence, encoded material and acceptance allowance', async () => {
  const input = await fixture()
  for (const value of [
    { ...input, material: 'not base64' },
    { ...input, maximumAcceptanceBytes: 131073 },
    { ...input, terms: { ...input.terms, payableUntil: '-1' } },
    { ...input, evidence: { ...input.evidence, txid: 'bad' } }
  ])
    expect(() => ownPrivateAcquisitionPreparation(value)).toThrow()
})
