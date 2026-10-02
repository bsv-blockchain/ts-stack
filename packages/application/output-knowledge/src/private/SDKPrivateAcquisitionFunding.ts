import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  inspectOutputPaidLookupFunding,
  outputAssert,
  OutputProtocolError,
  parseOutputChain,
  parseOutputPaidLookupChallenge,
  parseOutputPaidLookupPayment,
  Utils,
  type OutputChain,
  type OutputPaidLookupChallenge,
  type OutputWalletFundingOperation,
  type TransactionEvidenceLimits,
  type WalletInterface
} from '@bsv/sdk'
import { SDKEvidenceVerifier, type ChainViewResolver } from '../SDKEvidenceVerifier.js'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'

export interface VerifiedPrivateAcquisitionFunding {
  operation: OutputWalletFundingOperation
  sellerPaymentKey: string
  rawTransaction: string
  verificationContext: VerificationContext
}

/**
 * Exact BRC-29 output plus Script/SPV verification under installed immutable
 * chain policy. This neither internalizes payment nor decides the release policy.
 * The caller must first durably pin receipt, keep wallet work bounded, then obtain
 * release acceptance and atomically reserve funding before any wallet effect.
 */
export class SDKPrivateAcquisitionFunding {
  private readonly verifier: SDKEvidenceVerifier
  constructor(
    chains: ChainViewResolver,
    private readonly wallet: Pick<WalletInterface, 'getPublicKey'>,
    private readonly context: (
      operation: OutputWalletFundingOperation,
      challenge: OutputPaidLookupChallenge
    ) => VerificationContext,
    limits: Partial<TransactionEvidenceLimits> = {}
  ) {
    this.verifier = new SDKEvidenceVerifier(chains, limits)
  }

  private async publicKey(
    args: Parameters<WalletInterface['getPublicKey']>[0],
    signal: AbortSignal
  ): Promise<string> {
    let result: { publicKey: string }
    try {
      result = await this.wallet.getPublicKey(args)
    } catch {
      outputAssert(!signal.aborted, 'Acquisition verification cancelled', 'cancelled')
      throw new OutputProtocolError(
        'unavailable',
        'Acquisition funding derivation is unavailable',
        true
      )
    }
    outputAssert(!signal.aborted, 'Acquisition verification cancelled', 'cancelled')
    return result.publicKey
  }

  async verify(
    paymentInput: unknown,
    challengeInput: unknown,
    chainInput: OutputChain,
    signal: AbortSignal = new AbortController().signal
  ): Promise<VerifiedPrivateAcquisitionFunding> {
    const payment = parseOutputPaidLookupPayment(paymentInput),
      challenge = parseOutputPaidLookupChallenge(challengeInput),
      chain = parseOutputChain(chainInput)
    outputAssert(!signal.aborted, 'Acquisition verification cancelled', 'cancelled')
    outputAssert(
      payment.derivationPrefix === challenge.derivationPrefix,
      'Acquisition funding prefix differs',
      'conflict'
    )
    const identity = await this.publicKey({ identityKey: true }, signal)
    outputAssert(
      identity === challenge.seller,
      'Acquisition funding wallet identity differs',
      'context-changed'
    )
    const sellerPaymentKey = await this.publicKey(
      {
        protocolID: [2, '3241645161d8'],
        keyID: `${payment.derivationPrefix} ${payment.derivationSuffix}`,
        counterparty: challenge.buyer,
        forSelf: true
      },
      signal
    )
    const { operation, rawTransaction } = inspectOutputPaidLookupFunding(payment, challenge, {
      chain,
      sellerPaymentKey
    })
    const snapshot = parseVerificationContext(
      this.context(structuredClone(operation), structuredClone(challenge))
    )
    outputAssert(
      canonicalOutputJSON(snapshot.view.chain) === canonicalOutputJSON(chain),
      'Acquisition funding chain context differs',
      'context-changed'
    )
    const bytes = decodeOutputBytes(payment.transaction, 65536)
    const result = await this.verifier.verify(
      {
        chain,
        evidence: {
          txid: operation.funding.txid,
          outputIndex: operation.funding.outputIndex,
          beef: payment.transaction
        },
        variantId: Utils.toHex(Hash.sha256(bytes))
      },
      snapshot,
      signal
    )
    if (result.status !== 'verified') {
      const code = result.status === 'unresolved' ? 'unavailable' : result.status
      throw new OutputProtocolError(
        code,
        `Acquisition funding verification ${result.status}`,
        ['unavailable', 'limited', 'cancelled', 'context-changed'].includes(code)
      )
    }
    outputAssert(
      result.fact.rawTransaction === rawTransaction,
      'Acquisition verified payment target differs'
    )
    return { operation, sellerPaymentKey, rawTransaction, verificationContext: snapshot }
  }
}
