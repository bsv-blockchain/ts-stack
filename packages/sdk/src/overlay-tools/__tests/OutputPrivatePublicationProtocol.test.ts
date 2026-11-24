import {
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  parseOutputPrivatePublish,
  parseOutputPrivatePublicationStatus,
  parseOutputPrivatePublicationResult,
  type OutputPrivatePublish
} from '../../../mod.js'

function publication(): OutputPrivatePublish {
  return {
    version: 1,
    requestId: 'publication_fixture_1',
    topic: 'tm_fixture',
    evidence: { txid: '11'.repeat(32), outputIndex: 0, beef: 'AA==' },
    assetId: '22'.repeat(32),
    schema: 'urn:fixture:private',
    privateValues: 'AQ=='
  }
}

test('private publication owns the complete bounded request without accepting trust claims', () => {
  const input = publication()
  const value = parseOutputPrivatePublish(JSON.stringify(input))
  expect(value).toEqual(input)
  input.evidence.txid = '33'.repeat(32)
  expect(value.evidence.txid).toBe('11'.repeat(32))
  for (const extra of [{ authenticated: true }, { paid: true }, { recipient: 'someone' }])
    expect(() => parseOutputPrivatePublish({ ...value, ...extra })).toThrow('Unknown')
  expect(
    parseOutputPrivatePublish({ ...value, privateValues: Buffer.alloc(1048576).toString('base64') })
      .privateValues.length
  ).toBeGreaterThan(1048576)
  expect(() =>
    parseOutputPrivatePublish({ ...value, privateValues: Buffer.alloc(1048577).toString('base64') })
  ).toThrow('exceeds 1 MiB')
})

test('semantic publication digest excludes only proof bytes and preserves every protected binding', () => {
  const input = publication()
  const digest = outputPrivatePublicationRequestDigest(input)
  expect(digest).toBe(
    outputPacketDigest('publication-request', {
      ...input,
      evidence: { txid: input.evidence.txid, outputIndex: input.evidence.outputIndex }
    })
  )
  expect(
    outputPrivatePublicationRequestDigest({
      ...input,
      evidence: { ...input.evidence, beef: 'AQ==' }
    })
  ).toBe(digest)
  for (const change of [
    { requestId: 'publication_fixture_2' },
    { topic: 'other' },
    { assetId: '33'.repeat(32) },
    { schema: 'urn:fixture:other' },
    { privateValues: 'Ag==' },
    { evidence: { ...input.evidence, txid: '44'.repeat(32) } },
    { evidence: { ...input.evidence, outputIndex: 1 } },
    { extensions: { 'urn:fixture:extra': true } }
  ])
    expect(outputPrivatePublicationRequestDigest({ ...input, ...change })).not.toBe(digest)
})

test('private publication requires explicit support for critical extensions in parsing and digesting', () => {
  const input = {
    ...publication(),
    extensions: { 'urn:fixture:private': true },
    critical: ['urn:fixture:private']
  }
  for (const parse of [parseOutputPrivatePublish, outputPrivatePublicationRequestDigest]) {
    expect(() => parse(input)).toThrow('Unsupported critical')
    expect(() => parse(input, ['urn:fixture:private'])).not.toThrow()
  }
})

test('publication status is closed and rejected or expired records retain their reason', () => {
  const query = { version: 1, publicationId: '33'.repeat(32) }
  expect(parseOutputPrivatePublicationStatus(query)).toEqual(query)
  expect(() => parseOutputPrivatePublicationStatus({ ...query, authorized: true })).toThrow(
    'Unknown'
  )
  for (const status of ['pending', 'ready', 'unavailable', 'rejected', 'expired']) {
    const value = { ...query, txid: '11'.repeat(32), status, updatedAt: '1' }
    expect(parseOutputPrivatePublicationResult({ ...value, reason: 'fixture status' })).toEqual({
      ...value,
      reason: 'fixture status'
    })
    if (status === 'rejected' || status === 'expired')
      expect(() => parseOutputPrivatePublicationResult(value)).toThrow('retained reason')
    else expect(parseOutputPrivatePublicationResult(value)).toEqual(value)
  }
})
