import { readFile, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import {
  PublicBRC77Verifier,
  WalletBRC77Signer,
  encodeDeterministicCbor,
  frameLCH,
  fromBase64Url,
  fromHex,
  objectId,
  objectIri,
  objectPreimage,
  parseLCH,
  recoveryUntil,
  sha256,
  toBase64Url,
  toHex,
  uint64be,
  verifySignedObject
} from '../dist/index.js'

const path = process.argv.slice(2).find(argument => argument !== '--')
if (path === undefined) {
  throw new Error('Usage: pnpm --filter @bsv/lch vectors:update -- <0170-conformance-vectors.json>')
}

const source = JSON.parse(await readFile(path, 'utf8'))
const vectors = inflate(source)
const originalEmbedded = fromHex(vectors.framing.embeddedFileHex)
const originalCiphertext = parseLCH(originalEmbedded).ciphertext
if (originalCiphertext === undefined) throw new Error('Vector embedded file has no ciphertext')

let signatureSequence = 0
const signer = async value =>
  WalletBRC77Signer.create({
    wallet: new ProtoWallet(new PrivateKey(value)),
    random: length => {
      signatureSequence += 1
      return Uint8Array.from(
        { length },
        (_, index) => (value * 41 + signatureSequence * 17 + index) & 0xff
      )
    }
  })
const publisher = await signer(1)
const buyer = await signer(2)
const composer = await signer(3)
const replacements = []

async function updateRecord(record, type, objectSigner) {
  const oldHex = record.idHex
  const id = await objectId(type, record.body)
  const idHex = toHex(id)
  record.type = type
  record.deterministicCborHex = toHex(encodeDeterministicCbor(record.body))
  record.idHex = idHex
  record.iri = await objectIri(type, record.body)
  if (objectSigner !== undefined) {
    record.signed = {
      body: record.body,
      signatures: [await objectSigner.sign(objectPreimage(type, record.body))]
    }
    await verifySignedObject(
      type,
      record.signed,
      new PublicBRC77Verifier(),
      objectSigner.identityKey
    )
  }
  if (oldHex !== undefined && oldHex !== idHex) replacements.push([oldHex, idHex])
  return id
}

await updateRecord(vectors.objects.asset, 'asset')
await updateRecord(vectors.objects.authority, 'authority', composer)

vectors.objects.offer.body.payment.recoveryPeriodSeconds = 86_400
const offerId = await updateRecord(vectors.objects.offer, 'offer', publisher)

vectors.objects.licenseRequest.body.offerId = offerId
const requestId = await updateRecord(vectors.objects.licenseRequest, 'license-request', buyer)

const recovery = recoveryUntil(vectors.objects.quote.body.expiresAt, 86_400)
const demandIds = []
for (const [index, demand] of vectors.objects.paymentDemands.entries()) {
  demand.body.offerId = offerId
  demand.body.requestId = requestId
  demand.body.recoveryUntil = recovery
  demandIds.push(await updateRecord(demand, 'payment-demand', index === 0 ? publisher : composer))
}

vectors.objects.quote.body.offerId = offerId
vectors.objects.quote.body.requestId = requestId
vectors.objects.quote.body.recoveryUntil = recovery
vectors.objects.quote.body.demands = vectors.objects.paymentDemands.map(demand => demand.signed)
await updateRecord(vectors.objects.quote, 'quote', publisher)

const receiptIds = []
for (const [index, receipt] of vectors.objects.paymentReceipts.entries()) {
  receipt.body.demandId = demandIds[index]
  receipt.body.requestId = requestId
  receiptIds.push(
    await updateRecord(receipt, 'payment-receipt', index === 0 ? publisher : composer)
  )
}

vectors.objects.license.body.offerId = offerId
vectors.objects.license.body.requestId = requestId
for (const [index, fulfillment] of vectors.objects.license.body.fulfillments.entries()) {
  fulfillment.receiptIds = [receiptIds[index]]
}
const licenseId = await updateRecord(vectors.objects.license, 'license', publisher)

const ingredient = vectors.objects.compositionRecord.body.ingredients[0]
ingredient.sourceLicenseId = licenseId
ingredient.settlementReceiptIds = receiptIds
ingredient.mappingProfile = 'https://bsv.brc.dev/apps/0170#whole-placement-v1'
await updateRecord(vectors.objects.compositionRecord, 'composition-record')

vectors.objects.derivedAsset.body.composition = vectors.objects.compositionRecord.body
await updateRecord(vectors.objects.derivedAsset, 'asset')

vectors.c2pa.compositionRecord = vectors.objects.compositionRecord
vectors.c2pa.derivedAsset = vectors.objects.derivedAsset

vectors.objects.header.body.acquisition[0].offer = vectors.objects.offer.signed
vectors.objects.header.body.authority = [vectors.objects.authority.signed]
const headerBody = vectors.objects.header.body
const oldHeaderHex = vectors.objects.header.idHex
const headerId = await objectId('header', headerBody)
vectors.objects.header.deterministicCborHex = toHex(encodeDeterministicCbor(headerBody))
vectors.objects.header.idHex = toHex(headerId)
vectors.objects.header.iri = await objectIri('header', headerBody)
if (oldHeaderHex !== vectors.objects.header.idHex) {
  replacements.push([oldHeaderHex, vectors.objects.header.idHex])
}
const headerSignature = await publisher.sign(objectPreimage('header', headerBody))
vectors.objects.header.signedHeader = { ...headerBody, signatures: [headerSignature] }
const signedHeaderBytes = encodeDeterministicCbor(vectors.objects.header.signedHeader)
vectors.objects.header.signedHeaderCborHex = toHex(signedHeaderBytes)
vectors.objects.header.signedHeaderLength = signedHeaderBytes.length

const embedded = frameLCH(vectors.objects.header.signedHeader, originalCiphertext)
const detached = frameLCH(vectors.objects.header.signedHeader)
vectors.framing.headerCborHex = toHex(signedHeaderBytes)
vectors.framing.headerLengthUint64beHex = toHex(uint64be(signedHeaderBytes.length))
vectors.framing.prefixWithoutPayloadHex = toHex(detached)
vectors.framing.embeddedFileHex = toHex(embedded)
vectors.framing.embeddedFileSha256Hex = toHex(await sha256(embedded))
vectors.framing.detachedHeaderSha256Hex = toHex(await sha256(detached))

vectors.brc77.offerSignatureHex = toHex(vectors.objects.offer.signed.signatures[0])
vectors.brc77.headerSignatureHex = toHex(headerSignature)
vectors.brc77.licenseSignatureHex = toHex(vectors.objects.license.signed.signatures[0])
vectors.multilateralPayment.outputs.forEach((output, index) => {
  output.demandIdHex = toHex(demandIds[index])
})

vectors.reviewCorrections = {
  paymentRecovery: {
    recoveryPeriodSeconds: 86_400,
    expiresAt: vectors.objects.quote.body.expiresAt,
    recoveryUntil: recovery,
    validRecoveryAt: BigInt(recovery) - 1n,
    rejectNewTransactionAt: BigInt(vectors.objects.quote.body.expiresAt) + 1n,
    exactRedelivery: 'idempotent'
  },
  randomizedOutputs: {
    finalizedOrder: [
      vectors.multilateralPayment.outputs[1].lockingScriptHex,
      'unrelated-output',
      vectors.multilateralPayment.outputs[0].lockingScriptHex
    ],
    expectedDemandOutputIndices: [2, 0],
    missing: 'ERR_LCH_PAYMENT',
    duplicate: 'ERR_LCH_PAYMENT',
    ambiguous: 'ERR_LCH_PAYMENT'
  },
  revocation: [
    { status: 'unspent', ageSeconds: 30, expected: 'valid' },
    { status: 'unspent', ageSeconds: 86_401, expected: 'ERR_LCH_REVOCATION' },
    { status: 'spent-mempool', ageSeconds: 1, expected: 'ERR_LCH_REVOCATION' },
    { status: 'spent-confirmed', ageSeconds: 1, expected: 'ERR_LCH_REVOCATION' },
    { status: 'unknown', ageSeconds: 1, expected: 'ERR_LCH_REVOCATION' },
    {
      status: 'unspent',
      ageSeconds: 1,
      reorganizationAffected: true,
      expected: 'ERR_LCH_REVOCATION'
    }
  ],
  endpointTrust: {
    accepted: ['https://content.example/lch/object'],
    rejected: [
      'http://content.example/lch/object',
      'https://127.0.0.1/object',
      'https://user@example.com/object#fragment'
    ],
    identityRedirect: { status: 307, sameOrigin: true, expected: 'valid' },
    crossOriginIdentityRedirect: 'ERR_LCH_ENDPOINT'
  },
  selfReference: {
    topLevelUid: 'virtual substitution',
    nestedLiteral: 'unchanged',
    transmittedBytes: 'unchanged'
  },
  compositionMapping: {
    supported: 'https://bsv.brc.dev/apps/0170#whole-placement-v1',
    derivedSelection: { type: 'all' },
    repeatedPlacements: 'distinct ingredients',
    unknownMapping: 'ERR_LCH_PROFILE_UNSUPPORTED'
  },
  keyPeriodCoverage: {
    wholeAssetKeyIds: vectors.segmentedEncryption.descriptor.keyPeriods.map(period => period.keyId),
    selectedSegments: { type: 'segments', ranges: [[2, 4]] },
    selectedKeyIds: [vectors.segmentedEncryption.descriptor.keyPeriods[1].keyId],
    missing: 'ERR_LCH_KEY',
    duplicate: 'ERR_LCH_KEY',
    outOfSelection: 'ERR_LCH_KEY'
  },
  training: {
    actionAloneRequiresComposition: false,
    claimedIndividualSource: 'inputTo',
    datasetRootProfile: 'unsupported in v1'
  }
}

vectors.generatedWith = {
  node: process.version,
  bsvSdk: '2.4.1',
  lch: '0.1.0',
  deterministicCbor: '@bsv/lch'
}

let serialized = JSON.stringify(deflate(vectors), null, 2)
for (const [oldHex, newHex] of replacements) {
  const oldBytes = fromHex(oldHex)
  const newBytes = fromHex(newHex)
  serialized = serialized
    .replaceAll(oldHex, newHex)
    .replaceAll(toBase64Url(oldBytes), toBase64Url(newBytes))
}
await writeFile(path, `${serialized}\n`)

function inflate(value) {
  if (Array.isArray(value)) return value.map(inflate)
  if (value !== null && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$bytes === 'string') {
      return fromBase64Url(value.$bytes)
    }
    if (Object.keys(value).length === 1 && typeof value.$uint === 'string') {
      return BigInt(value.$uint)
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inflate(item)]))
  }
  return value
}

function deflate(value) {
  if (value instanceof Uint8Array) return { $bytes: toBase64Url(value) }
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : { $uint: value.toString() }
  }
  if (Array.isArray(value)) return value.map(deflate)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deflate(item)]))
  }
  return value
}
