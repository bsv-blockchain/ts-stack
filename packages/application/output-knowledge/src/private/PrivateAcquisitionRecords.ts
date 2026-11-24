import {
  ownOutputJSON,
  bindOutputPaidLookupChallenge,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputString,
  outputU32,
  outputU64,
  parseOutputPaidLookupAcquire,
  Transaction,
  type OutputEvidence,
  type OutputPaidLookupAcquire,
  type OutputPaidLookupChallenge,
  type OutputRetainedCapability
} from '@bsv/sdk'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import { protectedInteger } from './ProtectedLedgerCodec.js'
import type { PrivateAcquisitionContracts } from './PrivateAcquisitionContracts.js'
import { PRIVATE_ACQUISITION_ACCEPTANCE_BYTES } from './PrivateAcquisitionProgress.js'

export interface PrivateAcquisitionOriginal {
  format: 'private-acquisition-original/1'
  request: OutputPaidLookupAcquire
  challenge: OutputPaidLookupChallenge
  capability: OutputRetainedCapability
  evidence: OutputEvidence
  verificationContext: VerificationContext
  validationPolicy: { id: string; digest: string }
  schema: string
  maximumContextBytes: number
  maximumAcceptanceBytes: number
}
export interface PrivateAcquisitionRecordInstallation {
  contracts: PrivateAcquisitionContracts
  validationPolicy: { id: string; digest: string }
  maximumRecordBytes: number
  supportedExtensions?: readonly string[]
}

/**
 * Retained immutable quote metadata and whole-envelope feasibility. These checks
 * bind representations; installed domain and Script/SPV validators still establish
 * eligibility before the native owner commits quote/material/result reservations.
 * Funding acceptance and current recipient authorization remain separate duties.
 */
export class PrivateAcquisitionRecords {
  private readonly policy: PrivateAcquisitionOriginal['validationPolicy']
  private readonly extensions: readonly string[]
  readonly maximumRecordBytes: number
  private readonly contracts: PrivateAcquisitionContracts
  constructor(input: PrivateAcquisitionRecordInstallation) {
    this.contracts = input.contracts
    const value = ownOutputJSON(
      {
        validationPolicy: input.validationPolicy,
        maximumRecordBytes: input.maximumRecordBytes,
        supportedExtensions: input.supportedExtensions ?? []
      },
      { bytes: 16384 }
    ).value
    closedOutputObject(value, ['validationPolicy', 'maximumRecordBytes', 'supportedExtensions'])
    closedOutputObject(value.validationPolicy, ['id', 'digest'])
    this.policy = {
      id: outputString(value.validationPolicy.id),
      digest: outputHex32(value.validationPolicy.digest)
    }
    this.maximumRecordBytes = protectedInteger(value.maximumRecordBytes, 2 * 1048576)
    outputAssert(
      Array.isArray(value.supportedExtensions) && value.supportedExtensions.length <= 32,
      'Invalid acquisition record extensions'
    )
    this.extensions = value.supportedExtensions.map(extension => outputString(extension))
  }
  prepare(input: Omit<PrivateAcquisitionOriginal, 'format' | 'validationPolicy'>) {
    return this.restore({
      format: 'private-acquisition-original/1',
      ...input,
      validationPolicy: this.policy
    })
  }
  restore(input: unknown) {
    const limits = { bytes: this.maximumRecordBytes }
    const value = ownOutputJSON(input, limits).value
    closedOutputObject(value, [
      'format',
      'request',
      'challenge',
      'capability',
      'evidence',
      'verificationContext',
      'validationPolicy',
      'schema',
      'maximumContextBytes',
      'maximumAcceptanceBytes'
    ])
    outputAssert(
      value.format === 'private-acquisition-original/1',
      'Unsupported acquisition original record',
      'unsupported'
    )
    closedOutputObject(value.validationPolicy, ['id', 'digest'])
    const validationPolicy = {
      id: outputString(value.validationPolicy.id),
      digest: outputHex32(value.validationPolicy.digest)
    }
    outputAssert(
      validationPolicy.id === this.policy.id && validationPolicy.digest === this.policy.digest,
      'Acquisition validation policy changed',
      'context-changed'
    )
    const request = parseOutputPaidLookupAcquire(value.request, this.extensions)
    const installation = this.contracts.configuration(),
      selection = this.contracts.restore(value.capability)
    const challenge = bindOutputPaidLookupChallenge(
      value.challenge,
      request,
      { seller: installation.seller, rulesDigest: installation.rulesDigest },
      this.extensions
    )
    outputAssert(
      request.service === installation.service &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(installation.chain) &&
        canonicalOutputJSON(challenge.acceptancePolicy) ===
          canonicalOutputJSON(installation.acceptancePolicy),
      'Acquisition original installation differs',
      'context-changed'
    )
    const parameters = selection.profile.parameters as { recoverySeconds: string }
    outputAssert(
      outputU64(challenge.recoveryUntil) >=
        outputU64(challenge.payableUntil) + outputU64(parameters.recoverySeconds) &&
        outputU64(challenge.recoveryUntil) - outputU64(challenge.payableUntil) <=
          outputU64(installation.maximumRecoverySeconds),
      'Acquisition original recovery promise differs from installation',
      'context-changed'
    )
    canonicalOutputJSON(request, { bytes: selection.profile.maxRequestBytes })
    const verificationContext = parseVerificationContext(value.verificationContext)
    outputAssert(
      canonicalOutputJSON(verificationContext.view.chain) ===
        canonicalOutputJSON(installation.chain),
      'Acquisition original chain context differs',
      'context-changed'
    )
    closedOutputObject(value.evidence, ['txid', 'outputIndex', 'beef'])
    const evidence = {
      txid: outputHex32(value.evidence.txid),
      outputIndex: outputU32(value.evidence.outputIndex),
      beef: value.evidence.beef as string
    }
    const transaction = Transaction.fromAtomicBEEF(decodeOutputBytes(evidence.beef))
    outputAssert(
      transaction.id('hex') === evidence.txid &&
        evidence.txid === request.listing.txid &&
        evidence.outputIndex === request.listing.outputIndex &&
        evidence.outputIndex < transaction.outputs.length,
      'Acquisition frozen evidence differs from listing',
      'unavailable'
    )
    const record: PrivateAcquisitionOriginal = {
      format: value.format,
      request,
      challenge,
      capability: value.capability as unknown as OutputRetainedCapability,
      evidence,
      verificationContext,
      validationPolicy,
      schema: outputString(value.schema),
      maximumContextBytes: protectedInteger(value.maximumContextBytes, 4194304),
      maximumAcceptanceBytes: protectedInteger(
        value.maximumAcceptanceBytes,
        PRIVATE_ACQUISITION_ACCEPTANCE_BYTES
      )
    }
    const responseBytes = this.responseAllowance(record)
    outputAssert(
      responseBytes <= selection.profile.maxResponseBytes,
      'Acquisition complete result cannot fit original response allowance',
      'limited'
    )
    return { record, selection, responseBytes }
  }
  private responseAllowance(record: PrivateAcquisitionOriginal): number {
    const time = '18446744073709551615'
    const funding = {
      chain: record.request.listing.chain,
      txid: '0'.repeat(64),
      outputIndex: 4294967295
    }
    const minimumAcceptance = canonicalOutputJSON({
      chain: funding.chain,
      txid: funding.txid,
      policy: record.challenge.acceptancePolicy,
      acceptedAt: time
    })
    outputAssert(
      Buffer.byteLength(minimumAcceptance) <= record.maximumAcceptanceBytes,
      'Acquisition acceptance allowance cannot hold its selected policy',
      'limited'
    )
    // Null is a size placeholder only. Actual responses always use the SDK parser;
    // complete acceptance is bounded independently before reserving wallet work.
    const base = {
      version: 1,
      acquisitionId: record.challenge.acquisitionId,
      challenge: record.challenge,
      recoveryUntil: time,
      funding,
      acceptance: null
    }
    const delivered =
      Buffer.byteLength(
        canonicalOutputJSON({
          ...base,
          status: 'delivered',
          result: { evidence: record.evidence, context: '', schema: record.schema }
        })
      ) +
      4 * Math.ceil(record.maximumContextBytes / 3)
    const failed = Buffer.byteLength(
      canonicalOutputJSON({ ...base, status: 'failed', reason: '\0'.repeat(1024) })
    )
    return Math.max(delivered, failed) - 4 + record.maximumAcceptanceBytes
  }
}
