import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { revenueListingPurchaseCommitment } from '../../script/templates/RevenueListingSpend.js'
import {
  Beef,
  Utils,
  canonicalOutputJSON,
  outputPacketDigest,
  parseOutputPotatoes,
  parseOutputPurchaseEnvelope,
  parseOutputPurchasePrepare,
  parseOutputPurchaseRecover,
  parseOutputPurchaseSubmit,
  parseOutputPurchaseTerms,
  PrivateKey,
  signOutputPacket,
  verifyOutputPurchaseEnvelope,
  verifyOutputPurchaseTerms,
  type OutputPurchasePrepare,
  type OutputPurchaseTerms,
  type OutputReleaseEvidence,
  type OutputSignedPotatoes
} from '../../../mod.js'

const sellerKey = new PrivateKey(79),
  recipientKey = new PrivateKey(80)
const seller = sellerKey.toPublicKey().toString(),
  recipient = recipientKey.toPublicKey().toString()
const chain = { network: 'purchase-fixture', genesisHash: '11'.repeat(32) }
const txid = '22'.repeat(32)
function fixture() {
  const request: OutputPurchasePrepare = {
    version: 1,
    requestId: 'purchase_fixture_01',
    topic: 'tm_fixture',
    listing: { chain: { ...chain }, txid: '33'.repeat(32), outputIndex: 0 },
    assetId: '44'.repeat(32),
    termsDigest: '55'.repeat(32),
    recipient,
    request: 'AA=='
  }
  const acquisitionId = outputPacketDigest('purchase', {
    chain,
    seller,
    recipient,
    topic: request.topic,
    requestId: request.requestId
  })
  const body: OutputPurchaseTerms = {
    version: 1,
    acquisitionId,
    requestDigest: outputPacketDigest('purchase-request', request),
    seller,
    recipient,
    topic: request.topic,
    listing: request.listing,
    assetId: request.assetId,
    termsDigest: request.termsDigest,
    domainProfile: 'urn:fixture:domain',
    domainEvidence: { schema: 'urn:fixture:lineage', bytes: 'AA==' },
    releasePolicy: { kind: 'local-admission' },
    purchaseUntil: '100',
    recoveryUntil: '86500'
  }
  const terms = signOutputPacket('purchase-terms', body, sellerKey)
  const evidence: OutputReleaseEvidence = {
    chain,
    txid,
    policy: body.releasePolicy,
    acceptedAt: '90'
  }
  const potatoesBody: OutputSignedPotatoes['body'] = {
    version: 1,
    acquisitionId,
    requestDigest: body.requestDigest,
    seller,
    recipient,
    topic: body.topic,
    txid,
    assetId: body.assetId,
    termsDigest: body.termsDigest,
    releasePolicy: body.releasePolicy,
    evidenceDigest: outputPacketDigest('release-evidence', evidence),
    schema: 'urn:fixture:secret',
    secret: 'AA==',
    issuedAt: '91',
    recoveryUntil: body.recoveryUntil
  }
  const envelope = {
    result: {
      version: 1,
      acquisitionId,
      txid,
      status: 'delivered',
      steak: { tm_fixture: { outputsToAdmit: [0], coinsToRetain: [] } },
      potatoes: signOutputPacket('potatoes', potatoesBody, sellerKey),
      recoveryUntil: body.recoveryUntil
    },
    releaseEvidence: evidence
  }
  return { request, body, terms, evidence, potatoesBody, envelope }
}

describe('BRC-196 closed purchase envelopes and original-contract bindings', () => {
  it('matches both unchanged signed purchase examples from the current independent BRC corpus', () => {
    const bytes = readFileSync(resolve(__dirname, 'fixtures/purchase-commitment-wire.json.gz'))
    const vectors = JSON.parse(gunzipSync(bytes).toString('utf8'))
    expect(vectors.source.commit).toBe('1b9a75e497b5856675af1ce01fd86843c37d07f9')
    expect(vectors.source.archiveSHA256).toBe(
      'a8f130d7b0fd89fb301e9327ecef2eb5f39374efb6ade9d7fc0b88c11c63e2eb'
    )
    expect(vectors.cases).toHaveLength(2)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '9451fecbcc446e507b3c3a78355e43dc6f31ab806aa01ea8f94b3282bca04502'
    )
    for (const vector of vectors.cases) {
      const beef = Beef.fromBinaryStrict(Utils.toArray(vector.submit.beef, 'base64'))
      const transaction = beef.findTransactionForSigning(vector.submit.txid)!
      expect(transaction.id('hex')).toBe(vector.submit.txid)
      expect(revenueListingPurchaseCommitment(transaction)).toBe(
        vector.envelope.result.purchaseCommitment
      )
      const terms = verifyOutputPurchaseTerms(
        vector.terms,
        vector.prepare,
        vector.terms.body.seller
      )
      expect(
        verifyOutputPurchaseEnvelope(
          vector.pending,
          terms,
          vector.submit.txid,
          vector.envelope.result.purchaseCommitment
        )
      ).toEqual(vector.pending)
      const result = verifyOutputPurchaseEnvelope(
        vector.envelope,
        terms,
        vector.submit.txid,
        vector.envelope.result.purchaseCommitment
      )
      expect(result).toEqual(vector.envelope)
      expect(result.result.status).toBe('delivered')
    }
  })
  function committedFixture() {
    const original = fixture()
    const purchaseCommitment = 'ab'.repeat(32)
    const terms = signOutputPacket(
      'purchase-terms',
      {
        ...original.body,
        domainProfile: 'https://bsv.brc.dev/tokens/0197#listing-purchase-v1'
      },
      sellerKey
    )
    const envelope = {
      ...original.envelope,
      result: {
        ...original.envelope.result,
        purchaseCommitment,
        potatoes: signOutputPacket(
          'potatoes',
          { ...original.potatoesBody, purchaseCommitment },
          sellerKey
        )
      },
      currentAlias: { txid: 'cd'.repeat(32), beef: 'AQ==' }
    }
    return { ...original, terms, envelope, purchaseCommitment }
  }

  it('retains a current alias separately from the exact historical signed release', () => {
    const { envelope, terms, purchaseCommitment } = committedFixture()
    const original = canonicalOutputJSON(envelope)
    const owned = verifyOutputPurchaseEnvelope(envelope, terms, txid, purchaseCommitment)
    expect(canonicalOutputJSON(owned)).toBe(original)
    expect(owned.result).toEqual(envelope.result)
    expect(owned.releaseEvidence?.txid).toBe(txid)
    expect(owned.currentAlias?.txid).not.toBe(txid)
    envelope.currentAlias.beef = 'Ag=='
    expect(owned.currentAlias?.beef).toBe('AQ==')
    // A transport alias is unverified evidence. It cannot substitute for the
    // historical transaction expected by the independent entitlement owner.
    expect(() =>
      verifyOutputPurchaseEnvelope(owned, terms, owned.currentAlias!.txid, purchaseCommitment)
    ).toThrow('transaction mismatch')
  })

  it('requires the exemplar commitment after reservation but leaves other domains independent', () => {
    const { terms, envelope, purchaseCommitment } = committedFixture()
    const base = {
      version: 1,
      acquisitionId: terms.body.acquisitionId,
      recoveryUntil: terms.body.recoveryUntil
    }
    for (const status of ['prepared', 'expired']) {
      const simple = { result: { ...base, status } }
      expect(verifyOutputPurchaseEnvelope(simple, terms)).toEqual(simple)
      expect(() =>
        parseOutputPurchaseEnvelope({ result: { ...base, status, purchaseCommitment } })
      ).toThrow('Unknown')
      expect(() =>
        parseOutputPurchaseEnvelope({ ...simple, currentAlias: envelope.currentAlias })
      ).toThrow('reserved purchase')
    }
    for (const status of [
      'admission-pending',
      'admission-rejected',
      'admitted-delivery-pending',
      'delivery-failed',
      'delivered'
    ]) {
      const admitted = ['admitted-delivery-pending', 'delivery-failed', 'delivered'].includes(
        status
      )
      const decided = ['admission-rejected', 'delivery-failed'].includes(status)
      const input = {
        result: {
          ...base,
          txid,
          status,
          purchaseCommitment,
          ...(admitted ? { steak: envelope.result.steak } : {}),
          ...(decided
            ? {
                decision: {
                  reason: 'Local decision',
                  policy: terms.body.releasePolicy,
                  evidence: 'AA==',
                  decidedAt: '92',
                  globalOutcome: 'unknown'
                }
              }
            : {}),
          ...(status === 'delivered' ? { potatoes: envelope.result.potatoes } : {})
        },
        ...(status === 'delivered' ? { releaseEvidence: envelope.releaseEvidence } : {})
      }
      expect(verifyOutputPurchaseEnvelope(input, terms, txid, purchaseCommitment)).toEqual(input)
      const missing: Record<string, unknown> = { ...input.result }
      delete missing.purchaseCommitment
      if (status === 'delivered') missing.potatoes = fixture().envelope.result.potatoes
      expect(() =>
        verifyOutputPurchaseEnvelope({ ...input, result: missing }, terms, txid)
      ).toThrow('commitment required')
    }
    const other = fixture()
    expect(verifyOutputPurchaseEnvelope(other.envelope, other.terms, txid)).toEqual(other.envelope)
  })

  it('checks the full supplied commitment without accepting a digest as Bitcoin proof', () => {
    const { envelope, terms, purchaseCommitment, potatoesBody } = committedFixture()
    expect(() => verifyOutputPurchaseEnvelope(envelope, terms, txid, 'ef'.repeat(32))).toThrow(
      'commitment mismatch'
    )
    for (const wrong of ['ab', 'AB'.repeat(32), 'ab'.repeat(31), 'ab'.repeat(33), null])
      expect(() =>
        parseOutputPurchaseEnvelope({
          ...envelope,
          result: { ...envelope.result, purchaseCommitment: wrong }
        })
      ).toThrow()
    const potatoes = signOutputPacket(
      'potatoes',
      { ...potatoesBody, purchaseCommitment: 'ef'.repeat(32) },
      sellerKey
    )
    expect(() =>
      parseOutputPurchaseEnvelope({ ...envelope, result: { ...envelope.result, potatoes } })
    ).toThrow('evidence differ')
    const unsigned = {
      ...envelope.result.potatoes,
      body: { ...envelope.result.potatoes.body, purchaseCommitment: 'ef'.repeat(32) }
    }
    const changed = {
      ...envelope,
      result: { ...envelope.result, purchaseCommitment: 'ef'.repeat(32), potatoes: unsigned }
    }
    expect(() => verifyOutputPurchaseEnvelope(changed, terms, txid, 'ef'.repeat(32))).toThrow(
      'signature failed'
    )
    expect(() =>
      verifyOutputPurchaseEnvelope(envelope, terms, 'cd'.repeat(32), purchaseCommitment)
    ).toThrow('transaction mismatch')
  })

  it('rejects unknown and malformed alias fields while preserving owned BEEF bytes', () => {
    const { envelope } = committedFixture()
    for (const currentAlias of [
      { txid: 'cd'.repeat(32) },
      { beef: 'AQ==' },
      { ...envelope.currentAlias, verified: true },
      { ...envelope.currentAlias, txid: 'cd' },
      { ...envelope.currentAlias, beef: 'not base64' }
    ])
      expect(() => parseOutputPurchaseEnvelope({ ...envelope, currentAlias })).toThrow()
  })

  it('owns preparation, submit and uncharged recovery representations', () => {
    const { request } = fixture()
    const owned = parseOutputPurchasePrepare(JSON.stringify(request))
    expect(owned).toEqual(request)
    request.listing.chain.network = 'changed'
    expect(owned.listing.chain.network).toBe(chain.network)
    const submit = { version: 1, acquisitionId: '66'.repeat(32), txid, beef: 'AA==' }
    expect(parseOutputPurchaseSubmit(submit)).toEqual(submit)
    const recover = { version: 1, acquisitionId: submit.acquisitionId }
    expect(parseOutputPurchaseRecover(recover)).toEqual(recover)
    for (const [parse, value] of [
      [parseOutputPurchasePrepare, owned],
      [parseOutputPurchaseSubmit, submit],
      [parseOutputPurchaseRecover, recover]
    ] as const)
      expect(() => parse({ ...value, authenticated: true })).toThrow('Unknown')
  })

  it('verifies signed terms against the full original request and separately selected seller', () => {
    const { request, terms } = fixture()
    expect(verifyOutputPurchaseTerms(terms, request, seller)).toEqual(terms)
    for (const change of [
      { requestId: 'other_request_123' },
      { topic: 'other' },
      { request: 'AQ==' },
      { assetId: '77'.repeat(32) },
      { termsDigest: '88'.repeat(32) },
      { recipient: seller },
      { listing: { ...request.listing, outputIndex: 1 } }
    ])
      expect(() => verifyOutputPurchaseTerms(terms, { ...request, ...change }, seller)).toThrow(
        'selected request'
      )
    expect(() => verifyOutputPurchaseTerms(terms, request, recipient)).toThrow('selected request')
    expect(() =>
      verifyOutputPurchaseTerms(
        signOutputPacket('potatoes', terms.body, sellerKey),
        request,
        seller
      )
    ).toThrow('signature failed')
  })

  it('rejects every independently changed signed term even if the other digest fields are retained', () => {
    const { request, body } = fixture()
    for (const change of [
      { seller: recipient },
      { acquisitionId: '77'.repeat(32) },
      { requestDigest: '88'.repeat(32) },
      { recipient: seller },
      { topic: 'other' },
      { assetId: '99'.repeat(32) },
      { termsDigest: 'aa'.repeat(32) },
      { listing: { ...body.listing, outputIndex: 1 } }
    ])
      expect(() =>
        verifyOutputPurchaseTerms(
          signOutputPacket('purchase-terms', { ...body, ...change }, sellerKey),
          request,
          seller
        )
      ).toThrow('selected request')
  })

  it('checks the minimum recovery promise without overflow or implicitly expiring retained rights', () => {
    const { terms, envelope } = fixture()
    expect(parseOutputPurchaseTerms(terms)).toEqual(terms)
    expect(verifyOutputPurchaseEnvelope(envelope, terms, txid)).toEqual(envelope)
    expect(() =>
      parseOutputPurchaseTerms({ ...terms, body: { ...terms.body, recoveryUntil: '86499' } })
    ).toThrow('less than one day')
    expect(() =>
      parseOutputPurchaseTerms({
        ...terms,
        body: {
          ...terms.body,
          purchaseUntil: '18446744073709551615',
          recoveryUntil: '18446744073709551615'
        }
      })
    ).toThrow('less than one day')
  })

  it.each([
    'prepared',
    'expired',
    'admission-pending',
    'admission-rejected',
    'admitted-delivery-pending',
    'delivery-failed',
    'delivered'
  ])('requires exactly the fields for %s', status => {
    const { terms, envelope } = fixture()
    const simple = status === 'prepared' || status === 'expired'
    const admitted = ['admitted-delivery-pending', 'delivery-failed', 'delivered'].includes(status)
    const decided = status === 'admission-rejected' || status === 'delivery-failed'
    const result = {
      version: 1,
      acquisitionId: terms.body.acquisitionId,
      recoveryUntil: terms.body.recoveryUntil,
      status,
      ...(!simple ? { txid } : {}),
      ...(admitted ? { steak: envelope.result.steak } : {}),
      ...(decided
        ? {
            decision: {
              reason: 'Local fixture decision',
              policy: terms.body.releasePolicy,
              evidence: 'AA==',
              decidedAt: '92',
              globalOutcome: 'unknown'
            }
          }
        : {}),
      ...(status === 'delivered' ? { potatoes: envelope.result.potatoes } : {})
    }
    const input = {
      result,
      ...(status === 'delivered' ? { releaseEvidence: envelope.releaseEvidence } : {})
    }
    expect(parseOutputPurchaseEnvelope(input)).toEqual(input)
    expect(verifyOutputPurchaseEnvelope(input, terms, simple ? undefined : txid)).toEqual(input)
    for (const field of ['txid', 'steak', 'decision', 'potatoes']) {
      const changed: Record<string, unknown> = { ...result }
      if (Object.hasOwn(changed, field)) delete changed[field]
      else changed[field] = field === 'txid' ? txid : {}
      expect(() => parseOutputPurchaseEnvelope({ ...input, result: changed })).toThrow()
    }
    const altered = { ...input, releaseEvidence: envelope.releaseEvidence }
    if (status === 'delivered') delete (altered as { releaseEvidence?: unknown }).releaseEvidence
    expect(() => parseOutputPurchaseEnvelope(altered)).toThrow('exactly to delivered')
  })

  it('preserves the unmodified STEAK object and binds a separately signed private result', () => {
    const { terms, envelope } = fixture()
    const parsed = verifyOutputPurchaseEnvelope(envelope, terms, txid)
    expect(canonicalOutputJSON(parsed.result)).toBe(canonicalOutputJSON(envelope.result))
    expect(parseOutputPotatoes(envelope.result.potatoes)).toEqual(envelope.result.potatoes)
    expect(Object.hasOwn(envelope.result.steak, 'potatoes')).toBe(false)
    expect(() => verifyOutputPurchaseEnvelope(envelope, terms)).toThrow('transaction mismatch')
    expect(() => verifyOutputPurchaseEnvelope(envelope, terms, 'aa'.repeat(32))).toThrow(
      'transaction mismatch'
    )
    expect(() =>
      verifyOutputPurchaseEnvelope(
        { ...envelope, result: { ...envelope.result, steak: {} } },
        terms,
        txid
      )
    ).toThrow('selected topic')
  })

  it('rejects substituted release evidence even when its shape is valid', () => {
    const { envelope } = fixture()
    for (const change of [
      { txid: 'bb'.repeat(32) },
      { acceptedAt: '89' },
      { chain: { ...chain, network: 'other' } }
    ]) {
      expect(() =>
        parseOutputPurchaseEnvelope({
          ...envelope,
          releaseEvidence: { ...envelope.releaseEvidence, ...change }
        })
      ).toThrow('evidence differ')
    }
    for (const change of [
      { acquisitionId: 'cc'.repeat(32) },
      { txid: 'dd'.repeat(32) },
      { recoveryUntil: '90000' }
    ]) {
      const potatoes = {
        ...envelope.result.potatoes,
        body: { ...envelope.result.potatoes.body, ...change }
      }
      expect(() =>
        parseOutputPurchaseEnvelope({ ...envelope, result: { ...envelope.result, potatoes } })
      ).toThrow('evidence differ')
    }
  })

  it('binds the release transaction and policy even when the evidence digest is internally consistent', () => {
    const { envelope, potatoesBody } = fixture()
    const evidence = { ...envelope.releaseEvidence, txid: 'aa'.repeat(32) }
    const potatoes = signOutputPacket(
      'potatoes',
      {
        ...potatoesBody,
        evidenceDigest: outputPacketDigest('release-evidence', evidence)
      },
      sellerKey
    )
    expect(() =>
      parseOutputPurchaseEnvelope({
        result: { ...envelope.result, potatoes },
        releaseEvidence: evidence
      })
    ).toThrow('evidence differ')
    const otherPolicy = signOutputPacket(
      'potatoes',
      {
        ...potatoesBody,
        releasePolicy: { kind: 'mined' as const, confirmations: 1 }
      },
      sellerKey
    )
    expect(() =>
      parseOutputPurchaseEnvelope({
        ...envelope,
        result: { ...envelope.result, potatoes: otherPolicy }
      })
    ).toThrow('evidence differ')
  })

  it('rejects a self-consistent newly signed release policy that differs from the frozen contract', () => {
    const { envelope, terms, potatoesBody } = fixture()
    const policy = {
      kind: 'processor-accepted' as const,
      identity: seller,
      policy: 'urn:fixture:processor'
    }
    const evidence = { ...envelope.releaseEvidence, policy, processorEvidence: 'AA==' }
    const potatoes = signOutputPacket(
      'potatoes',
      {
        ...potatoesBody,
        releasePolicy: policy,
        evidenceDigest: outputPacketDigest('release-evidence', evidence)
      },
      sellerKey
    )
    const input = { result: { ...envelope.result, potatoes }, releaseEvidence: evidence }
    expect(parseOutputPurchaseEnvelope(input)).toEqual(input)
    expect(() => verifyOutputPurchaseEnvelope(input, terms, txid)).toThrow(
      'original purchase terms'
    )
  })

  it('retains unauthorized error identities for all signed purchase checks', () => {
    const { request, terms, envelope, potatoesBody } = fixture()
    expect(() =>
      verifyOutputPurchaseTerms(
        signOutputPacket('potatoes', terms.body, sellerKey),
        request,
        seller
      )
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    expect(() =>
      verifyOutputPurchaseEnvelope(
        envelope,
        signOutputPacket('potatoes', terms.body, sellerKey),
        txid
      )
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
    const potatoes = signOutputPacket('purchase-terms', potatoesBody, sellerKey)
    expect(() =>
      verifyOutputPurchaseEnvelope(
        { ...envelope, result: { ...envelope.result, potatoes } },
        terms,
        txid
      )
    ).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })

  it('checks private signature authority and every frozen right independently', () => {
    const { terms, potatoesBody, envelope } = fixture()
    for (const change of [
      { requestDigest: 'ee'.repeat(32) },
      { seller: recipient },
      { recipient: seller },
      { topic: 'other' },
      { assetId: 'ff'.repeat(32) },
      { termsDigest: '00'.repeat(32) }
    ]) {
      const potatoes = signOutputPacket('potatoes', { ...potatoesBody, ...change }, sellerKey)
      expect(() =>
        verifyOutputPurchaseEnvelope(
          { ...envelope, result: { ...envelope.result, potatoes } },
          terms,
          txid
        )
      ).toThrow('original purchase terms')
    }
    const potatoes = signOutputPacket('purchase-terms', potatoesBody, sellerKey)
    expect(() =>
      verifyOutputPurchaseEnvelope(
        { ...envelope, result: { ...envelope.result, potatoes } },
        terms,
        txid
      )
    ).toThrow('Private result signature failed')
    expect(() =>
      verifyOutputPurchaseEnvelope(
        envelope,
        signOutputPacket('potatoes', terms.body, sellerKey),
        txid
      )
    ).toThrow('Original purchase terms signature failed')
  })

  it('permits explicit recovery extensions but rejects shortened promises and changed decision policies', () => {
    const { terms, envelope, potatoesBody } = fixture()
    const recoveryUntil = '90000'
    const extended = {
      ...envelope,
      result: {
        ...envelope.result,
        recoveryUntil,
        potatoes: signOutputPacket('potatoes', { ...potatoesBody, recoveryUntil }, sellerKey)
      }
    }
    expect(verifyOutputPurchaseEnvelope(extended, terms, txid)).toEqual(extended)
    const prepared = {
      result: {
        version: 1,
        acquisitionId: terms.body.acquisitionId,
        status: 'prepared',
        recoveryUntil: '86499'
      }
    }
    expect(() => verifyOutputPurchaseEnvelope(prepared, terms)).toThrow(
      'original identity or recovery promise'
    )
    prepared.result.recoveryUntil = terms.body.recoveryUntil
    prepared.result.acquisitionId = '11'.repeat(32)
    expect(() => verifyOutputPurchaseEnvelope(prepared, terms)).toThrow(
      'original identity or recovery promise'
    )
    const rejected = {
      result: {
        version: 1,
        acquisitionId: terms.body.acquisitionId,
        status: 'admission-rejected',
        txid,
        recoveryUntil: terms.body.recoveryUntil,
        decision: {
          reason: 'Local decision',
          policy: { kind: 'mined', confirmations: 1 },
          evidence: 'AA==',
          decidedAt: '95',
          globalOutcome: 'unknown'
        }
      }
    }
    expect(() => verifyOutputPurchaseEnvelope(rejected, terms, txid)).toThrow(
      'decision policy mismatch'
    )
  })
})
