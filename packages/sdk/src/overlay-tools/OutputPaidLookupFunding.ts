import Beef from '../transaction/Beef.js'
import PublicKey from '../primitives/PublicKey.js'
import P2PKH from '../script/templates/P2PKH.js'
import { toBase64 } from '../primitives/utils.js'
import * as s from './OutputProtocolSchema.js'
import { parseOutputChain } from './OutputObservation.js'
import { decodeOutputBytes, outputIdentity, outputPacketDigest } from './OutputProtocol.js'
import { outputAssert } from './OutputProtocolError.js'
import { parseOutputPaidLookupChallenge } from './OutputPaidLookupProtocol.js'

const derivation = (input: unknown): string => {
  outputAssert(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 128 &&
      Array.from(input).every(character => character.charCodeAt(0) <= 127),
    'Expected bounded ASCII payment derivation'
  )
  return input
}
const payment = s.object({
  derivationPrefix: derivation,
  derivationSuffix: derivation,
  transaction: s.bytes
})
export type OutputPaidLookupPayment = ReturnType<typeof payment>

/** Header representation only; Atomic BEEF, transaction and release validation are separate. */
export function parseOutputPaidLookupPayment(input: unknown): OutputPaidLookupPayment {
  const value = s.normalized(input, payment, 98304)
  decodeOutputBytes(value.transaction, 65536)
  return value
}

export interface OutputWalletFundingOperation {
  id: string
  acquisitionId: string
  funding: { chain: ReturnType<typeof parseOutputChain>; txid: string; outputIndex: number }
  buyer: string
  seller: string
  satoshis: string
  derivationPrefix: string
  derivationSuffix: string
  beef: string
}

/**
 * Own and identify the exact payment output before policy verification or any
 * wallet effect. The caller must derive sellerPaymentKey using BRC-29 from the
 * authenticated buyer/seller and this exact prefix/suffix. The quote must already
 * be bound to the retained request/selected seller. This function proves neither
 * the key derivation nor Bitcoin/release acceptance and never internalizes funds.
 */
export function inspectOutputPaidLookupFunding(
  paymentInput: unknown,
  challengeInput: unknown,
  selected: { chain: ReturnType<typeof parseOutputChain>; sellerPaymentKey: string }
): { operation: OutputWalletFundingOperation; rawTransaction: string } {
  const binding = s.normalized(
    selected,
    s.object({ chain: parseOutputChain, sellerPaymentKey: outputIdentity })
  )
  const challenge = parseOutputPaidLookupChallenge(challengeInput)
  const submitted = parseOutputPaidLookupPayment(paymentInput)
  outputAssert(
    submitted.derivationPrefix === challenge.derivationPrefix,
    'Payment prefix differs from frozen challenge'
  )
  const beef = Beef.fromBinaryStrict(decodeOutputBytes(submitted.transaction, 65536))
  outputAssert(
    beef.atomicTxid !== undefined && beef.isAtomic(),
    'Payment requires one Atomic BEEF dependency graph'
  )
  const transaction = beef.findTxid(beef.atomicTxid)?.tx
  outputAssert(
    transaction !== undefined && transaction.id('hex') === beef.atomicTxid,
    'Payment target raw transaction required'
  )
  const lockingScript = new P2PKH()
    .lock(PublicKey.fromString(binding.sellerPaymentKey).toAddress())
    .toHex()
  const matches: number[] = []
  transaction.outputs.forEach((output, index) => {
    if (output.lockingScript.toHex() === lockingScript) matches.push(index)
  })
  outputAssert(matches.length === 1, 'Payment requires exactly one matching output')
  const outputIndex = matches[0]
  outputAssert(
    transaction.outputs[outputIndex].satoshis?.toString() === challenge.satoshis,
    'Payment must equal challenged amount'
  )
  const funding = { chain: binding.chain, txid: beef.atomicTxid, outputIndex }
  return {
    operation: {
      id: outputPacketDigest('wallet-funding', {
        seller: challenge.seller,
        acquisitionId: challenge.acquisitionId,
        funding
      }),
      acquisitionId: challenge.acquisitionId,
      funding,
      buyer: challenge.buyer,
      seller: challenge.seller,
      satoshis: challenge.satoshis,
      derivationPrefix: submitted.derivationPrefix,
      derivationSuffix: submitted.derivationSuffix,
      beef: submitted.transaction
    },
    rawTransaction: toBase64(transaction.toBinary())
  }
}
