import {
  bindOutputPaidLookupAcquired,
  bindOutputPaidLookupChallenge,
  outputPacketDigest,
  parseOutputPaidLookupAcquire,
  parseOutputPaidLookupAcquired,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupRecover,
  PrivateKey,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupAcquired
} from '../../../mod.js'

function fixture() {
  const seller = new PrivateKey(83).toPublicKey().toString(),
    buyer = new PrivateKey(84).toPublicKey().toString()
  const chain = { network: 'paid-fixture', genesisHash: '11'.repeat(32) }
  const request: OutputPaidLookupAcquire = {
    version: 1,
    requestId: 'paid_lookup_fixture',
    service: 'ls_fixture',
    assetId: '22'.repeat(32),
    listing: { chain, txid: '33'.repeat(32), outputIndex: 1 },
    termsDigest: '44'.repeat(32),
    recipient: buyer,
    request: 'AA=='
  }
  const selected = { seller, rulesDigest: '55'.repeat(32) }
  const challenge: OutputPaidLookupChallenge = {
    version: 1,
    acquisitionId: outputPacketDigest('acquisition', {
      chain,
      seller,
      buyer,
      service: request.service,
      requestId: request.requestId
    }),
    requestDigest: outputPacketDigest('acquire-request', request),
    seller,
    buyer,
    assetId: request.assetId,
    termsDigest: request.termsDigest,
    satoshis: '100',
    derivationPrefix: 'fixture-hex-1234',
    acceptancePolicy: { kind: 'local-admission' },
    rulesDigest: selected.rulesDigest,
    payableUntil: '100',
    recoveryUntil: '86500'
  }
  const funding = { chain, txid: '66'.repeat(32), outputIndex: 2 }
  const acceptance = {
    chain,
    txid: funding.txid,
    policy: challenge.acceptancePolicy,
    acceptedAt: '101'
  }
  const result = {
    evidence: { txid: request.listing.txid, outputIndex: 1, beef: 'AA==' },
    context: 'AQ==',
    schema: 'urn:fixture:context'
  }
  const common = {
    version: 1 as const,
    acquisitionId: challenge.acquisitionId,
    recoveryUntil: challenge.recoveryUntil,
    challenge
  }
  const delivered: OutputPaidLookupAcquired = {
    ...common,
    status: 'delivered',
    funding,
    acceptance,
    result
  }
  return { request, selected, challenge, funding, acceptance, result, common, delivered }
}

test('owns bounded acquire and uncharged recover requests with explicit extension support', () => {
  const { request } = fixture()
  const owned = parseOutputPaidLookupAcquire(JSON.stringify(request))
  expect(owned).toEqual(request)
  request.listing.chain.network = 'changed'
  expect(owned.listing.chain.network).toBe('paid-fixture')
  const extension = {
    ...owned,
    extensions: { 'urn:fixture:terms': true },
    critical: ['urn:fixture:terms']
  }
  expect(() => parseOutputPaidLookupAcquire(extension)).toThrow('Unsupported critical')
  expect(parseOutputPaidLookupAcquire(extension, ['urn:fixture:terms'])).toEqual(extension)
  expect(() => parseOutputPaidLookupAcquire({ ...owned, paid: true })).toThrow('Unknown')
  const query = { version: 1, acquisitionId: '11'.repeat(32) }
  expect(parseOutputPaidLookupRecover(query)).toEqual(query)
  expect(() => parseOutputPaidLookupRecover({ ...query, buyer: owned.recipient })).toThrow(
    'Unknown'
  )
})

test('requires a positive wallet-range amount, bounded ASCII prefix and exact one-day recovery floor', () => {
  const { challenge } = fixture()
  expect(parseOutputPaidLookupChallenge(challenge)).toEqual(challenge)
  for (const derivationPrefix of [
    'abcdef0123',
    'Zm9v',
    'x'.repeat(128),
    String.fromCharCode(0, 127)
  ])
    expect(
      parseOutputPaidLookupChallenge({ ...challenge, derivationPrefix }).derivationPrefix
    ).toBe(derivationPrefix)
  for (const derivationPrefix of ['', 'x'.repeat(129), 'é', String.fromCharCode(128), 1])
    expect(() => parseOutputPaidLookupChallenge({ ...challenge, derivationPrefix })).toThrow(
      'bounded ASCII'
    )
  for (const satoshis of ['1', '2100000000000000'])
    expect(parseOutputPaidLookupChallenge({ ...challenge, satoshis }).satoshis).toBe(satoshis)
  for (const satoshis of ['0', '2100000000000001'])
    expect(() => parseOutputPaidLookupChallenge({ ...challenge, satoshis })).toThrow(
      'positive BRC-100'
    )
  for (const dates of [
    { payableUntil: '100', recoveryUntil: '86499' },
    { payableUntil: '18446744073709551615', recoveryUntil: '18446744073709551615' }
  ])
    expect(() => parseOutputPaidLookupChallenge({ ...challenge, ...dates })).toThrow(
      'less than one day'
    )
})

test('binds the complete original acquire request to an independently selected seller and rules', () => {
  const { request, selected, challenge } = fixture()
  expect(bindOutputPaidLookupChallenge(challenge, request, selected)).toEqual(challenge)
  for (const change of [
    { requestId: 'paid_lookup_changed' },
    { service: 'other' },
    { assetId: '77'.repeat(32) },
    { termsDigest: '88'.repeat(32) },
    { recipient: selected.seller },
    { request: 'AQ==' },
    { listing: { ...request.listing, outputIndex: 0 } }
  ])
    expect(() =>
      bindOutputPaidLookupChallenge(challenge, { ...request, ...change }, selected)
    ).toThrow('selected request')
  for (const change of [
    { acquisitionId: '77'.repeat(32) },
    { requestDigest: '88'.repeat(32) },
    { seller: request.recipient },
    { buyer: selected.seller },
    { assetId: '99'.repeat(32) },
    { termsDigest: 'aa'.repeat(32) },
    { rulesDigest: 'bb'.repeat(32) }
  ])
    expect(() =>
      bindOutputPaidLookupChallenge({ ...challenge, ...change }, request, selected)
    ).toThrow('selected request')
  expect(() =>
    bindOutputPaidLookupChallenge(challenge, request, { ...selected, seller: request.recipient })
  ).toThrow('selected request')
  expect(() =>
    bindOutputPaidLookupChallenge(challenge, request, { ...selected, rulesDigest: 'bb'.repeat(32) })
  ).toThrow('selected request')
})

test('enforces every acquisition state while retaining funding uncertainty and historical recovery', () => {
  const { common, funding, acceptance, result } = fixture()
  const valid = [
    { ...common, status: 'quoted' },
    { ...common, status: 'funding-pending', funding },
    {
      ...common,
      status: 'funding-pending',
      funding,
      acceptance,
      reason: 'wallet reconciliation pending'
    },
    { ...common, status: 'funded', funding, acceptance },
    { ...common, status: 'delivery-pending', funding, acceptance },
    { ...common, status: 'delivered', funding, acceptance, result },
    { ...common, status: 'failed', reason: 'local decision' },
    { ...common, status: 'failed', funding, acceptance, reason: 'local decision' },
    { ...common, status: 'expired', reason: 'never funded' }
  ]
  for (const value of valid) expect(parseOutputPaidLookupAcquired(value)).toEqual(value)
  for (const field of [{ funding }, { acceptance }, { result }, { reason: 'unexpected' }])
    expect(() => parseOutputPaidLookupAcquired({ ...common, status: 'quoted', ...field })).toThrow(
      'Quoted lookup'
    )
  for (const field of [{ funding }, { acceptance }, { result }])
    expect(() =>
      parseOutputPaidLookupAcquired({ ...common, status: 'expired', reason: 'expired', ...field })
    ).toThrow('Expired lookup')
  expect(() => parseOutputPaidLookupAcquired({ ...common, status: 'expired' })).toThrow(
    'Expired lookup'
  )
  expect(() => parseOutputPaidLookupAcquired({ ...common, status: 'failed' })).toThrow(
    'retained reason'
  )
  for (const status of ['funding-pending', 'funded', 'delivery-pending', 'delivered'])
    expect(() => parseOutputPaidLookupAcquired({ ...common, status, acceptance })).toThrow(
      'requires funding'
    )
  for (const status of ['funded', 'delivery-pending', 'delivered'])
    expect(() => parseOutputPaidLookupAcquired({ ...common, status, funding })).toThrow(
      'requires acceptance'
    )
  for (const status of ['funding-pending', 'funded', 'delivery-pending', 'failed'])
    expect(() =>
      parseOutputPaidLookupAcquired({
        ...common,
        status,
        funding,
        acceptance,
        result,
        reason: 'fixture'
      })
    ).toThrow('requires delivered')
  expect(() =>
    parseOutputPaidLookupAcquired({ ...common, status: 'delivered', funding, acceptance })
  ).toThrow('requires delivered')
  expect(() =>
    parseOutputPaidLookupAcquired({ ...common, status: 'failed', acceptance, reason: 'fixture' })
  ).toThrow('requires funding')
})

test('rejects changed acquisition, shortened recovery and substituted release evidence', () => {
  const { delivered } = fixture()
  expect(
    parseOutputPaidLookupAcquired({ ...delivered, recoveryUntil: '86501' }).recoveryUntil
  ).toBe('86501')
  for (const change of [{ acquisitionId: '77'.repeat(32) }, { recoveryUntil: '86499' }])
    expect(() => parseOutputPaidLookupAcquired({ ...delivered, ...change })).toThrow(
      'changed acquisition or recovery'
    )
  for (const change of [
    { txid: '88'.repeat(32) },
    { chain: { ...delivered.funding!.chain, network: 'other' } },
    { policy: { kind: 'mined', confirmations: 1 } }
  ])
    expect(() =>
      parseOutputPaidLookupAcquired({
        ...delivered,
        acceptance: { ...delivered.acceptance, ...change }
      })
    ).toThrow()
})

test('binds original quote and purchased output independently of current catalogue and clock', () => {
  const { request, selected, challenge, delivered } = fixture()
  expect(bindOutputPaidLookupAcquired(delivered, challenge, request, selected)).toEqual(delivered)
  expect(() =>
    bindOutputPaidLookupAcquired(
      { ...delivered, challenge: { ...challenge, satoshis: '101' } },
      challenge,
      request,
      selected
    )
  ).toThrow('replaced frozen challenge')
  const otherChain = { ...request.listing.chain, network: 'other' }
  expect(() =>
    bindOutputPaidLookupAcquired(
      {
        ...delivered,
        funding: { ...delivered.funding, chain: otherChain },
        acceptance: { ...delivered.acceptance, chain: otherChain }
      },
      challenge,
      request,
      selected
    )
  ).toThrow('funding chain changed')
  for (const changed of [{ txid: '77'.repeat(32) }, { outputIndex: 2 }])
    expect(() =>
      bindOutputPaidLookupAcquired(
        {
          ...delivered,
          result: { ...delivered.result, evidence: { ...delivered.result!.evidence, ...changed } }
        },
        challenge,
        request,
        selected
      )
    ).toThrow('changed frozen output')
  const quoted = {
    version: 1,
    acquisitionId: challenge.acquisitionId,
    recoveryUntil: challenge.recoveryUntil,
    challenge,
    status: 'quoted'
  }
  expect(bindOutputPaidLookupAcquired(quoted, challenge, request, selected)).toEqual(quoted)
})
