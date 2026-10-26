import type {
  Invoice,
  IdentityVerificationRequest,
  IdentityVerificationResponse,
  IdentityVerificationAcknowledgment,
  Settlement,
  Receipt,
  Termination,
  RemittanceEnvelope,
  PeerMessage,
  ThreadId,
  UnixMillis,
  LoggerLike,
  ModuleContext,
  RemittanceKind,
  RemittanceOptionId,
  RemittanceThreadState
} from './types.js'
import { REMITTANCE_STATE_TRANSITIONS } from './types.js'
import type { CommsLayer } from './CommsLayer.js'
import type { IdentityLayer } from './IdentityLayer.js'
import type { RemittanceModule } from './RemittanceModule.js'
import {
  OriginatorDomainNameStringUnder250Bytes,
  PubKeyHex,
  WalletInterface
} from '../wallet/Wallet.interfaces.js'
import { stringifyBRC100 } from '../wallet/BRC100ByteEncoding.js'
import { toBase64, toSafeString } from '../primitives/utils.js'
import Random from '../primitives/Random.js'
import {
  copyRemittanceData,
  decimal as decimalString,
  denseArray as boundedStateArray,
  parseRemittanceEnvelope,
  record as plainStateRecord,
  string as boundedStateString,
  timestamp as safeStateTimestamp,
  validateRemittancePayload,
  validatePeerMessage,
  validatePeerMessageList
} from './RemittanceValidation.js'

export const DEFAULT_REMITTANCE_MESSAGEBOX = 'remittance_inbox'
const MAX_REMITTANCE_THREADS = 10_000
const MAX_THREAD_RECORDS = 10_000
const MAX_REMITTANCE_IDENTIFIER_LENGTH = 4096
const MAX_REMITTANCE_ENVELOPE_BYTES = 16 * 1024 * 1024
const MAX_REMITTANCE_MODULES = 1_000
const remittanceStates = new Set<RemittanceThreadState>(
  Object.keys(REMITTANCE_STATE_TRANSITIONS) as RemittanceThreadState[]
)

export interface RemittanceManagerRuntimeOptions {
  /** Identity verification options. */
  identityOptions?: {
    /** At what point should a maker request identity verification? */
    makerRequestIdentity?: 'never' | 'beforeInvoicing' | 'beforeSettlement'
    /** At what point should a taker request identity verification? */
    takerRequestIdentity?: 'never' | 'beforeInvoicing' | 'beforeSettlement'
  }
  /** If true, payees are expected to send receipts. */
  receiptProvided: boolean
  /** If true, manager auto-sends receipts as soon as a settlement is processed. */
  autoIssueReceipt: boolean
  /** Invoice expiry in seconds, or -1 for no expiry. */
  invoiceExpirySeconds: number
  /** Identity verification timeout in milliseconds. */
  identityTimeoutMs: number
  /** Identity verification poll interval in milliseconds. */
  identityPollIntervalMs: number
}

export interface RemittanceManagerConfig {
  /** Optional message box name to use for communication. */
  messageBox?: string
  /** Optional originator forwarded to wallet APIs. */
  originator?: OriginatorDomainNameStringUnder250Bytes
  /**
   * Provide a logger. If omitted, RemittanceManager stays quiet.
   *
   * Malformed inbound messages are rejected without mutating a thread. Transport and persistence
   * failures can still reject the calling operation.
   */
  logger?: LoggerLike

  /** Runtime options that influence core behavior. */
  options?: Partial<RemittanceManagerRuntimeOptions>

  /** Modules (remittance options) available to this manager. */
  remittanceModules: Array<RemittanceModule<any, any, any>>

  /** Optional identity layer for exchanging certificates before transacting. */
  identityLayer?: IdentityLayer

  /** Optional event callback for remittance lifecycle events. */
  onEvent?: (event: RemittanceEvent) => void
  /** Optional event callbacks keyed by process. */
  events?: RemittanceEventHandlers

  /**
   * Persist manager state. This callback is part of the trusted local boundary and must durably
   * integrity-protect each supplied checkpoint before reporting success.
   */
  stateSaver?: (state: RemittanceManagerState) => Promise<void> | void
  /**
   * Load manager state. Never return state from an unauthenticated or shared attacker-writable
   * store.
   */
  stateLoader?: () =>
    Promise<RemittanceManagerState | undefined> | RemittanceManagerState | undefined

  /** Injectable clock for tests. */
  now?: () => UnixMillis
  /** Injectable thread id factory for tests. */
  threadIdFactory?: () => ThreadId
}

export type RemittanceEvent =
  | {
      type: 'threadCreated'
      threadId: ThreadId
      thread: Thread
    }
  | {
      type: 'stateChanged'
      threadId: ThreadId
      previous: RemittanceThreadState
      next: RemittanceThreadState
      reason?: string
    }
  | {
      type: 'envelopeSent'
      threadId: ThreadId
      envelope: RemittanceEnvelope
      transportMessageId: string
    }
  | {
      type: 'envelopeReceived'
      threadId: ThreadId
      envelope: RemittanceEnvelope
      transportMessageId: string
    }
  | {
      type: 'identityRequested'
      threadId: ThreadId
      direction: 'in' | 'out'
      request: IdentityVerificationRequest
    }
  | {
      type: 'identityResponded'
      threadId: ThreadId
      direction: 'in' | 'out'
      response: IdentityVerificationResponse
    }
  | {
      type: 'identityAcknowledged'
      threadId: ThreadId
      direction: 'in' | 'out'
      acknowledgment: IdentityVerificationAcknowledgment
    }
  | {
      type: 'invoiceSent'
      threadId: ThreadId
      invoice: Invoice
    }
  | {
      type: 'invoiceReceived'
      threadId: ThreadId
      invoice: Invoice
    }
  | {
      type: 'settlementSent'
      threadId: ThreadId
      settlement: Settlement
    }
  | {
      type: 'settlementReceived'
      threadId: ThreadId
      settlement: Settlement
    }
  | {
      type: 'receiptSent'
      threadId: ThreadId
      receipt: Receipt
    }
  | {
      type: 'receiptReceived'
      threadId: ThreadId
      receipt: Receipt
    }
  | {
      type: 'terminationSent'
      threadId: ThreadId
      termination: Termination
    }
  | {
      type: 'terminationReceived'
      threadId: ThreadId
      termination: Termination
    }
  | {
      type: 'error'
      threadId: ThreadId
      error: string
    }

export interface RemittanceEventHandlers {
  onThreadCreated?: (event: Extract<RemittanceEvent, { type: 'threadCreated' }>) => void
  onStateChanged?: (event: Extract<RemittanceEvent, { type: 'stateChanged' }>) => void
  onEnvelopeSent?: (event: Extract<RemittanceEvent, { type: 'envelopeSent' }>) => void
  onEnvelopeReceived?: (event: Extract<RemittanceEvent, { type: 'envelopeReceived' }>) => void
  onIdentityRequested?: (event: Extract<RemittanceEvent, { type: 'identityRequested' }>) => void
  onIdentityResponded?: (event: Extract<RemittanceEvent, { type: 'identityResponded' }>) => void
  onIdentityAcknowledged?: (
    event: Extract<RemittanceEvent, { type: 'identityAcknowledged' }>
  ) => void
  onInvoiceSent?: (event: Extract<RemittanceEvent, { type: 'invoiceSent' }>) => void
  onInvoiceReceived?: (event: Extract<RemittanceEvent, { type: 'invoiceReceived' }>) => void
  onSettlementSent?: (event: Extract<RemittanceEvent, { type: 'settlementSent' }>) => void
  onSettlementReceived?: (event: Extract<RemittanceEvent, { type: 'settlementReceived' }>) => void
  onReceiptSent?: (event: Extract<RemittanceEvent, { type: 'receiptSent' }>) => void
  onReceiptReceived?: (event: Extract<RemittanceEvent, { type: 'receiptReceived' }>) => void
  onTerminationSent?: (event: Extract<RemittanceEvent, { type: 'terminationSent' }>) => void
  onTerminationReceived?: (event: Extract<RemittanceEvent, { type: 'terminationReceived' }>) => void
  onError?: (event: Extract<RemittanceEvent, { type: 'error' }>) => void
}

export interface Thread {
  threadId: ThreadId
  counterparty: PubKeyHex
  myRole: 'maker' | 'taker'
  theirRole: 'maker' | 'taker'
  createdAt: UnixMillis
  updatedAt: UnixMillis
  state: RemittanceThreadState
  /** State transition log for audit purposes. */
  stateLog: Array<{
    at: UnixMillis
    from: RemittanceThreadState
    to: RemittanceThreadState
    reason?: string
  }>

  /** Transport messageIds processed for this thread (dedupe across retries). */
  processedMessageIds: string[]

  /** Protocol envelopes received/sent (for debugging/audit). */
  protocolLog: Array<{
    direction: 'in' | 'out'
    envelope: RemittanceEnvelope
    transportMessageId: string
  }>

  identity: {
    certsSent: IdentityVerificationResponse['certificates']
    certsReceived: IdentityVerificationResponse['certificates']
    requestSent: boolean
    responseSent: boolean
    acknowledgmentSent: boolean
    acknowledgmentReceived: boolean
  }

  invoice?: Invoice
  settlement?: Settlement
  receipt?: Receipt
  termination?: Termination

  flags: {
    /**
     * At least one identity exchange direction completed. This is a lifecycle/UI signal, not a
     * peer-authorization verdict. `identity.acknowledgmentSent` specifically means the local
     * IdentityLayer assessed the counterparty's certificates as sufficient.
     */
    hasIdentified: boolean
    hasInvoiced: boolean
    hasPaid: boolean
    hasReceipted: boolean
    error: boolean
  }

  lastError?: { message: string; at: UnixMillis }
}

export interface RemittanceManagerState {
  v: 1
  threads: Thread[]
  defaultPaymentOptionId?: string
}

export interface ComposeInvoiceInput {
  /** Human note/memo. */
  note?: string
  /** Line items. */
  lineItems: Invoice['lineItems']
  /** Total amount. */
  total: Invoice['total']
  invoiceNumber?: string
  arbitrary?: Record<string, unknown>
}

/**
 * RemittanceManager.
 *
 * Responsibilities:
 * - message transport via CommsLayer
 * - thread lifecycle and persistence (via stateSaver/stateLoader)
 * - invoice creation and transmission (when invoices are used)
 * - settlement and settlement routing to the appropriate module
 * - receipt issuance and receipt routing to the appropriate module
 * - identity and identity certificate exchange (when identity layer is used)
 *
 * Non-responsibilities (left to modules):
 * - transaction structure (whether UTXO “offer” formats, token logic, BRC-98/99 specifics, etc.)
 * - validation rules for settlement (e.g. partial tx templates, UTXO validity, etc.)
 * - on-chain broadcasting strategy or non-chain settlement specifics (like legacy payment protocols)
 * - Providing option terms for invoices
 * - Building settlement artifacts
 * - Accepting/rejecting settlements
 * - Deciding which identity certificates to request
 * - Deciding about sufficiency of identity certificates
 * - Preparing/processing specific receipt formats
 * - Internal business logic like order fulfillment, refunds, etc.
 */
export class RemittanceManager {
  readonly wallet: WalletInterface
  readonly comms: CommsLayer
  readonly cfg: RemittanceManagerConfig

  readonly #messageBox: string
  readonly #now: () => UnixMillis
  readonly #threadIdFactory: () => ThreadId

  readonly #moduleRegistry: Map<string, RemittanceModule<any, any, any>>
  readonly #runtime: RemittanceManagerRuntimeOptions
  readonly #eventListeners: Set<(event: RemittanceEvent) => void>
  readonly #stateWaiters: Map<
    ThreadId,
    Array<{ state: RemittanceThreadState; resolve: () => void; reject: (err: Error) => void }>
  >
  readonly #eventHandlers?: RemittanceEventHandlers
  readonly #inboundProcessing: Map<string, Promise<boolean>>
  readonly #settlementOperations: Set<ThreadId>
  readonly #issuedEnvelopeIds: Set<string>
  readonly #processedInboundEnvelopeIds: Set<string>

  /** Default option id used when paying an invoice, if not overridden per-call. */
  private defaultPaymentOptionId?: string

  /**
   * Mutable local administrative state (persisted via stateSaver). Code with this reference is
   * trusted at the same level as the state store and must not mutate financial or identity facts.
   */
  threads: Thread[]

  /** Cached identity key if wallet provides it. */
  #myIdentityKey?: PubKeyHex

  constructor(
    cfg: RemittanceManagerConfig,
    wallet: WalletInterface,
    commsLayer: CommsLayer,
    threads: Thread[] = []
  ) {
    const modules = validateRemittanceModules(cfg.remittanceModules)
    const messageBox = boundedStateString(
      cfg.messageBox ?? DEFAULT_REMITTANCE_MESSAGEBOX,
      'Remittance message box'
    )
    const sourceNow = cfg.now ?? (() => Date.now())
    const sourceThreadIdFactory = cfg.threadIdFactory ?? defaultThreadIdFactory
    this.cfg = {
      ...cfg,
      messageBox,
      remittanceModules: modules,
      options: cfg.options == null ? undefined : { ...cfg.options }
    }
    this.wallet = wallet
    this.comms = commsLayer
    this.#messageBox = messageBox

    this.#now = () => safeStateTimestamp(sourceNow(), 'Remittance clock result')
    this.#threadIdFactory = () =>
      boundedStateString(sourceThreadIdFactory(), 'Generated remittance id') as ThreadId

    this.#moduleRegistry = new Map(modules.map(m => [m.id, m]))
    this.#eventListeners = new Set()
    this.#stateWaiters = new Map()
    this.#inboundProcessing = new Map()
    this.#settlementOperations = new Set()
    this.#issuedEnvelopeIds = new Set()
    this.#processedInboundEnvelopeIds = new Set()
    this.#eventHandlers = this.cfg.events
    if (typeof this.cfg.onEvent === 'function') {
      this.#eventListeners.add(this.cfg.onEvent)
    }

    this.#runtime = {
      identityOptions: validateIdentityOptions(this.cfg.options?.identityOptions),
      receiptProvided: booleanOption(this.cfg.options?.receiptProvided, true, 'receiptProvided'),
      autoIssueReceipt: booleanOption(this.cfg.options?.autoIssueReceipt, true, 'autoIssueReceipt'),
      invoiceExpirySeconds: invoiceExpiry(this.cfg.options?.invoiceExpirySeconds ?? 3600),
      identityTimeoutMs: duration(
        this.cfg.options?.identityTimeoutMs ?? 30_000,
        'identityTimeoutMs'
      ),
      identityPollIntervalMs: duration(
        this.cfg.options?.identityPollIntervalMs ?? 500,
        'identityPollIntervalMs',
        false
      )
    }

    this.threads = this.#validateThreadStateArray(threads)
    this.#rebuildIssuedEnvelopeIds()
    this.#rebuildProcessedInboundEnvelopeIds()
  }

  /**
   * Loads persisted state from cfg.stateLoader (if provided).
   *
   * Safe to call multiple times.
   */
  async init(): Promise<void> {
    if (typeof this.cfg.stateLoader !== 'function') return

    const loaded = await this.cfg.stateLoader()
    if (loaded == null || typeof loaded !== 'object') return

    this.loadState(loaded)
    await this.#refreshMyIdentityKey()
  }

  /**
   * Registers a remittance event listener.
   */
  onEvent(listener: (event: RemittanceEvent) => void): () => void {
    this.#eventListeners.add(listener)
    return () => {
      this.#eventListeners.delete(listener)
    }
  }

  /**
   * Sets a default payment option (module id) to use when paying invoices.
   */
  preselectPaymentOption(optionId: string): void {
    this.defaultPaymentOptionId = boundedStateString(optionId, 'Payment option id')
  }

  /**
   * Returns an immutable snapshot of current manager state suitable for persistence.
   */
  saveState(): RemittanceManagerState {
    return {
      v: 1,
      threads: copyRemittanceData(this.threads),
      defaultPaymentOptionId: this.defaultPaymentOptionId
    }
  }

  /**
   * Loads state from an object previously produced by saveState().
   */
  loadState(state: RemittanceManagerState): void {
    const snapshot = copyRemittanceData(state as unknown as RemittanceManagerState)
    const stateRecord = plainStateRecord(snapshot, 'Remittance manager state')
    if (stateRecord.v !== 1) throw new Error('Unsupported RemittanceManagerState version')
    this.threads = this.#validateThreadStateArray(stateRecord.threads, false)
    this.defaultPaymentOptionId =
      stateRecord.defaultPaymentOptionId === undefined
        ? undefined
        : boundedStateString(stateRecord.defaultPaymentOptionId, 'Default payment option id')
    this.#rebuildIssuedEnvelopeIds()
    this.#rebuildProcessedInboundEnvelopeIds()
    if (this.#myIdentityKey != null) this.#validateStoredThreadParties()
  }

  /**
   * Persists current state via cfg.stateSaver (if provided).
   */
  async persistState(): Promise<void> {
    if (this.cfg.stateSaver == null) return
    await this.cfg.stateSaver(this.saveState())
  }

  /**
   * Syncs threads by fetching pending messages from the comms layer and processing them.
   *
   * Processing is idempotent using transport messageIds tracked per thread.
   * Messages are acknowledged after they are successfully applied to local state.
   */
  async syncThreads(hostOverride?: string): Promise<void> {
    await this.#refreshMyIdentityKey()

    const msgs = validatePeerMessageList(
      await this.comms.listMessages({ messageBox: this.#messageBox, host: hostOverride })
    )

    for (const msg of msgs) {
      await this.#handleInboundMessage(msg)
    }
  }

  /**
   * Starts listening for live messages (if the CommsLayer supports it).
   */
  async startListening(hostOverride?: string): Promise<void> {
    if (typeof this.comms.listenForLiveMessages !== 'function') {
      throw new TypeError('CommsLayer does not support live message listening')
    }

    await this.#refreshMyIdentityKey()
    await this.comms.listenForLiveMessages({
      messageBox: this.#messageBox,
      overrideHost: hostOverride,
      onMessage: msg => {
        void this.#handleInboundMessage(msg).catch(error => {
          this.cfg.logger?.error?.('[RemittanceManager] Live message processing failed', error)
        })
      }
    })
  }

  /**
   * Creates, records, and sends an invoice to a counterparty.
   *
   * Returns a handle you can use to wait for payment/receipt.
   */
  async sendInvoice(
    to: PubKeyHex,
    input: ComposeInvoiceInput,
    hostOverride?: string
  ): Promise<InvoiceHandle> {
    await this.#refreshMyIdentityKey()
    const threadId = this.#newThreadId()
    const createdAt = this.#now()

    const myKey = this.#requireMyIdentityKey(
      'sendInvoice requires the wallet to provide an identity key'
    )

    const thread: Thread = {
      threadId,
      counterparty: to,
      myRole: 'maker',
      theirRole: 'taker',
      createdAt,
      updatedAt: createdAt,
      state: 'new',
      stateLog: [],
      processedMessageIds: [],
      protocolLog: [],
      identity: {
        certsSent: [],
        certsReceived: [],
        requestSent: false,
        responseSent: false,
        acknowledgmentSent: false,
        acknowledgmentReceived: false
      },
      flags: {
        hasIdentified: false,
        hasInvoiced: false,
        hasPaid: false,
        hasReceipted: false,
        error: false
      }
    }

    this.threads.push(thread)
    this.#emitEvent({ type: 'threadCreated', threadId: thread.threadId, thread })

    if (thread.identity.responseSent && !thread.identity.acknowledgmentReceived) {
      await this.#waitForIdentityAcknowledgment(threadId, 'received', {
        timeoutMs: this.#runtime.identityTimeoutMs,
        pollIntervalMs: this.#runtime.identityPollIntervalMs
      })
    }

    if (this.#shouldRequestIdentity(thread, 'beforeInvoicing')) {
      await this.#ensureIdentityExchange(thread, hostOverride)
    }

    const invoice = await this.#composeInvoice(threadId, myKey, to, input)
    thread.invoice = invoice
    thread.flags.hasInvoiced = true
    this.#transitionThreadState(thread, 'invoiced', 'invoice created')

    // Generate option terms for each configured module.
    for (const mod of this.#moduleRegistry.values()) {
      if (typeof mod.createOption !== 'function') continue
      const option = await mod.createOption({ threadId, invoice }, this.#moduleContext())
      invoice.options[mod.id] = option
    }

    const env = this.#makeEnvelope('invoice', threadId, invoice)
    const mid = await this.#sendEnvelope(to, env, hostOverride)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'invoiceSent', threadId: thread.threadId, invoice })
    thread.updatedAt = this.#now()
    await this.persistState()

    return new InvoiceHandle(this, threadId)
  }

  /**
   * Sends an invoice for an existing thread, e.g. after an identity request was received.
   */
  async sendInvoiceForThread(
    threadId: ThreadId,
    input: ComposeInvoiceInput,
    hostOverride?: string
  ): Promise<InvoiceHandle> {
    await this.#refreshMyIdentityKey()
    const thread = this.getThreadOrThrow(threadId)

    if (thread.flags.error) throw new Error('Thread is in error state')
    if (thread.myRole !== 'maker') throw new Error('Only makers can send invoices')
    if (thread.invoice != null) throw new Error('Thread already has an invoice')

    if (thread.identity.responseSent && !thread.identity.acknowledgmentReceived) {
      await this.#waitForIdentityAcknowledgment(threadId, 'received', {
        timeoutMs: this.#runtime.identityTimeoutMs,
        pollIntervalMs: this.#runtime.identityPollIntervalMs
      })
    }

    if (this.#shouldRequestIdentity(thread, 'beforeInvoicing')) {
      await this.#ensureIdentityExchange(thread, hostOverride)
    }

    const myKey = this.#requireMyIdentityKey(
      'sendInvoice requires the wallet to provide an identity key'
    )
    const invoice = await this.#composeInvoice(threadId, myKey, thread.counterparty, input)
    thread.invoice = invoice
    thread.flags.hasInvoiced = true
    this.#transitionThreadState(thread, 'invoiced', 'invoice created')

    for (const mod of this.#moduleRegistry.values()) {
      if (typeof mod.createOption !== 'function') continue
      const option = await mod.createOption({ threadId, invoice }, this.#moduleContext())
      invoice.options[mod.id] = option
    }

    const env = this.#makeEnvelope('invoice', threadId, invoice)
    const mid = await this.#sendEnvelope(thread.counterparty, env, hostOverride)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'invoiceSent', threadId: thread.threadId, invoice })
    thread.updatedAt = this.#now()
    await this.persistState()

    return new InvoiceHandle(this, threadId)
  }

  /**
   * Returns invoice handles that this manager can pay (we are the taker/payer).
   */
  findInvoicesPayable(counterparty?: PubKeyHex): InvoiceHandle[] {
    const hasCounterparty = typeof counterparty === 'string' && counterparty.length > 0
    return this.threads
      .filter(
        t => t.myRole === 'taker' && t.invoice != null && t.settlement == null && !t.flags.error
      )
      .filter(t => (hasCounterparty ? t.counterparty === counterparty : true))
      .map(t => new InvoiceHandle(this, t.threadId))
  }

  /**
   * Returns invoice handles that we issued and are waiting to receive settlement for.
   */
  findReceivableInvoices(counterparty?: PubKeyHex): InvoiceHandle[] {
    const hasCounterparty = typeof counterparty === 'string' && counterparty.length > 0
    return this.threads
      .filter(
        t => t.myRole === 'maker' && t.invoice != null && t.settlement == null && !t.flags.error
      )
      .filter(t => (hasCounterparty ? t.counterparty === counterparty : true))
      .map(t => new InvoiceHandle(this, t.threadId))
  }

  /**
   * Pays an invoice by selecting a remittance option and sending a settlement message.
   *
   * If receipts are enabled (receiptProvided), this method will optionally wait for a receipt.
   */
  async pay(
    threadId: ThreadId,
    optionId?: string,
    hostOverride?: string
  ): Promise<Receipt | Termination | undefined> {
    if (this.#settlementOperations.has(threadId)) {
      throw new Error('A settlement operation is already in progress for this thread')
    }
    this.#settlementOperations.add(threadId)
    try {
      return await this.#payOnce(threadId, optionId, hostOverride)
    } finally {
      this.#settlementOperations.delete(threadId)
    }
  }

  async #payOnce(
    threadId: ThreadId,
    optionId?: string,
    hostOverride?: string
  ): Promise<Receipt | Termination | undefined> {
    await this.#refreshMyIdentityKey()

    const thread = this.getThreadOrThrow(threadId)
    if (thread.invoice == null) throw new Error('Thread has no invoice to pay')

    if (thread.flags.error) throw new Error('Thread is in error state')
    if (thread.settlement != null) throw new Error('Invoice already paid (settlement exists)')

    if (thread.identity.responseSent && !thread.identity.acknowledgmentReceived) {
      await this.#waitForIdentityAcknowledgment(threadId, 'received', {
        timeoutMs: this.#runtime.identityTimeoutMs,
        pollIntervalMs: this.#runtime.identityPollIntervalMs
      })
    }

    if (this.#shouldRequestIdentity(thread, 'beforeSettlement')) {
      await this.#ensureIdentityExchange(thread, hostOverride)
    }

    // Check expiry.
    const expiresAt = thread.invoice.expiresAt
    if (typeof expiresAt === 'number' && this.#now() > expiresAt) {
      throw new Error('Invoice is expired')
    }

    const chosenOptionId =
      optionId ?? this.defaultPaymentOptionId ?? Object.keys(thread.invoice.options)[0]
    if (chosenOptionId == null || chosenOptionId === '') {
      throw new Error('No remittance options available on invoice')
    }

    const module = this.#moduleRegistry.get(chosenOptionId)
    if (module == null) {
      throw new Error(`No configured remittance module for option: ${chosenOptionId}`)
    }

    const option = thread.invoice.options[chosenOptionId]
    const myKey = this.#requireMyIdentityKey('pay() requires the wallet to provide an identity key')

    const buildResult = await module.buildSettlement(
      { threadId, invoice: thread.invoice, option, note: thread.invoice.note },
      this.#moduleContext()
    )

    if (buildResult.action === 'terminate') {
      const termination = buildResult.termination
      await this.#sendTermination(
        thread,
        thread.counterparty,
        termination.message,
        termination.details,
        termination.code
      )
      await this.persistState()
      return termination
    }
    if (buildResult.action !== 'settle') {
      throw new Error('Unknown settlement build action')
    }

    const settlement: Settlement = {
      kind: 'settlement',
      threadId,
      moduleId: module.id,
      optionId: chosenOptionId,
      sender: myKey,
      createdAt: this.#now(),
      artifact: buildResult.artifact,
      note: thread.invoice.note
    }

    const env = this.#makeEnvelope('settlement', threadId, settlement)

    // Send settlement to payee (invoice.payee).
    const mid = await this.#sendEnvelope(thread.invoice.payee, env, hostOverride)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'settlementSent', threadId: thread.threadId, settlement })

    thread.settlement = settlement
    thread.flags.hasPaid = true
    this.#transitionThreadState(thread, 'settled', 'settlement sent')
    thread.updatedAt = this.#now()
    await this.persistState()

    if (!this.#runtime.receiptProvided) {
      return undefined
    }

    // Wait for receipt (polling + syncThreads) up to a default timeout.
    return await this.waitForReceipt(threadId)
  }

  /**
   * Waits for a receipt to arrive for a thread.
   *
   * Uses polling via syncThreads because live listeners are optional.
   */
  async waitForReceipt(
    threadId: ThreadId,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Receipt | Termination> {
    const { timeoutMs, pollIntervalMs } = waitDurations(opts)

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const t = this.getThreadOrThrow(threadId)
      if (typeof t.receipt === 'object') return t.receipt
      if (typeof t.termination === 'object') return t.termination

      await this.syncThreads()
      await sleep(pollIntervalMs)
    }

    throw new Error('Timed out waiting for receipt')
  }

  /**
   * Waits for a thread to reach a specific state.
   */
  async waitForState(
    threadId: ThreadId,
    state: RemittanceThreadState,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Thread> {
    const { timeoutMs, pollIntervalMs } = waitDurations(opts)
    const start = Date.now()

    const t = this.getThreadOrThrow(threadId)
    if (t.state === state) return t
    if (t.state === 'terminated' || t.state === 'errored') {
      throw new Error(`Thread entered terminal state: ${t.state}`)
    }

    let settled = false
    let timedOut = false

    let resolvePromise: () => void
    let rejectPromise: (err: Error) => void

    const entry = {
      state,
      resolve: () => {
        if (settled || timedOut) return
        settled = true
        resolvePromise()
      },
      reject: (err: Error) => {
        if (settled || timedOut) return
        settled = true
        rejectPromise(err)
      }
    }

    const waiter = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
      const waiters = this.#stateWaiters.get(threadId) ?? []
      waiters.push(entry)
      this.#stateWaiters.set(threadId, waiters)
    })

    const removeEntry = (): void => {
      const waiters = this.#stateWaiters.get(threadId)
      if (waiters == null) return
      const remaining = waiters.filter(item => item !== entry)
      if (remaining.length === 0) {
        this.#stateWaiters.delete(threadId)
      } else {
        this.#stateWaiters.set(threadId, remaining)
      }
    }

    const poller = (async () => {
      while (Date.now() - start < timeoutMs) {
        if (settled) return
        const current = this.getThreadOrThrow(threadId)
        if (current.state === state) {
          this.#resolveStateWaiters(threadId, state)
          return
        }
        if (current.state === 'terminated' || current.state === 'errored') {
          throw new Error(`Thread entered terminal state: ${current.state}`)
        }
        await this.syncThreads()
        await sleep(pollIntervalMs)
      }
    })()

    await Promise.race([waiter, poller]).catch(err => {
      removeEntry()
      throw err
    })

    if (Date.now() - start >= timeoutMs && !settled) {
      timedOut = true
      removeEntry()
      throw new Error(`Timed out waiting for state: ${state}`)
    }

    removeEntry()
    return this.getThreadOrThrow(threadId)
  }

  /**
   * Waits for identity exchange to complete for a thread.
   */
  async waitForIdentity(
    threadId: ThreadId,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<Thread> {
    return await this.waitForState(threadId, 'identityAcknowledged', opts)
  }

  /**
   * Waits for a settlement to arrive for a thread.
   */
  async waitForSettlement(
    threadId: ThreadId,
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<Settlement | Termination> {
    const { timeoutMs, pollIntervalMs } = waitDurations(opts)

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const t = this.getThreadOrThrow(threadId)
      if (typeof t.settlement === 'object') return t.settlement
      if (typeof t.termination === 'object') return t.termination

      await this.syncThreads()
      await sleep(pollIntervalMs)
    }

    throw new Error('Timed out waiting for settlement')
  }

  /**
   * Sends an unsolicited settlement to a counterparty.
   */
  async sendUnsolicitedSettlement(
    to: PubKeyHex,
    args: {
      moduleId: RemittanceOptionId
      option: unknown
      optionId?: RemittanceOptionId
      note?: string
    },
    hostOverride?: string
  ): Promise<ThreadHandle> {
    await this.#refreshMyIdentityKey()

    const module = this.#moduleRegistry.get(args.moduleId)
    if (module == null)
      throw new Error(`No configured remittance module for option: ${args.moduleId}`)
    if (!module.allowUnsolicitedSettlements) {
      throw new Error(`Remittance module ${args.moduleId} does not allow unsolicited settlements`)
    }

    const threadId = this.#newThreadId()
    const createdAt = this.#now()
    const myKey = this.#requireMyIdentityKey(
      'sendUnsolicitedSettlement requires the wallet to provide an identity key'
    )

    const thread: Thread = {
      threadId,
      counterparty: to,
      myRole: 'taker',
      theirRole: 'maker',
      createdAt,
      updatedAt: createdAt,
      state: 'new',
      stateLog: [],
      processedMessageIds: [],
      protocolLog: [],
      identity: {
        certsSent: [],
        certsReceived: [],
        requestSent: false,
        responseSent: false,
        acknowledgmentSent: false,
        acknowledgmentReceived: false
      },
      flags: {
        hasIdentified: false,
        hasInvoiced: false,
        hasPaid: false,
        hasReceipted: false,
        error: false
      }
    }

    this.threads.push(thread)
    this.#emitEvent({ type: 'threadCreated', threadId: thread.threadId, thread })

    if (this.#shouldRequestIdentity(thread, 'beforeSettlement')) {
      await this.#ensureIdentityExchange(thread, hostOverride)
    }

    const buildResult = await module.buildSettlement(
      { threadId, option: args.option, note: args.note },
      this.#moduleContext()
    )

    if (buildResult.action === 'terminate') {
      await this.#sendTermination(
        thread,
        to,
        buildResult.termination.message,
        buildResult.termination.details,
        buildResult.termination.code
      )
      await this.persistState()
      return new ThreadHandle(this, threadId)
    }
    if (buildResult.action !== 'settle') {
      throw new Error('Unknown settlement build action')
    }

    const settlement: Settlement = {
      kind: 'settlement',
      threadId,
      moduleId: module.id,
      optionId: args.optionId ?? module.id,
      sender: myKey,
      createdAt: this.#now(),
      artifact: buildResult.artifact,
      note: args.note
    }

    const env = this.#makeEnvelope('settlement', threadId, settlement)
    const mid = await this.#sendEnvelope(to, env, hostOverride)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'settlementSent', threadId: thread.threadId, settlement })
    thread.settlement = settlement
    thread.flags.hasPaid = true
    this.#transitionThreadState(thread, 'settled', 'settlement sent')
    thread.updatedAt = this.#now()
    await this.persistState()

    return new ThreadHandle(this, threadId)
  }

  /**
   * Returns a thread by id (if present).
   */
  getThread(threadId: ThreadId): Thread | undefined {
    return this.threads.find(t => t.threadId === threadId)
  }

  /**
   * Returns a thread handle by id, or throws if the thread does not exist.
   */
  getThreadHandle(threadId: ThreadId): ThreadHandle {
    this.getThreadOrThrow(threadId)
    return new ThreadHandle(this, threadId)
  }

  /**
   * Returns a thread by id or throws.
   *
   * Public so helper handles (e.g. InvoiceHandle) can call it.
   */
  getThreadOrThrow(threadId: ThreadId): Thread {
    const t = this.getThread(threadId)
    if (typeof t !== 'object') throw new Error(`Unknown thread: ${threadId}`)
    return this.#ensureThreadState(t)
  }

  // ----------------------------
  // Internal helpers
  // ----------------------------

  #moduleContext(): ModuleContext {
    return {
      wallet: this.wallet,
      originator: this.cfg.originator,
      now: this.#now,
      logger: this.cfg.logger
    }
  }

  #newThreadId(): ThreadId {
    const threadId = this.#threadIdFactory()
    if (this.getThread(threadId) != null) {
      throw new Error('Generated remittance thread ID is not unique')
    }
    return threadId
  }

  #rebuildIssuedEnvelopeIds(): void {
    this.#issuedEnvelopeIds.clear()
    for (const thread of this.threads) {
      for (const entry of thread.protocolLog) {
        const entryRecord = plainStateRecord(entry, 'Remittance protocol log entry')
        if (entryRecord.direction !== 'out') continue
        const envelope = plainStateRecord(entryRecord.envelope, 'Remittance protocol log envelope')
        const id = boundedStateString(envelope.id, 'Remittance protocol envelope id')
        if (this.#issuedEnvelopeIds.has(id)) {
          throw new Error('Persisted remittance envelope IDs must be unique')
        }
        this.#issuedEnvelopeIds.add(id)
      }
    }
  }

  #inboundEnvelopeKey(sender: string, envelopeId: string): string {
    return JSON.stringify([sender, envelopeId])
  }

  #rebuildProcessedInboundEnvelopeIds(): void {
    this.#processedInboundEnvelopeIds.clear()
    for (const thread of this.threads) {
      for (const entry of thread.protocolLog) {
        if (
          entry.direction !== 'in' ||
          !thread.processedMessageIds.includes(entry.transportMessageId)
        ) {
          continue
        }
        const key = this.#inboundEnvelopeKey(thread.counterparty, entry.envelope.id)
        this.#processedInboundEnvelopeIds.add(key)
      }
    }
  }

  #makeEnvelope<K extends RemittanceKind, P>(
    kind: K,
    threadId: ThreadId,
    payload: P
  ): RemittanceEnvelope<K, P> {
    const id = this.#threadIdFactory()
    if (this.#issuedEnvelopeIds.has(id)) {
      throw new Error('Generated remittance envelope ID is not unique')
    }
    this.#issuedEnvelopeIds.add(id)
    return {
      v: 1,
      id,
      kind,
      threadId,
      createdAt: this.#now(),
      payload
    }
  }

  async #sendEnvelope(
    recipient: PubKeyHex,
    env: RemittanceEnvelope,
    hostOverride?: string
  ): Promise<string> {
    recipient = boundedStateString(recipient, 'Remittance recipient') as PubKeyHex
    const body = stringifyBRC100(env)
    if (
      body.length === 0 ||
      body.length > MAX_REMITTANCE_ENVELOPE_BYTES ||
      parseRemittanceEnvelope(body) == null
    ) {
      throw new TypeError('Outbound remittance envelope is invalid or exceeds the size limit')
    }

    // Prefer live if available.
    if (typeof this.comms.sendLiveMessage === 'function') {
      try {
        const mid = boundedStateString(
          await this.comms.sendLiveMessage(
            { recipient, messageBox: this.#messageBox, body },
            hostOverride
          ),
          'Live transport message ID'
        )
        this.#emitEvent({
          type: 'envelopeSent',
          threadId: env.threadId,
          envelope: env,
          transportMessageId: mid
        })
        return mid
      } catch (e) {
        this.cfg.logger?.warn?.(
          '[RemittanceManager] sendLiveMessage failed, falling back to non-live',
          e
        )
      }
    }

    const mid = boundedStateString(
      await this.comms.sendMessage({ recipient, messageBox: this.#messageBox, body }, hostOverride),
      'Transport message ID'
    )
    this.#emitEvent({
      type: 'envelopeSent',
      threadId: env.threadId,
      envelope: env,
      transportMessageId: mid
    })
    return mid
  }

  private identityRequesterRole(): Thread['myRole'] | undefined {
    const makerRequest = this.#runtime.identityOptions?.makerRequestIdentity ?? 'never'
    const takerRequest = this.#runtime.identityOptions?.takerRequestIdentity ?? 'never'
    const makerRequests = makerRequest !== 'never'
    const takerRequests = takerRequest !== 'never'
    if (makerRequests && !takerRequests) return 'maker'
    if (takerRequests && !makerRequests) return 'taker'
    if (!makerRequests || !takerRequests || makerRequest === takerRequest) {
      return undefined
    }
    if (makerRequest === 'beforeInvoicing' && takerRequest === 'beforeSettlement') {
      return 'maker'
    }
    if (makerRequest === 'beforeSettlement' && takerRequest === 'beforeInvoicing') {
      return 'taker'
    }
    return undefined
  }

  #inferInboundRole(kind: RemittanceKind): Thread['myRole'] {
    if (kind === 'invoice' || kind === 'receipt' || kind === 'termination') {
      return 'taker'
    }
    if (kind === 'settlement') return 'maker'
    const identityKinds: RemittanceKind[] = [
      'identityVerificationRequest',
      'identityVerificationResponse',
      'identityVerificationAcknowledgment'
    ]
    if (!identityKinds.includes(kind)) return 'taker'
    const requesterRole = this.identityRequesterRole()
    if (requesterRole == null) return 'taker'
    if (kind === 'identityVerificationResponse') return requesterRole
    return requesterRole === 'maker' ? 'taker' : 'maker'
  }

  #getOrCreateThreadFromInboundEnvelope(env: RemittanceEnvelope, msg: PeerMessage): Thread {
    const existing = this.getThread(env.threadId)
    if (typeof existing === 'object') return existing
    if (this.threads.length >= MAX_REMITTANCE_THREADS) {
      throw new Error('Remittance thread limit reached')
    }

    // If we didn't create the thread, infer roles from the first message kind:
    // - Receiving identity verification request/response/acknowledgment -> we are either maker or taker depending on config
    // - Receiving an invoice -> we are taker (payer)
    // - Receiving a settlement -> we are maker (payee)
    // - Receiving a receipt -> we are taker
    // - Receiving a termination -> assume we are taker
    const createdAt = this.#now()

    const inferredMyRole = this.#inferInboundRole(env.kind)
    const inferredTheirRole: Thread['theirRole'] = inferredMyRole === 'maker' ? 'taker' : 'maker'

    const t: Thread = {
      threadId: env.threadId,
      counterparty: msg.sender,
      myRole: inferredMyRole,
      theirRole: inferredTheirRole,
      createdAt,
      updatedAt: createdAt,
      state: 'new',
      stateLog: [],
      processedMessageIds: [],
      protocolLog: [],
      identity: {
        certsSent: [],
        certsReceived: [],
        requestSent: false,
        responseSent: false,
        acknowledgmentSent: false,
        acknowledgmentReceived: false
      },
      flags: {
        hasIdentified: false,
        hasInvoiced: false,
        hasPaid: false,
        hasReceipted: false,
        error: false
      }
    }

    this.threads.push(t)
    this.#emitEvent({ type: 'threadCreated', threadId: t.threadId, thread: t })
    return t
  }

  async #handleInboundMessage(candidate: unknown): Promise<void> {
    let msg: PeerMessage
    let parsed: RemittanceEnvelope
    try {
      msg = validatePeerMessage(
        candidate,
        this.#requireMyIdentityKey('Receiving messages requires an identity key'),
        this.#messageBox
      )
      const envelope = parseRemittanceEnvelope(msg.body)
      if (envelope == null) return
      parsed = envelope
    } catch (error) {
      this.cfg.logger?.warn?.('[RemittanceManager] Rejected invalid inbound message', error)
      return
    }

    const processingKey = this.#inboundEnvelopeKey(msg.sender, parsed.id)
    const knownThread = this.getThread(parsed.threadId)
    if (knownThread != null && knownThread.counterparty !== msg.sender) {
      this.cfg.logger?.warn?.(
        '[RemittanceManager] Rejected inbound message from a non-counterparty sender'
      )
      return
    }
    const current = this.#inboundProcessing.get(processingKey)
    if (current != null) {
      if (await current) await this.#safeAck([msg.messageId])
      return
    }
    if (this.#processedInboundEnvelopeIds.has(processingKey)) {
      await this.#safeAck([msg.messageId])
      return
    }
    try {
      this.#validateInboundAuthority(parsed, msg)
    } catch (error) {
      this.cfg.logger?.warn?.('[RemittanceManager] Rejected unauthorized inbound message', error)
      return
    }

    const operation = this.#processInboundMessage(parsed, msg)
    this.#inboundProcessing.set(processingKey, operation)
    try {
      if (await operation) await this.#safeAck([msg.messageId])
    } finally {
      if (this.#inboundProcessing.get(processingKey) === operation) {
        this.#inboundProcessing.delete(processingKey)
      }
    }
  }

  async #processInboundMessage(parsed: RemittanceEnvelope, msg: PeerMessage): Promise<boolean> {
    const processedEnvelopeKey = this.#inboundEnvelopeKey(msg.sender, parsed.id)
    if (this.#processedInboundEnvelopeIds.has(processedEnvelopeKey)) return true
    const existing = this.getThread(parsed.threadId)
    if (
      existing?.processedMessageIds.includes(msg.messageId) === true ||
      existing?.protocolLog.some(
        entry =>
          entry.direction === 'in' &&
          entry.envelope.id === parsed.id &&
          existing.processedMessageIds.includes(entry.transportMessageId)
      ) === true
    ) {
      return true
    }

    const thread = this.#getOrCreateThreadFromInboundEnvelope(parsed, msg)
    if (
      thread.processedMessageIds.length >= MAX_THREAD_RECORDS ||
      thread.protocolLog.length >= MAX_THREAD_RECORDS
    ) {
      this.cfg.logger?.warn?.('[RemittanceManager] Thread processing limit reached')
      return false
    }
    try {
      await this.#applyInboundEnvelope(thread, parsed, msg)
      thread.processedMessageIds.push(msg.messageId)
      thread.updatedAt = this.#now()
      await this.persistState()
      this.#processedInboundEnvelopeIds.add(processedEnvelopeKey)
      return true
    } catch (error) {
      try {
        this.#markThreadError(thread, error)
        await this.persistState()
      } catch (persistenceError) {
        this.cfg.logger?.error?.(
          '[RemittanceManager] Failed to persist inbound processing error',
          persistenceError
        )
      }
      return false
    }
  }

  #validateInboundAuthority(env: RemittanceEnvelope, msg: PeerMessage): void {
    const thread = this.getThread(env.threadId)
    const myIdentityKey = this.#requireMyIdentityKey('Receiving messages requires an identity key')
    if (thread != null && thread.counterparty !== msg.sender) {
      throw new Error('Inbound sender is not the thread counterparty')
    }

    if (thread == null) {
      if (
        env.kind !== 'invoice' &&
        env.kind !== 'settlement' &&
        env.kind !== 'identityVerificationRequest'
      ) {
        throw new Error('Envelope kind cannot create a new remittance thread')
      }
    }

    switch (env.kind) {
      case 'invoice': {
        const invoice = env.payload as Invoice
        if (invoice.payee !== msg.sender || invoice.payer !== myIdentityKey) {
          throw new Error('Invoice parties do not match the authenticated transport parties')
        }
        if (thread?.invoice != null || (thread != null && thread.myRole !== 'taker')) {
          throw new Error('Invoice is not valid for the current thread state or role')
        }
        return
      }
      case 'identityVerificationRequest':
        return
      case 'identityVerificationResponse':
        if (
          thread?.identity.requestSent !== true ||
          thread.protocolLog.some(
            entry =>
              entry.direction === 'in' && entry.envelope.kind === 'identityVerificationResponse'
          )
        ) {
          throw new Error('Identity response does not answer a pending local request')
        }
        return
      case 'identityVerificationAcknowledgment':
        if (thread?.identity.responseSent !== true || thread.identity.acknowledgmentReceived) {
          throw new Error('Identity acknowledgment does not answer a pending local response')
        }
        return
      case 'settlement': {
        const settlement = env.payload as Settlement
        if (settlement.sender !== msg.sender) {
          throw new Error('Settlement sender does not match the authenticated transport sender')
        }
        if (thread?.settlement != null || (thread != null && thread.myRole !== 'maker')) {
          throw new Error('Settlement is not valid for the current thread state or role')
        }
        if (thread?.invoice != null) {
          if (
            thread.invoice.payee !== myIdentityKey ||
            thread.invoice.payer !== msg.sender ||
            settlement.moduleId !== settlement.optionId ||
            !Object.prototype.hasOwnProperty.call(thread.invoice.options, settlement.optionId)
          ) {
            throw new Error('Settlement is not bound to the invoice parties and option')
          }
        }
        return
      }
      case 'receipt': {
        const receipt = env.payload as Receipt
        if (
          thread == null ||
          thread.myRole !== 'taker' ||
          thread.settlement == null ||
          thread.receipt != null ||
          receipt.payee !== msg.sender ||
          receipt.payer !== myIdentityKey ||
          receipt.moduleId !== thread.settlement.moduleId ||
          receipt.optionId !== thread.settlement.optionId
        ) {
          throw new Error('Receipt is not bound to the authenticated settlement parties')
        }
        return
      }
      case 'termination':
        if (thread == null || thread.termination != null) {
          throw new Error('Termination is not valid for the current thread')
        }
        return
    }
  }

  async #applyIdentityVerificationRequest(
    thread: Thread,
    env: RemittanceEnvelope,
    msg: PeerMessage
  ): Promise<void> {
    const payload = env.payload as IdentityVerificationRequest
    if (typeof payload !== 'object') {
      throw new TypeError('Identity verification request payload missing data')
    }
    if (this.cfg.identityLayer == null) {
      await this.#sendTermination(
        thread,
        msg.sender,
        'Identity verification requested but no identity layer is configured'
      )
      return
    }
    this.#transitionThreadState(thread, 'identityRequested', 'identity request received')
    this.#emitEvent({
      type: 'identityRequested',
      threadId: thread.threadId,
      direction: 'in',
      request: payload
    })
    const response = await this.cfg.identityLayer.respondToRequest(
      {
        counterparty: msg.sender,
        threadId: thread.threadId,
        request: payload
      },
      this.#moduleContext()
    )
    if (response.action === 'terminate') {
      await this.#sendTermination(
        thread,
        msg.sender,
        response.termination.message,
        response.termination.details,
        response.termination.code
      )
      return
    }
    if (response.action !== 'respond') {
      throw new Error('Unknown identity response action')
    }
    const responseEnv = this.#makeEnvelope(
      'identityVerificationResponse',
      thread.threadId,
      response.response
    )
    const mid = await this.#sendEnvelope(msg.sender, responseEnv)
    thread.protocolLog.push({
      direction: 'out',
      envelope: responseEnv,
      transportMessageId: mid
    })
    thread.identity.certsSent = response.response.certificates
    thread.identity.responseSent = true
    this.#transitionThreadState(thread, 'identityResponded', 'identity response sent')
    this.#emitEvent({
      type: 'identityResponded',
      threadId: thread.threadId,
      direction: 'out',
      response: response.response
    })
  }

  private async applyIdentityVerificationResponse(
    thread: Thread,
    env: RemittanceEnvelope,
    msg: PeerMessage
  ): Promise<void> {
    const payload = env.payload as IdentityVerificationResponse
    if (typeof payload !== 'object') {
      throw new TypeError('Identity verification response payload missing data')
    }
    if (this.cfg.identityLayer == null) {
      await this.#sendTermination(
        thread,
        msg.sender,
        'Identity verification response received but no identity layer is configured'
      )
      return
    }
    thread.identity.certsReceived = payload.certificates
    this.#transitionThreadState(thread, 'identityResponded', 'identity response received')
    this.#emitEvent({
      type: 'identityResponded',
      threadId: thread.threadId,
      direction: 'in',
      response: payload
    })
    const decision = await this.cfg.identityLayer.assessReceivedCertificateSufficiency(
      msg.sender,
      payload,
      thread.threadId
    )
    if ('message' in decision) {
      await this.#sendTermination(
        thread,
        msg.sender,
        decision.message,
        decision.details,
        decision.code
      )
      return
    }
    if (decision.kind !== 'identityVerificationAcknowledgment') {
      throw new Error('Unknown identity verification decision')
    }
    const ackEnv = this.#makeEnvelope(
      'identityVerificationAcknowledgment',
      thread.threadId,
      decision
    )
    const mid = await this.#sendEnvelope(msg.sender, ackEnv)
    thread.protocolLog.push({
      direction: 'out',
      envelope: ackEnv,
      transportMessageId: mid
    })
    thread.identity.acknowledgmentSent = true
    thread.flags.hasIdentified = true
    this.#transitionThreadState(thread, 'identityAcknowledged', 'identity acknowledgment sent')
    this.#emitEvent({
      type: 'identityAcknowledged',
      threadId: thread.threadId,
      direction: 'out',
      acknowledgment: decision
    })
  }

  #applyIdentityVerificationAcknowledgment(thread: Thread, env: RemittanceEnvelope): void {
    const payload = env.payload as IdentityVerificationAcknowledgment
    if (typeof payload !== 'object') {
      throw new TypeError('Identity verification acknowledgment payload missing data')
    }
    thread.identity.acknowledgmentReceived = true
    thread.flags.hasIdentified = true
    this.#transitionThreadState(thread, 'identityAcknowledged', 'identity acknowledgment received')
    const event = {
      type: 'identityAcknowledged' as const,
      threadId: thread.threadId,
      direction: 'in' as const,
      acknowledgment: payload
    }
    this.#emitEvent(event)
  }

  #applyInvoice(thread: Thread, env: RemittanceEnvelope): void {
    const invoice = env.payload as Invoice
    if (typeof invoice !== 'object') {
      throw new TypeError('Invoice payload missing invoice data')
    }
    thread.invoice = invoice
    thread.flags.hasInvoiced = true
    this.#transitionThreadState(thread, 'invoiced', 'invoice received')
    this.#emitEvent({
      type: 'invoiceReceived',
      threadId: thread.threadId,
      invoice
    })
  }

  async #acceptInboundSettlement(
    thread: Thread,
    settlement: Settlement,
    msg: PeerMessage
  ): Promise<void> {
    const module = this.#moduleRegistry.get(settlement.moduleId)
    if (typeof module !== 'object') {
      await this.#maybeSendTermination(
        thread,
        settlement,
        msg.sender,
        `Unsupported module: ${settlement.moduleId}`
      )
      return
    }
    if (thread.invoice == null && !module.allowUnsolicitedSettlements) {
      await this.#maybeSendTermination(
        thread,
        settlement,
        msg.sender,
        'Unsolicited settlement not supported'
      )
      return
    }
    const result = await module
      .acceptSettlement(
        {
          threadId: thread.threadId,
          invoice: thread.invoice,
          settlement: settlement.artifact,
          sender: msg.sender
        },
        this.#moduleContext()
      )
      .catch(async error => {
        this.cfg.logger?.warn?.('[RemittanceManager] Settlement module failed', error)
        await this.#maybeSendTermination(
          thread,
          settlement,
          msg.sender,
          'Settlement processing failed safely.'
        )
        throw error
      })
    if (result.action === 'terminate') {
      await this.#maybeSendTermination(
        thread,
        settlement,
        msg.sender,
        result.termination.message,
        result.termination.details
      )
      return
    }
    if (result.action !== 'accept') {
      throw new Error('Unknown settlement acceptance action')
    }
    const receipt: Receipt = {
      kind: 'receipt',
      threadId: thread.threadId,
      moduleId: settlement.moduleId,
      optionId: settlement.optionId,
      payee: this.#requireMyIdentityKey('Receiving settlement requires identity key'),
      payer: msg.sender,
      createdAt: this.#now(),
      receiptData: result.receiptData
    }
    thread.receipt = receipt
    thread.flags.hasReceipted = true
    this.#transitionThreadState(thread, 'receipted', 'receipt issued')
    if (this.#runtime.receiptProvided && this.#runtime.autoIssueReceipt) {
      const receiptEnv = this.#makeEnvelope('receipt', thread.threadId, receipt)
      const mid = await this.#sendEnvelope(msg.sender, receiptEnv)
      thread.protocolLog.push({
        direction: 'out',
        envelope: receiptEnv,
        transportMessageId: mid
      })
      this.#emitEvent({
        type: 'receiptSent',
        threadId: thread.threadId,
        receipt
      })
    }
  }

  async #applySettlement(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void> {
    const settlement = env.payload as Settlement
    if (typeof settlement !== 'object') {
      throw new TypeError('Settlement payload missing settlement data')
    }
    if (
      this.#shouldRequireIdentityBeforeSettlement(thread) &&
      !thread.identity.acknowledgmentSent
    ) {
      await this.#sendTermination(
        thread,
        msg.sender,
        'Identity verification is required before settlement'
      )
      return
    }
    thread.settlement = settlement
    thread.flags.hasPaid = true
    this.#transitionThreadState(thread, 'settled', 'settlement received')
    this.#emitEvent({
      type: 'settlementReceived',
      threadId: thread.threadId,
      settlement
    })
    await this.#acceptInboundSettlement(thread, settlement, msg)
  }

  async #applyReceipt(thread: Thread, env: RemittanceEnvelope, msg: PeerMessage): Promise<void> {
    const receipt = env.payload as Receipt
    if (typeof receipt !== 'object') {
      throw new TypeError('Receipt payload missing receipt data')
    }
    thread.receipt = receipt
    thread.flags.hasReceipted = true
    this.#transitionThreadState(thread, 'receipted', 'receipt received')
    this.#emitEvent({
      type: 'receiptReceived',
      threadId: thread.threadId,
      receipt
    })
    const module = this.#moduleRegistry.get(receipt.moduleId)
    if (module?.processReceipt != null) {
      await module.processReceipt(
        {
          threadId: thread.threadId,
          invoice: thread.invoice,
          receiptData: receipt.receiptData,
          sender: msg.sender
        },
        this.#moduleContext()
      )
    }
  }

  async #applyTermination(
    thread: Thread,
    env: RemittanceEnvelope,
    msg: PeerMessage
  ): Promise<void> {
    const payload = env.payload as Termination
    if (typeof payload !== 'object') {
      throw new TypeError('Termination payload missing data')
    }
    thread.termination = payload
    thread.lastError = { message: payload.message, at: this.#now() }
    thread.flags.error = true
    this.#transitionThreadState(thread, 'terminated', 'termination received')
    this.#emitEvent({
      type: 'terminationReceived',
      threadId: thread.threadId,
      termination: payload
    })
    if (thread.settlement == null) return
    const module = this.#moduleRegistry.get(thread.settlement.moduleId)
    if (module?.processTermination != null) {
      await module.processTermination(
        {
          threadId: thread.threadId,
          invoice: thread.invoice,
          settlement: thread.settlement,
          termination: payload,
          sender: msg.sender
        },
        this.#moduleContext()
      )
    }
  }

  async #applyInboundEnvelope(
    thread: Thread,
    env: RemittanceEnvelope,
    msg: PeerMessage
  ): Promise<void> {
    thread.protocolLog.push({ direction: 'in', envelope: env, transportMessageId: msg.messageId })
    this.#emitEvent({
      type: 'envelopeReceived',
      threadId: thread.threadId,
      envelope: env,
      transportMessageId: msg.messageId
    })

    switch (env.kind) {
      case 'identityVerificationRequest': {
        await this.#applyIdentityVerificationRequest(thread, env, msg)
        return
      }

      case 'identityVerificationResponse': {
        await this.applyIdentityVerificationResponse(thread, env, msg)
        return
      }

      case 'identityVerificationAcknowledgment': {
        this.#applyIdentityVerificationAcknowledgment(thread, env)
        return
      }

      case 'invoice': {
        this.#applyInvoice(thread, env)
        return
      }

      case 'settlement': {
        await this.#applySettlement(thread, env, msg)
        return
      }
      case 'receipt': {
        await this.#applyReceipt(thread, env, msg)
        return
      }

      case 'termination': {
        await this.#applyTermination(thread, env, msg)
        return
      }

      default: {
        const kind = (env as { kind?: unknown }).kind
        throw new Error(`Unknown envelope kind: ${toSafeString(kind)}`)
      }
    }
  }

  async #maybeSendTermination(
    thread: Thread,
    settlement: Settlement,
    payer: PubKeyHex,
    message: string,
    details?: any
  ): Promise<void> {
    const t: Termination = {
      code: 'error',
      message,
      details
    }

    const env = this.#makeEnvelope('termination', thread.threadId, t)
    const mid = await this.#sendEnvelope(payer, env)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'terminationSent', threadId: thread.threadId, termination: t })

    thread.termination = t
    thread.lastError = {
      message: `Sent termination: ${message}`,
      at: this.#now()
    }
    thread.flags.error = true
    this.#transitionThreadState(thread, 'terminated', 'termination sent')
  }

  async #sendTermination(
    thread: Thread,
    recipient: PubKeyHex,
    message: string,
    details?: unknown,
    code = 'error'
  ): Promise<void> {
    const t: Termination = { code, message, details }
    const env = this.#makeEnvelope('termination', thread.threadId, t)
    const mid = await this.#sendEnvelope(recipient, env)
    thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
    this.#emitEvent({ type: 'terminationSent', threadId: thread.threadId, termination: t })
    thread.termination = t
    thread.lastError = { message: `Sent termination: ${message}`, at: this.#now() }
    thread.flags.error = true
    this.#transitionThreadState(thread, 'terminated', 'termination sent')
  }

  #shouldRequestIdentity(thread: Thread, phase: 'beforeInvoicing' | 'beforeSettlement'): boolean {
    const { makerRequestIdentity = 'never', takerRequestIdentity = 'never' } =
      this.#runtime.identityOptions ?? {}
    const requiresIdentity =
      thread.myRole === 'maker' ? makerRequestIdentity === phase : takerRequestIdentity === phase
    if (!requiresIdentity) return false
    if (this.cfg.identityLayer == null) {
      throw new Error('Identity layer is required by runtime options but is not configured')
    }
    return true
  }

  #shouldRequireIdentityBeforeSettlement(thread: Thread): boolean {
    if (thread.myRole !== 'maker') return false
    return (this.#runtime.identityOptions?.makerRequestIdentity ?? 'never') === 'beforeSettlement'
  }

  async #ensureIdentityExchange(thread: Thread, hostOverride?: string): Promise<void> {
    if (this.cfg.identityLayer == null) return
    if (thread.identity.acknowledgmentSent) return

    if (!thread.identity.requestSent) {
      const request = await this.cfg.identityLayer.determineCertificatesToRequest(
        { counterparty: thread.counterparty, threadId: thread.threadId },
        this.#moduleContext()
      )
      const env = this.#makeEnvelope('identityVerificationRequest', thread.threadId, request)
      const mid = await this.#sendEnvelope(thread.counterparty, env, hostOverride)
      thread.protocolLog.push({ direction: 'out', envelope: env, transportMessageId: mid })
      thread.identity.requestSent = true
      this.#transitionThreadState(thread, 'identityRequested', 'identity request sent')
      this.#emitEvent({
        type: 'identityRequested',
        threadId: thread.threadId,
        direction: 'out',
        request
      })
      thread.updatedAt = this.#now()
      await this.persistState()
    }

    await this.#waitForIdentityAcknowledgment(thread.threadId, 'sent', {
      timeoutMs: this.#runtime.identityTimeoutMs,
      pollIntervalMs: this.#runtime.identityPollIntervalMs
    })
  }

  async #waitForIdentityAcknowledgment(
    threadId: ThreadId,
    direction: 'sent' | 'received',
    opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<void> {
    const { timeoutMs, pollIntervalMs } = waitDurations(opts)
    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const thread = this.getThreadOrThrow(threadId)
      const acknowledged =
        direction === 'sent'
          ? thread.identity.acknowledgmentSent
          : thread.identity.acknowledgmentReceived
      if (acknowledged) return
      if (thread.state === 'terminated' || thread.state === 'errored') {
        throw new Error(`Thread entered terminal state: ${thread.state}`)
      }
      await this.syncThreads()
      await sleep(pollIntervalMs)
    }
    throw new Error(`Timed out waiting for identity acknowledgment ${direction}`)
  }

  async #safeAck(messageIds: string[]): Promise<void> {
    try {
      await this.comms.acknowledgeMessage({ messageIds })
    } catch (e) {
      this.cfg.logger?.warn?.('[RemittanceManager] Failed to acknowledge message(s)', e)
    }
  }

  #markThreadError(thread: Thread, e: any): void {
    thread.flags.error = true
    this.#transitionThreadState(thread, 'errored', 'thread error')
    thread.lastError = { message: String(e?.message ?? e), at: this.#now() }
    this.cfg.logger?.error?.('[RemittanceManager] Thread error', thread.threadId, e)
    this.#emitEvent({ type: 'error', threadId: thread.threadId, error: String(e?.message ?? e) })
  }

  #ensureThreadState(thread: Thread): Thread {
    thread.identity = thread.identity ?? {
      certsSent: [],
      certsReceived: [],
      requestSent: false,
      responseSent: false,
      acknowledgmentSent: false,
      acknowledgmentReceived: false
    }
    thread.identity.certsSent ??= []
    thread.identity.certsReceived ??= []
    thread.identity.requestSent ??= false
    thread.identity.responseSent ??= false
    thread.identity.acknowledgmentSent ??= false
    thread.identity.acknowledgmentReceived ??= false

    thread.flags = thread.flags ?? {
      hasIdentified: false,
      hasInvoiced: false,
      hasPaid: false,
      hasReceipted: false,
      error: false
    }
    thread.processedMessageIds ??= []
    thread.protocolLog ??= []
    thread.stateLog ??= []

    thread.state ??= this.#deriveThreadState(thread)
    return thread
  }

  #validateThreadStateArray(value: unknown, shouldCopy = true): Thread[] {
    const snapshot = shouldCopy ? copyRemittanceData(value) : value
    if (!Array.isArray(snapshot) || snapshot.length > MAX_REMITTANCE_THREADS) {
      throw new TypeError('Remittance threads must be a bounded array')
    }
    const threads: Thread[] = []
    const threadIds = new Set<string>()
    for (let index = 0; index < snapshot.length; index++) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, index)) {
        throw new TypeError('Remittance threads must be a dense array')
      }
      const candidate = plainStateRecord(snapshot[index], `Remittance thread ${index}`)
      const threadId = boundedStateString(candidate.threadId, `Thread ${index} id`)
      if (threadIds.has(threadId)) throw new Error('Remittance thread IDs must be unique')
      threadIds.add(threadId)
      const counterparty = boundedStateString(
        candidate.counterparty,
        `Thread ${index} counterparty`
      )
      if (
        (candidate.myRole !== 'maker' && candidate.myRole !== 'taker') ||
        (candidate.theirRole !== 'maker' && candidate.theirRole !== 'taker') ||
        candidate.myRole === candidate.theirRole
      ) {
        throw new TypeError(`Thread ${index} roles are invalid`)
      }
      const createdAt = safeStateTimestamp(candidate.createdAt, `Thread ${index} createdAt`)
      const updatedAt = safeStateTimestamp(candidate.updatedAt, `Thread ${index} updatedAt`)
      if (updatedAt < createdAt) {
        throw new TypeError(`Thread ${index} updatedAt precedes createdAt`)
      }
      if (!remittanceStates.has(candidate.state as RemittanceThreadState)) {
        throw new TypeError(`Thread ${index} state is invalid`)
      }

      const thread = this.#ensureThreadState({
        ...(candidate as unknown as Thread),
        threadId,
        counterparty,
        createdAt,
        updatedAt
      })
      thread.identity = plainStateRecord(
        thread.identity,
        `Thread ${index} identity state`
      ) as unknown as Thread['identity']
      thread.identity.certsSent = boundedStateArray(
        thread.identity.certsSent,
        `Thread ${index} sent certificates`
      ) as Thread['identity']['certsSent']
      thread.identity.certsReceived = boundedStateArray(
        thread.identity.certsReceived,
        `Thread ${index} received certificates`
      ) as Thread['identity']['certsReceived']
      thread.identity.requestSent = thread.identity.requestSent === true
      thread.identity.responseSent = thread.identity.responseSent === true
      thread.identity.acknowledgmentSent = thread.identity.acknowledgmentSent === true
      thread.identity.acknowledgmentReceived = thread.identity.acknowledgmentReceived === true

      thread.processedMessageIds = boundedStateArray(
        thread.processedMessageIds,
        `Thread ${index} processed message IDs`
      ).map((id, messageIndex) =>
        boundedStateString(id, `Thread ${index} processed message ${messageIndex}`)
      )
      if (new Set(thread.processedMessageIds).size !== thread.processedMessageIds.length) {
        throw new Error(`Thread ${index} contains duplicate processed message IDs`)
      }
      thread.protocolLog = boundedStateArray(
        thread.protocolLog,
        `Thread ${index} protocol log`
      ).map((entry, logIndex) => {
        const log = plainStateRecord(entry, `Thread ${index} protocol log ${logIndex}`)
        if (log.direction !== 'in' && log.direction !== 'out') {
          throw new TypeError(`Thread ${index} protocol log direction is invalid`)
        }
        const transportMessageId = boundedStateString(
          log.transportMessageId,
          `Thread ${index} protocol transport message id`
        )
        const envelope = parseRemittanceEnvelope(stringifyBRC100(log.envelope))
        if (envelope == null || envelope.threadId !== threadId) {
          throw new TypeError(`Thread ${index} protocol log envelope is invalid`)
        }
        return { direction: log.direction, envelope, transportMessageId }
      })
      const incomingTransportIds = new Set(
        thread.protocolLog
          .filter(entry => entry.direction === 'in')
          .map(entry => entry.transportMessageId)
      )
      if (thread.processedMessageIds.some(id => !incomingTransportIds.has(id))) {
        throw new Error(`Thread ${index} processed message has no inbound protocol evidence`)
      }

      const sentResponse = [...thread.protocolLog]
        .reverse()
        .find(
          entry =>
            entry.direction === 'out' && entry.envelope.kind === 'identityVerificationResponse'
        )
      const receivedResponse = [...thread.protocolLog]
        .reverse()
        .find(
          entry =>
            entry.direction === 'in' && entry.envelope.kind === 'identityVerificationResponse'
        )
      thread.identity = {
        certsSent:
          sentResponse == null
            ? []
            : (sentResponse.envelope.payload as IdentityVerificationResponse).certificates,
        certsReceived:
          receivedResponse == null
            ? []
            : (receivedResponse.envelope.payload as IdentityVerificationResponse).certificates,
        requestSent: thread.protocolLog.some(
          entry =>
            entry.direction === 'out' && entry.envelope.kind === 'identityVerificationRequest'
        ),
        responseSent: sentResponse != null,
        acknowledgmentSent: thread.protocolLog.some(
          entry =>
            entry.direction === 'out' &&
            entry.envelope.kind === 'identityVerificationAcknowledgment'
        ),
        acknowledgmentReceived: thread.protocolLog.some(
          entry =>
            entry.direction === 'in' && entry.envelope.kind === 'identityVerificationAcknowledgment'
        )
      }

      thread.invoice =
        candidate.invoice === undefined
          ? undefined
          : (validateRemittancePayload('invoice', threadId, candidate.invoice) as Invoice)
      thread.settlement =
        candidate.settlement === undefined
          ? undefined
          : (validateRemittancePayload('settlement', threadId, candidate.settlement) as Settlement)
      thread.receipt =
        candidate.receipt === undefined
          ? undefined
          : (validateRemittancePayload('receipt', threadId, candidate.receipt) as Receipt)
      thread.termination =
        candidate.termination === undefined
          ? undefined
          : (validateRemittancePayload(
              'termination',
              threadId,
              candidate.termination
            ) as Termination)
      if (candidate.lastError !== undefined) {
        const lastError = plainStateRecord(candidate.lastError, `Thread ${index} last error`)
        thread.lastError = {
          message:
            optionalProtocolText(
              lastError.message,
              `Thread ${index} last error message`,
              64 * 1024
            ) ?? '',
          at: safeStateTimestamp(lastError.at, `Thread ${index} last error timestamp`)
        }
      } else {
        thread.lastError = undefined
      }
      thread.stateLog = boundedStateArray(thread.stateLog, `Thread ${index} state log`).map(
        (entry, logIndex) => {
          const log = plainStateRecord(entry, `Thread ${index} state log ${logIndex}`)
          const from = log.from as RemittanceThreadState
          const to = log.to as RemittanceThreadState
          if (!remittanceStates.has(from) || !remittanceStates.has(to)) {
            throw new TypeError(`Thread ${index} state log transition is invalid`)
          }
          return {
            at: safeStateTimestamp(log.at, `Thread ${index} state log timestamp`),
            from,
            to,
            reason: optionalProtocolText(
              log.reason,
              `Thread ${index} state log reason`,
              MAX_REMITTANCE_IDENTIFIER_LENGTH
            )
          }
        }
      )

      thread.flags = plainStateRecord(
        thread.flags,
        `Thread ${index} flags`
      ) as unknown as Thread['flags']
      thread.flags.hasIdentified =
        thread.identity.acknowledgmentSent || thread.identity.acknowledgmentReceived
      thread.flags.hasInvoiced = thread.invoice != null
      thread.flags.hasPaid = thread.settlement != null
      thread.flags.hasReceipted = thread.receipt != null
      thread.flags.error = thread.flags.error === true || thread.termination != null
      thread.state = this.#deriveThreadState(thread)
      threads.push(thread)
    }
    return threads
  }

  #validateStoredThreadParties(): void {
    const myIdentityKey = this.#requireMyIdentityKey(
      'Validating remittance state requires an identity key'
    )
    for (const thread of this.threads) {
      const expectedMaker = thread.myRole === 'maker' ? myIdentityKey : thread.counterparty
      const expectedTaker = thread.myRole === 'taker' ? myIdentityKey : thread.counterparty
      if (
        thread.invoice != null &&
        (thread.invoice.payee !== expectedMaker || thread.invoice.payer !== expectedTaker)
      ) {
        throw new Error('Persisted invoice parties do not match their remittance thread')
      }
      if (thread.settlement != null && thread.settlement.sender !== expectedTaker) {
        throw new Error('Persisted settlement sender does not match its remittance thread')
      }
      if (
        thread.receipt != null &&
        (thread.receipt.payee !== expectedMaker || thread.receipt.payer !== expectedTaker)
      ) {
        throw new Error('Persisted receipt parties do not match their remittance thread')
      }
    }
  }

  #deriveThreadState(thread: Thread): RemittanceThreadState {
    if (thread.flags.error) return 'errored'
    if (thread.termination != null) return 'terminated'
    if (thread.receipt != null) return 'receipted'
    if (thread.settlement != null) return 'settled'
    if (thread.invoice != null) return 'invoiced'
    if (
      thread.identity.acknowledgmentReceived ||
      thread.identity.acknowledgmentSent ||
      thread.flags.hasIdentified
    ) {
      return 'identityAcknowledged'
    }
    if (thread.identity.responseSent || thread.identity.certsSent.length > 0)
      return 'identityResponded'
    if (thread.identity.requestSent || thread.identity.certsReceived.length > 0)
      return 'identityRequested'
    return 'new'
  }

  #transitionThreadState(thread: Thread, next: RemittanceThreadState, reason?: string): void {
    const current = thread.state
    if (current === next) return
    const allowed = REMITTANCE_STATE_TRANSITIONS[current] ?? []
    if (!allowed.includes(next)) {
      throw new Error(`Invalid remittance state transition: ${current} -> ${next}`)
    }

    thread.state = next
    thread.updatedAt = this.#now()
    thread.stateLog.push({ at: this.#now(), from: current, to: next, reason })
    this.#emitEvent({
      type: 'stateChanged',
      threadId: thread.threadId,
      previous: current,
      next,
      reason
    })
    this.#resolveStateWaiters(thread.threadId, next)
    if (next === 'terminated' || next === 'errored') {
      this.#rejectStateWaiters(thread.threadId, new Error(`Thread entered terminal state: ${next}`))
    }
  }

  #resolveStateWaiters(threadId: ThreadId, state: RemittanceThreadState): void {
    const waiters = this.#stateWaiters.get(threadId)
    if (waiters == null) return

    const remaining: Array<{
      state: RemittanceThreadState
      resolve: () => void
      reject: (err: Error) => void
    }> = []
    for (const waiter of waiters) {
      if (waiter.state === state) {
        waiter.resolve()
      } else {
        remaining.push(waiter)
      }
    }
    if (remaining.length === 0) {
      this.#stateWaiters.delete(threadId)
    } else {
      this.#stateWaiters.set(threadId, remaining)
    }
  }

  #rejectStateWaiters(threadId: ThreadId, err: Error): void {
    const waiters = this.#stateWaiters.get(threadId)
    if (waiters == null) return
    for (const waiter of waiters) {
      waiter.reject(err)
    }
    this.#stateWaiters.delete(threadId)
  }

  #emitEvent(event: RemittanceEvent): void {
    const handlers = this.#eventHandlers
    if (handlers != null) {
      try {
        switch (event.type) {
          case 'threadCreated':
            handlers.onThreadCreated?.(event)
            break
          case 'stateChanged':
            handlers.onStateChanged?.(event)
            break
          case 'envelopeSent':
            handlers.onEnvelopeSent?.(event)
            break
          case 'envelopeReceived':
            handlers.onEnvelopeReceived?.(event)
            break
          case 'identityRequested':
            handlers.onIdentityRequested?.(event)
            break
          case 'identityResponded':
            handlers.onIdentityResponded?.(event)
            break
          case 'identityAcknowledged':
            handlers.onIdentityAcknowledged?.(event)
            break
          case 'invoiceSent':
            handlers.onInvoiceSent?.(event)
            break
          case 'invoiceReceived':
            handlers.onInvoiceReceived?.(event)
            break
          case 'settlementSent':
            handlers.onSettlementSent?.(event)
            break
          case 'settlementReceived':
            handlers.onSettlementReceived?.(event)
            break
          case 'receiptSent':
            handlers.onReceiptSent?.(event)
            break
          case 'receiptReceived':
            handlers.onReceiptReceived?.(event)
            break
          case 'terminationSent':
            handlers.onTerminationSent?.(event)
            break
          case 'terminationReceived':
            handlers.onTerminationReceived?.(event)
            break
          case 'error':
            handlers.onError?.(event)
            break
        }
      } catch (e) {
        this.cfg.logger?.warn?.('[RemittanceManager] Event handler error', e)
      }
    }
    for (const listener of this.#eventListeners) {
      try {
        listener(event)
      } catch (e) {
        this.cfg.logger?.warn?.('[RemittanceManager] Event listener error', e)
      }
    }
  }

  async #refreshMyIdentityKey(): Promise<void> {
    if (typeof this.#myIdentityKey === 'string') return
    if (typeof this.wallet !== 'object') return

    const { publicKey: k } = await this.wallet.getPublicKey(
      { identityKey: true },
      this.cfg.originator
    )
    if (typeof k === 'string' && k.trim() !== '') {
      this.#myIdentityKey = k
      this.#validateStoredThreadParties()
    }
  }

  #requireMyIdentityKey(errMsg: string): PubKeyHex {
    if (typeof this.#myIdentityKey !== 'string') {
      throw new TypeError(errMsg)
    }
    return this.#myIdentityKey
  }

  async #composeInvoice(
    threadId: ThreadId,
    payee: PubKeyHex,
    payer: PubKeyHex,
    input: ComposeInvoiceInput
  ): Promise<Invoice> {
    input = validateComposeInvoiceInput(input)
    const createdAt = this.#now()
    const expiresAt =
      this.#runtime.invoiceExpirySeconds >= 0
        ? createdAt + this.#runtime.invoiceExpirySeconds * 1000
        : undefined

    return {
      kind: 'invoice',
      threadId,
      payee,
      payer,
      note: input.note,
      lineItems: input.lineItems,
      total: input.total,
      invoiceNumber: input.invoiceNumber ?? threadId,
      createdAt,
      expiresAt,
      arbitrary: input.arbitrary,
      options: {}
    }
  }
}

/**
 * A lightweight wrapper around a thread's invoice, with convenience methods.
 */
export class ThreadHandle {
  constructor(
    protected readonly manager: RemittanceManager,
    public readonly threadId: ThreadId
  ) {}

  get thread(): Thread {
    return this.manager.getThreadOrThrow(this.threadId)
  }

  async waitForState(
    state: RemittanceThreadState,
    opts?: { timeoutMs?: number; pollIntervalMs?: number }
  ): Promise<Thread> {
    return await this.manager.waitForState(this.threadId, state, opts)
  }

  async waitForIdentity(opts?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<Thread> {
    return await this.manager.waitForIdentity(this.threadId, opts)
  }

  async waitForSettlement(opts?: {
    timeoutMs?: number
    pollIntervalMs?: number
  }): Promise<Settlement | Termination> {
    return await this.manager.waitForSettlement(this.threadId, opts)
  }

  async waitForReceipt(opts?: {
    timeoutMs?: number
    pollIntervalMs?: number
  }): Promise<Receipt | Termination> {
    return await this.manager.waitForReceipt(this.threadId, opts)
  }
}

export class InvoiceHandle extends ThreadHandle {
  get invoice(): Invoice {
    const inv = this.thread.invoice
    if (typeof inv !== 'object') throw new Error('Thread has no invoice')
    return inv
  }

  /**
   * Pays the invoice using the selected remittance option.
   */
  async pay(optionId?: string): Promise<Receipt | Termination | undefined> {
    return await this.manager.pay(this.threadId, optionId)
  }
}

function optionalProtocolText(
  value: unknown,
  label: string,
  maxLength: number
): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new TypeError(`${label} must be a bounded string`)
  }
  return value
}

function validateAmount(value: unknown, label: string): Invoice['total'] {
  const amount = plainStateRecord(value, label)
  const unit = plainStateRecord(amount.unit, `${label} unit`)
  const decimals = unit.decimals
  if (
    decimals !== undefined &&
    (typeof decimals !== 'number' ||
      !Number.isSafeInteger(decimals) ||
      decimals < 0 ||
      decimals > 255)
  ) {
    throw new TypeError(`${label} unit decimals must be a uint8`)
  }
  return {
    value: decimalString(amount.value, `${label} value`),
    unit: {
      namespace: boundedStateString(unit.namespace, `${label} unit namespace`),
      code: boundedStateString(unit.code, `${label} unit code`),
      decimals: decimals as number | undefined
    }
  }
}

function validateComposeInvoiceInput(value: ComposeInvoiceInput): ComposeInvoiceInput {
  const input = plainStateRecord(copyRemittanceData(value), 'Invoice input')
  const lineItems = boundedStateArray(input.lineItems, 'Invoice line items').map((item, index) => {
    const source = plainStateRecord(item, `Invoice line item ${index}`)
    return {
      ...source,
      id: optionalProtocolText(source.id, `Invoice line item ${index} id`, 4096),
      description: boundedStateString(source.description, `Invoice line item ${index} description`),
      quantity:
        source.quantity === undefined
          ? undefined
          : decimalString(source.quantity, `Invoice line item ${index} quantity`),
      unitPrice:
        source.unitPrice === undefined
          ? undefined
          : validateAmount(source.unitPrice, `Invoice line item ${index} unit price`),
      amount:
        source.amount === undefined
          ? undefined
          : validateAmount(source.amount, `Invoice line item ${index} amount`)
    }
  }) as Invoice['lineItems']
  if (lineItems.length > MAX_THREAD_RECORDS) {
    throw new TypeError('Invoice contains too many line items')
  }
  const arbitrary =
    input.arbitrary === undefined
      ? undefined
      : plainStateRecord(input.arbitrary, 'Invoice arbitrary data')
  return {
    note: optionalProtocolText(input.note, 'Invoice note', 64 * 1024),
    lineItems,
    total: validateAmount(input.total, 'Invoice total'),
    invoiceNumber:
      input.invoiceNumber === undefined
        ? undefined
        : boundedStateString(input.invoiceNumber, 'Invoice number'),
    arbitrary
  }
}

function validateRemittanceModules(value: unknown): Array<RemittanceModule<any, any, any>> {
  if (!Array.isArray(value) || value.length > MAX_REMITTANCE_MODULES) {
    throw new TypeError('remittanceModules must be a bounded array')
  }
  const modules: Array<RemittanceModule<any, any, any>> = []
  const moduleIds = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new TypeError('remittanceModules must be a dense array')
    }
    const module = value[index] as RemittanceModule<any, any, any>
    if (module == null || typeof module !== 'object') {
      throw new TypeError(`Remittance module ${index} must be an object`)
    }
    const id = boundedStateString(module.id, `Remittance module ${index} id`)
    if (moduleIds.has(id)) throw new Error('Remittance module IDs must be unique')
    if (
      typeof module.buildSettlement !== 'function' ||
      typeof module.acceptSettlement !== 'function' ||
      typeof module.allowUnsolicitedSettlements !== 'boolean'
    ) {
      throw new TypeError(`Remittance module ${id} does not implement the required contract`)
    }
    moduleIds.add(id)
    modules.push(module)
  }
  return modules
}

function validateIdentityOptions(
  value: RemittanceManagerRuntimeOptions['identityOptions'] | undefined
): NonNullable<RemittanceManagerRuntimeOptions['identityOptions']> {
  const allowed = new Set(['never', 'beforeInvoicing', 'beforeSettlement'])
  const makerRequestIdentity = value?.makerRequestIdentity ?? 'never'
  const takerRequestIdentity = value?.takerRequestIdentity ?? 'never'
  if (!allowed.has(makerRequestIdentity) || !allowed.has(takerRequestIdentity)) {
    throw new TypeError('Remittance identity request phases are invalid')
  }
  return { makerRequestIdentity, takerRequestIdentity }
}

function booleanOption(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function duration(value: unknown, label: string, allowZero = true): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1) ||
    value > 86_400_000
  ) {
    throw new TypeError(`${label} must be a bounded non-negative millisecond duration`)
  }
  return value
}

function invoiceExpiry(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < -1 ||
    value > 31_536_000
  ) {
    throw new TypeError('invoiceExpirySeconds must be -1 or a bounded second duration')
  }
  return value
}

function waitDurations(opts: { timeoutMs?: number; pollIntervalMs?: number }): {
  timeoutMs: number
  pollIntervalMs: number
} {
  return {
    timeoutMs: duration(opts.timeoutMs ?? 30_000, 'timeoutMs'),
    pollIntervalMs: duration(opts.pollIntervalMs ?? 500, 'pollIntervalMs', false)
  }
}

function defaultThreadIdFactory(): ThreadId {
  return toBase64(Random(32))
}

async function sleep(ms: number): Promise<void> {
  return await new Promise(resolve => setTimeout(resolve, ms))
}
