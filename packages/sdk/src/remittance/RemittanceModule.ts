import type { PubKeyHex } from '../wallet/Wallet.interfaces.js'
import {
  Invoice,
  ModuleContext,
  RemittanceOptionId,
  ThreadId,
  Termination,
  Settlement
} from './types.js'

/**
 * A remittance module implements a specific settlement system.
 *
 * The RemittanceManager core uses module ids as the only “capability mechanism”:
 * if an invoice contains an option with module id X, a payer can only satisfy it
 * if they are configured with module X.
 *
 * Modules are trusted financial adapters. They must independently bind every accepted artifact
 * to the authenticated sender, invoice parties, selected option, amount, recipient, and concrete
 * settlement evidence. Returning `accept` is an authorization decision, not a parsing hint.
 */
export interface RemittanceModule<
  TOptionTerms = unknown,
  TSettlementArtifact = unknown,
  TReceiptData = unknown
> {
  /** Unique id used as the invoice.options key and as settlement.moduleId. */
  id: RemittanceOptionId
  /** Human-readable name for UIs. */
  name: string

  /**
   * Whether this module allows unsolicited settlements (i.e. settlement without an invoice).
   *
   * If true, the payer can build a settlement without an invoice being provided by the payee.
   * In this case, the option terms provided to `buildSettlement` may be used in lieu of an invoice.
   *
   * If false, an invoice must always be provided to `buildSettlement`.
   */
  allowUnsolicitedSettlements: boolean

  /**
   * Creates module-defined option terms that will be embedded into the invoice.
   *
   * In UTXO-ish offers, these option terms may include a partially-signed transaction template.
   *
   * Optional because some modules may not require any option data, or may only support unsolicited settlements.
   *
   * However, a module MAY still create option terms/invoices even if it can sometimes support unsolicited settlements.
   */
  createOption?: (
    args: { threadId: ThreadId; invoice: Invoice },
    ctx: ModuleContext
  ) => Promise<TOptionTerms>

  /**
   * Builds the settlement artifact for a chosen option.
   *
   * For UTXO settlement systems, this is usually a transaction (or partially-signed tx) to be broadcast.
   *
   * For unsolicited settlements, an invoice may not always be provided and the option terms may be used in lieu of an invoice to settle against.
   *
   * For example, the option terms may include a tx template with outputs to fulfill the settlement.
   *
   * When `allowUnsolicitedSettlements` is false, an invoice will always be provided.
   *
   * Termination can be returned to abort the protocol with a reason.
   *
   * A module that creates or broadcasts a transaction must durably associate
   * its transaction ID with `threadId` before permitting a retry. It must not
   * reuse one transaction ID for distinct threads or substitute a second
   * transaction while the first outcome is uncertain. Reconcile ambiguous
   * wallet or transport outcomes before building again.
   */
  buildSettlement: (
    args: { threadId: ThreadId; invoice?: Invoice; option: TOptionTerms; note?: string },
    ctx: ModuleContext
  ) => Promise<
    | { action: 'settle'; artifact: TSettlementArtifact }
    | { action: 'terminate'; termination: Termination }
  >

  /**
   * Accepts a settlement artifact on the payee side.
   *
   * The module should validate and internalize/store whatever it needs.
   * The manager will wrap the returned value as receipt.receiptData.
   *
   * If the settlement is invalid, the module should return either a termination or receiptData (possibly with a refund or indicating the failure), depending how the module chooses to handle it.
   * Implementations must durably associate each `threadId` with every accepted
   * transaction ID or other settlement identifier. Reject an identifier already
   * used for another thread and do not accept a different identifier for an
   * unreconciled thread. The manager cannot atomically commit an external
   * financial side effect with inbox acknowledgment, so callers must reconcile
   * ambiguous outcomes before retrying and must not rely on process memory for
   * replay protection.
   */
  acceptSettlement: (
    args: {
      threadId: ThreadId
      invoice?: Invoice
      settlement: TSettlementArtifact
      sender: PubKeyHex
    },
    ctx: ModuleContext
  ) => Promise<
    | { action: 'accept'; receiptData?: TReceiptData }
    | { action: 'terminate'; termination: Termination }
  >

  /**
   * Processes a receipt on the payer side.
   *
   * This is where a module can automatically internalize a refund, mark a local order fulfilled, receive goods and services, etc.
   */
  processReceipt?: (
    args: { threadId: ThreadId; invoice?: Invoice; receiptData: TReceiptData; sender: PubKeyHex },
    ctx: ModuleContext
  ) => Promise<void>

  /**
   * Processes a termination on either side.
   *
   * This is where a module can clean up any internal state, reverse provisional actions, take refunds, etc.
   */
  processTermination?: (
    args: {
      threadId: ThreadId
      invoice?: Invoice
      settlement?: Settlement
      termination: Termination
      sender: PubKeyHex
    },
    ctx: ModuleContext
  ) => Promise<void>
}
