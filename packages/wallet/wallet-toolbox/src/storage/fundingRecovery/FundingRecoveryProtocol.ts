import {
  Beef, canonicalOutputJSON, closedOutputObject, decodeOutputBytes, outputHex32,
  outputIdentity, outputPacketDigest, outputU32, outputU64, parseOutputChain,
  parseOutputJSON, parseOutputPaidLookupPayment, type OutputWalletFundingOperation
} from '@bsv/sdk'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
export type { FundingRecoveryCommit } from './FundingRecoveryCommit'

export const FUNDING_RECOVERY_RECORD_BYTES = 98304

export function requireFunding(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new WERR_INVALID_OPERATION(reason)
}

/** Closed, owned local operation; this checks representation, not chain acceptance. */
export function parseFundingRecoveryOperation(input: unknown): OutputWalletFundingOperation {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: FUNDING_RECOVERY_RECORD_BYTES }), { bytes: FUNDING_RECOVERY_RECORD_BYTES })
  closedOutputObject(value, ['id', 'acquisitionId', 'funding', 'buyer', 'seller', 'satoshis', 'derivationPrefix', 'derivationSuffix', 'beef'])
  closedOutputObject(value.funding, ['chain', 'txid', 'outputIndex'])
  const payment = parseOutputPaidLookupPayment({ derivationPrefix: value.derivationPrefix, derivationSuffix: value.derivationSuffix, transaction: value.beef })
  const operation: OutputWalletFundingOperation = {
    id: outputHex32(value.id), acquisitionId: outputHex32(value.acquisitionId),
    funding: { chain: parseOutputChain(value.funding.chain), txid: outputHex32(value.funding.txid), outputIndex: outputU32(value.funding.outputIndex) },
    buyer: outputIdentity(value.buyer), seller: outputIdentity(value.seller), satoshis: String(outputU64(value.satoshis)),
    derivationPrefix: payment.derivationPrefix, derivationSuffix: payment.derivationSuffix, beef: payment.transaction
  }
  requireFunding(BigInt(operation.satoshis) > 0n && BigInt(operation.satoshis) <= 2100000000000000n, 'Funding amount is outside the supported money range')
  requireFunding(operation.id === outputPacketDigest('wallet-funding', { seller: operation.seller, acquisitionId: operation.acquisitionId, funding: operation.funding }), 'Funding operation ID does not bind its acquisition and outpoint')
  const beef = Beef.fromBinaryStrict(decodeOutputBytes(operation.beef, 65536))
  const tx = beef.findTxid(operation.funding.txid)?.tx
  requireFunding(beef.atomicTxid === operation.funding.txid && beef.isAtomic() && tx !== undefined, 'Funding operation requires exact Atomic BEEF target bytes')
  requireFunding(tx.outputs[operation.funding.outputIndex]?.satoshis?.toString() === operation.satoshis, 'Funding operation output amount differs')
  return operation
}

/** Proof encodings may differ; every economic and authorization field is frozen. */
export function fundingRecoverySemantic(operation: OutputWalletFundingOperation): string {
  const { beef: _beef, ...body } = operation
  return canonicalOutputJSON(body)
}

export interface FundingRecoveryReceipt {
  protocol: 'wallet-funding-recovery-v1'
  operationId: string
  funding: OutputWalletFundingOperation['funding']
  satoshis: string
  walletIdentity: string
  storageIdentity: string
  transactionId: number
}

export type FundingRecoveryResult =
  | { state: 'absent' }
  | { state: 'unknown' }
  | { state: 'rejected'; reason: 'payment-script-mismatch' }
  | { state: 'accepted'; funding: OutputWalletFundingOperation['funding']; receipt: FundingRecoveryReceipt }
