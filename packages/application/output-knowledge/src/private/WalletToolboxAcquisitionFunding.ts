import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputIdentity,
  outputString,
  OutputProtocolError,
  type OutputJSONObject,
  type OutputWalletFundingOperation
} from '@bsv/sdk'
import {
  parsePrivateAcquisitionProgress,
  type PrivateAcquisitionProgress
} from './PrivateAcquisitionProgress.js'
import type {
  PrivateAcquisitionWallet,
  PrivateAcquisitionWalletOutcome
} from './PrivateAcquisitionWallet.js'

/** Structural dependency on Wallet Toolbox's explicit RecoverableFundingController. */
export interface RecoverableAcquisitionFundingController {
  internalizeOnce(operation: OutputWalletFundingOperation): Promise<unknown>
  getInternalization(operationId: string): Promise<unknown>
}
/**
 * Concrete adapter for wallet-funding-recovery-v1 receipts. It adds no wallet or
 * network effect of its own and never infers absence from a lost response. The
 * independently installed wallet/storage identities survive HTTP session changes.
 */
export class WalletToolboxAcquisitionFunding implements PrivateAcquisitionWallet {
  private readonly wallet: string
  private readonly storage: string
  private readonly lookup: RecoverableAcquisitionFundingController['getInternalization']
  private readonly credit: RecoverableAcquisitionFundingController['internalizeOnce']
  constructor(
    private readonly controller: RecoverableAcquisitionFundingController,
    identities: { wallet: string; storage: string }
  ) {
    const value = ownOutputJSON(identities, { bytes: 1024 }).value
    closedOutputObject(value, ['wallet', 'storage'])
    this.wallet = outputIdentity(value.wallet)
    this.storage = outputString(value.storage)
    outputAssert(
      typeof controller.getInternalization === 'function' &&
        typeof controller.internalizeOnce === 'function',
      'Durable wallet funding capability is required'
    )
    this.lookup = controller.getInternalization
    this.credit = controller.internalizeOnce
  }
  private current(): void {
    outputAssert(
      this.lookup === this.controller.getInternalization &&
        this.credit === this.controller.internalizeOnce,
      'Acquisition wallet capability changed',
      'context-changed'
    )
  }
  status(
    state: PrivateAcquisitionProgress,
    signal: AbortSignal
  ): Promise<PrivateAcquisitionWalletOutcome> {
    return this.run(state, signal, operation => this.lookup.call(this.controller, operation.id))
  }
  internalize(
    state: PrivateAcquisitionProgress,
    signal: AbortSignal
  ): Promise<PrivateAcquisitionWalletOutcome> {
    return this.run(state, signal, operation => this.credit.call(this.controller, operation))
  }
  private async run(
    input: PrivateAcquisitionProgress,
    signal: AbortSignal,
    call: (operation: OutputWalletFundingOperation) => Promise<unknown>
  ): Promise<PrivateAcquisitionWalletOutcome> {
    const state = parsePrivateAcquisitionProgress(input)
    outputAssert(
      state.phase === 'funding-pending' && state.funding !== null,
      'Acquisition has no reserved wallet operation',
      'conflict'
    )
    const operation = state.funding.operation
    outputAssert(
      operation.seller === this.wallet,
      'Acquisition funding wallet identity differs',
      'context-changed'
    )
    outputAssert(!signal.aborted, 'Acquisition wallet work cancelled', 'cancelled')
    this.current()
    let raw: unknown
    try {
      raw = await call(structuredClone(operation))
    } catch {
      outputAssert(!signal.aborted, 'Acquisition wallet work cancelled', 'cancelled')
      throw new OutputProtocolError(
        'unavailable',
        'Acquisition wallet outcome is unavailable',
        true
      )
    }
    outputAssert(!signal.aborted, 'Acquisition wallet work cancelled', 'cancelled')
    this.current()
    try {
      return this.result(raw, operation)
    } catch {
      throw new OutputProtocolError(
        'unavailable',
        'Acquisition wallet receipt is unavailable',
        true
      )
    }
  }
  private result(
    input: unknown,
    operation: OutputWalletFundingOperation
  ): PrivateAcquisitionWalletOutcome {
    const value = ownOutputJSON(input, { bytes: 16384 }).value
    closedOutputObject(value, ['state'], ['funding', 'receipt', 'reason'])
    if (value.state === 'absent' || value.state === 'unknown') {
      closedOutputObject(value, ['state'])
      return { state: value.state }
    }
    if (value.state === 'rejected') {
      closedOutputObject(value, ['state', 'reason'])
      outputAssert(value.reason === 'payment-script-mismatch', 'Unknown native wallet rejection')
      return { state: 'rejected', operationId: operation.id, reason: value.reason }
    }
    outputAssert(value.state === 'accepted', 'Unknown native wallet outcome')
    closedOutputObject(value, ['state', 'funding', 'receipt'])
    closedOutputObject(value.receipt, [
      'protocol',
      'operationId',
      'funding',
      'satoshis',
      'walletIdentity',
      'storageIdentity',
      'transactionId'
    ])
    const receipt = value.receipt
    outputAssert(
      receipt.protocol === 'wallet-funding-recovery-v1' &&
        receipt.operationId === operation.id &&
        receipt.satoshis === operation.satoshis &&
        receipt.walletIdentity === this.wallet &&
        receipt.storageIdentity === this.storage &&
        Number.isSafeInteger(receipt.transactionId) &&
        (receipt.transactionId as number) > 0 &&
        canonicalOutputJSON(receipt.funding) === canonicalOutputJSON(operation.funding) &&
        canonicalOutputJSON(value.funding) === canonicalOutputJSON(operation.funding),
      'Native wallet receipt changed its operation or ownership'
    )
    return {
      state: 'accepted',
      receipt: {
        operationId: operation.id,
        funding: structuredClone(operation.funding),
        seller: this.wallet,
        satoshis: operation.satoshis,
        evidence: receipt as OutputJSONObject
      }
    }
  }
}
