import type { CommsLayer } from '../CommsLayer.js'
import type { IdentityLayer } from '../IdentityLayer.js'
import { RemittanceManager, type ComposeInvoiceInput, type Thread } from '../RemittanceManager.js'
import type { RemittanceModule } from '../RemittanceModule.js'
import type {
  Invoice,
  PeerMessage,
  Receipt,
  RemittanceEnvelope,
  Settlement,
  ThreadId
} from '../types.js'
import type { PubKeyHex, WalletInterface } from '../../wallet/Wallet.interfaces.js'

const LOCAL = 'local-identity' as PubKeyHex
const COUNTERPARTY = 'counterparty-identity' as PubKeyHex
const ATTACKER = 'attacker-identity' as PubKeyHex

const wallet = {
  getPublicKey: jest.fn(async () => ({ publicKey: LOCAL }))
} as unknown as WalletInterface

class BoundaryComms implements CommsLayer {
  readonly pending: PeerMessage[] = []
  readonly sent: Array<{ recipient: PubKeyHex; messageBox: string; body: string }> = []
  liveHandler?: (message: PeerMessage) => void
  private nextId = 1

  enqueue(sender: PubKeyHex, envelope: RemittanceEnvelope): void {
    this.pending.push({
      messageId: `incoming-${this.nextId++}`,
      sender,
      recipient: LOCAL,
      messageBox: 'remittance_inbox',
      body: JSON.stringify(envelope)
    })
  }

  async sendMessage(args: {
    recipient: PubKeyHex
    messageBox: string
    body: string
  }): Promise<string> {
    this.sent.push(args)
    return `outgoing-${this.nextId++}`
  }

  async listMessages(): Promise<PeerMessage[]> {
    return [...this.pending]
  }

  async acknowledgeMessage(args: { messageIds: string[] }): Promise<void> {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (args.messageIds.includes(this.pending[index].messageId)) this.pending.splice(index, 1)
    }
  }

  async listenForLiveMessages(args: {
    messageBox: string
    overrideHost?: string
    onMessage: (message: PeerMessage) => void
  }): Promise<void> {
    this.liveHandler = args.onMessage
  }
}

function makeIdFactory(prefix = 'generated'): () => ThreadId {
  let next = 0
  return () => `${prefix}-${++next}` as ThreadId
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    threadId: 'thread-1' as ThreadId,
    counterparty: COUNTERPARTY,
    myRole: 'maker',
    theirRole: 'taker',
    createdAt: 1,
    updatedAt: 1,
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
    },
    ...overrides
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    kind: 'invoice',
    threadId: 'thread-1' as ThreadId,
    payee: LOCAL,
    payer: COUNTERPARTY,
    lineItems: [],
    total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
    invoiceNumber: 'invoice-1',
    createdAt: 1,
    options: { 'module-1': {} },
    ...overrides
  }
}

function makeSettlement(overrides: Partial<Settlement> = {}): Settlement {
  return {
    kind: 'settlement',
    threadId: 'thread-1' as ThreadId,
    moduleId: 'module-1',
    optionId: 'module-1',
    sender: COUNTERPARTY,
    createdAt: 2,
    artifact: {},
    ...overrides
  }
}

function envelope(
  kind: RemittanceEnvelope['kind'],
  payload: unknown,
  id = `envelope-${kind}`
): RemittanceEnvelope {
  return {
    v: 1,
    id,
    kind,
    threadId: 'thread-1' as ThreadId,
    createdAt: 2,
    payload
  }
}

function makeModule(
  overrides: Partial<RemittanceModule<any, any, any>> = {}
): RemittanceModule<any, any, any> {
  return {
    id: 'module-1',
    name: 'Module',
    allowUnsolicitedSettlements: false,
    createOption: async () => ({}),
    buildSettlement: async () => ({ action: 'settle', artifact: {} }),
    acceptSettlement: async () => ({ action: 'accept', receiptData: {} }),
    ...overrides
  }
}

function identityResponseLog(): Thread['protocolLog'][number] {
  return {
    direction: 'out',
    transportMessageId: 'identity-response-message',
    envelope: envelope(
      'identityVerificationResponse',
      {
        kind: 'identityVerificationResponse',
        threadId: 'thread-1',
        certificates: []
      },
      'identity-response-envelope'
    )
  }
}

describe('RemittanceManager trust-boundary coverage', () => {
  beforeEach(() => jest.clearAllMocks())

  it('validates newly loaded financial parties after the wallet identity is known', async () => {
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, new BoundaryComms())
    await manager.syncThreads()

    expect(() =>
      manager.loadState({
        v: 1,
        threads: [
          makeThread({
            invoice: makeInvoice({ payee: ATTACKER }),
            state: 'invoiced'
          })
        ]
      })
    ).toThrow('Persisted invoice parties')
  })

  it.each([
    ['a non-array thread collection', {}],
    ['more than 10,000 threads', Array(10_001).fill(makeThread())]
  ])('rejects %s before hydrating persisted state', (_name, threads) => {
    expect(
      () =>
        new RemittanceManager(
          { remittanceModules: [] },
          wallet,
          new BoundaryComms(),
          threads as Thread[]
        )
    ).toThrow('Remittance threads must be a bounded array')
  })

  it('times out while waiting for a peer to acknowledge an identity response', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        options: { identityTimeoutMs: 2, identityPollIntervalMs: 1 }
      },
      wallet,
      new BoundaryComms(),
      [makeThread({ state: 'identityResponded', protocolLog: [identityResponseLog()] })]
    )

    await expect(
      manager.sendInvoiceForThread('thread-1', {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).rejects.toThrow('Timed out waiting for identity acknowledgment received')
  })

  it('also blocks payment while the peer identity acknowledgment is pending', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [makeModule()],
        options: { identityTimeoutMs: 2, identityPollIntervalMs: 1, receiptProvided: false }
      },
      wallet,
      new BoundaryComms(),
      [
        makeThread({
          myRole: 'taker',
          theirRole: 'maker',
          state: 'invoiced',
          protocolLog: [identityResponseLog()],
          invoice: makeInvoice({ payee: COUNTERPARTY, payer: LOCAL })
        })
      ]
    )

    await expect(manager.pay('thread-1')).rejects.toThrow(
      'Timed out waiting for identity acknowledgment received'
    )
  })

  it('requires an identity layer for existing-thread invoicing policy', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        options: { identityOptions: { makerRequestIdentity: 'beforeInvoicing' } }
      },
      wallet,
      new BoundaryComms(),
      [makeThread()]
    )

    await expect(
      manager.sendInvoiceForThread('thread-1', {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).rejects.toThrow('Identity layer is required')
  })

  it('requires an identity layer before an unsolicited taker settlement when configured', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [makeModule({ allowUnsolicitedSettlements: true })],
        options: { identityOptions: { takerRequestIdentity: 'beforeSettlement' } },
        threadIdFactory: makeIdFactory()
      },
      wallet,
      new BoundaryComms()
    )

    await expect(
      manager.sendUnsolicitedSettlement(COUNTERPARTY, { moduleId: 'module-1', option: {} })
    ).rejects.toThrow('Identity layer is required')
  })

  it('rejects a non-discriminated unsolicited settlement result', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [
          makeModule({
            allowUnsolicitedSettlements: true,
            buildSettlement: async () => ({ action: 'unknown' }) as never
          })
        ],
        threadIdFactory: makeIdFactory()
      },
      wallet,
      new BoundaryComms()
    )

    await expect(
      manager.sendUnsolicitedSettlement(COUNTERPARTY, { moduleId: 'module-1', option: {} })
    ).rejects.toThrow('Unknown settlement build action')
  })

  it('rejects reuse of a persisted outbound envelope ID before transport', async () => {
    const comms = new BoundaryComms()
    const priorEnvelope = envelope(
      'identityVerificationAcknowledgment',
      { kind: 'identityVerificationAcknowledgment', threadId: 'thread-1' },
      'duplicate-envelope'
    )
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        threadIdFactory: () => 'duplicate-envelope' as ThreadId
      },
      wallet,
      comms,
      [
        makeThread({
          state: 'identityAcknowledged',
          protocolLog: [
            {
              direction: 'out',
              transportMessageId: 'previous-message',
              envelope: priorEnvelope
            }
          ]
        })
      ]
    )

    await expect(
      manager.sendInvoiceForThread('thread-1', {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).rejects.toThrow('Generated remittance envelope ID is not unique')
    expect(comms.sent).toHaveLength(0)
  })

  it('preserves optional invoice omissions and the no-expiry policy', async () => {
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        options: { invoiceExpirySeconds: -1 },
        threadIdFactory: makeIdFactory('invoice')
      },
      wallet,
      new BoundaryComms()
    )

    const handle = await manager.sendInvoice(COUNTERPARTY, {
      lineItems: [{ description: 'Required fields only' }],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
    })

    expect(handle.invoice).toMatchObject({
      invoiceNumber: handle.threadId,
      lineItems: [
        {
          description: 'Required fields only',
          id: undefined,
          quantity: undefined,
          unitPrice: undefined,
          amount: undefined
        }
      ]
    })
    expect(handle.invoice.expiresAt).toBeUndefined()
    expect(handle.invoice.total.unit.decimals).toBeUndefined()
  })

  it.each([-1, 1.5, 256])('rejects an invalid invoice unit precision of %s', async decimals => {
    const manager = new RemittanceManager(
      { remittanceModules: [], threadIdFactory: makeIdFactory('precision') },
      wallet,
      new BoundaryComms()
    )
    const input = {
      lineItems: [],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals } }
    } as ComposeInvoiceInput

    await expect(manager.sendInvoice(COUNTERPARTY, input)).rejects.toThrow(
      'Invoice total unit decimals must be a uint8'
    )
  })

  it('rejects invoices above the bounded line-item count', async () => {
    const manager = new RemittanceManager(
      { remittanceModules: [], threadIdFactory: makeIdFactory('large-invoice') },
      wallet,
      new BoundaryComms()
    )

    await expect(
      manager.sendInvoice(COUNTERPARTY, {
        lineItems: Array.from({ length: 10_001 }, () => ({ description: 'item' })),
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).rejects.toThrow('Invoice line items must be a bounded dense array')
  })

  it('fails closed when the wallet does not provide an identity key', async () => {
    const missingIdentityWallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: '' }))
    } as unknown as WalletInterface
    const manager = new RemittanceManager(
      { remittanceModules: [], threadIdFactory: makeIdFactory('missing-identity') },
      missingIdentityWallet,
      new BoundaryComms()
    )

    await expect(
      manager.sendInvoice(COUNTERPARTY, {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).rejects.toThrow('sendInvoice requires the wallet to provide an identity key')
  })

  it('resolves multiple state waiters through authenticated invoice and settlement transitions', async () => {
    const comms = new BoundaryComms()
    const manager = new RemittanceManager(
      {
        remittanceModules: [makeModule()],
        options: { receiptProvided: false },
        threadIdFactory: makeIdFactory('wait')
      },
      wallet,
      comms,
      [makeThread()]
    )

    const invoiced = manager.waitForState('thread-1', 'invoiced', {
      timeoutMs: 100,
      pollIntervalMs: 5
    })
    const settled = manager.waitForState('thread-1', 'settled', {
      timeoutMs: 100,
      pollIntervalMs: 5
    })
    await Promise.resolve()

    await manager.sendInvoiceForThread('thread-1', {
      lineItems: [],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
    })
    await expect(invoiced).resolves.toMatchObject({ state: 'invoiced' })

    comms.enqueue(COUNTERPARTY, envelope('settlement', makeSettlement(), 'wait-settlement'))
    await manager.syncThreads()
    await expect(settled).resolves.toMatchObject({ settlement: expect.any(Object) })
  })

  it('removes a state waiter after a bounded timeout', async () => {
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, new BoundaryComms(), [
      makeThread()
    ])

    await expect(
      manager.waitForState('thread-1', 'invoiced', { timeoutMs: 2, pollIntervalMs: 1 })
    ).rejects.toThrow('Timed out waiting for state: invoiced')
  })

  it('logs a live-message rejection when the bounded thread capacity is exhausted', async () => {
    const comms = new BoundaryComms()
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const manager = new RemittanceManager({ remittanceModules: [], logger }, wallet, comms)
    manager.threads = Array.from({ length: 10_000 }, (_, index) =>
      makeThread({ threadId: `existing-${index}` as ThreadId })
    )
    await manager.startListening()

    comms.liveHandler?.({
      messageId: 'live-message',
      sender: COUNTERPARTY,
      recipient: LOCAL,
      messageBox: 'remittance_inbox',
      body: JSON.stringify(
        envelope(
          'invoice',
          makeInvoice({ threadId: 'new-thread' as ThreadId, payee: COUNTERPARTY, payer: LOCAL }),
          'live-envelope'
        )
      ).replaceAll('thread-1', 'new-thread')
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(logger.error).toHaveBeenCalledWith(
      '[RemittanceManager] Live message processing failed',
      expect.objectContaining({ message: 'Remittance thread limit reached' })
    )
  })

  it.each([
    {
      name: 'invoice parties that do not match the transport',
      thread: makeThread({ myRole: 'taker', theirRole: 'maker' }),
      incoming: envelope(
        'invoice',
        makeInvoice({ payee: ATTACKER, payer: LOCAL }),
        'bad-invoice-parties'
      ),
      error: 'Invoice parties do not match'
    },
    {
      name: 'a second invoice for one thread',
      thread: makeThread({
        myRole: 'taker',
        theirRole: 'maker',
        state: 'invoiced',
        invoice: makeInvoice({ payee: COUNTERPARTY, payer: LOCAL })
      }),
      incoming: envelope(
        'invoice',
        makeInvoice({ payee: COUNTERPARTY, payer: LOCAL }),
        'duplicate-invoice'
      ),
      error: 'Invoice is not valid'
    },
    {
      name: 'an unsolicited identity response',
      thread: makeThread(),
      incoming: envelope(
        'identityVerificationResponse',
        { kind: 'identityVerificationResponse', threadId: 'thread-1', certificates: [] },
        'unsolicited-identity-response'
      ),
      error: 'Identity response does not answer'
    },
    {
      name: 'an identity acknowledgment without a response',
      thread: makeThread(),
      incoming: envelope(
        'identityVerificationAcknowledgment',
        { kind: 'identityVerificationAcknowledgment', threadId: 'thread-1' },
        'unsolicited-identity-acknowledgment'
      ),
      error: 'Identity acknowledgment does not answer'
    },
    {
      name: 'a settlement with a forged sender claim',
      thread: makeThread(),
      incoming: envelope(
        'settlement',
        makeSettlement({ sender: ATTACKER }),
        'forged-settlement-sender'
      ),
      error: 'Settlement sender does not match'
    },
    {
      name: 'a settlement delivered to a taker thread',
      thread: makeThread({ myRole: 'taker', theirRole: 'maker' }),
      incoming: envelope('settlement', makeSettlement(), 'wrong-role-settlement'),
      error: 'Settlement is not valid'
    },
    {
      name: 'a settlement option absent from the invoice',
      thread: makeThread({ state: 'invoiced', invoice: makeInvoice() }),
      incoming: envelope(
        'settlement',
        makeSettlement({ moduleId: 'other-module', optionId: 'other-module' }),
        'unbound-settlement-option'
      ),
      error: 'Settlement is not bound'
    },
    {
      name: 'a receipt with forged parties',
      thread: makeThread({
        myRole: 'taker',
        theirRole: 'maker',
        state: 'settled',
        invoice: makeInvoice({ payee: COUNTERPARTY, payer: LOCAL }),
        settlement: makeSettlement({ sender: LOCAL })
      }),
      incoming: envelope(
        'receipt',
        {
          kind: 'receipt',
          threadId: 'thread-1',
          moduleId: 'module-1',
          optionId: 'module-1',
          payee: COUNTERPARTY,
          payer: ATTACKER,
          createdAt: 2,
          receiptData: {}
        } satisfies Receipt,
        'forged-receipt'
      ),
      error: 'Receipt is not bound'
    },
    {
      name: 'a second termination for one thread',
      thread: makeThread({
        state: 'terminated',
        termination: { code: 'first', message: 'already terminated' }
      }),
      incoming: envelope(
        'termination',
        { code: 'second', message: 'terminate again' },
        'duplicate-termination'
      ),
      error: 'Termination is not valid'
    }
  ])('rejects $name', async ({ thread, incoming, error }) => {
    const comms = new BoundaryComms()
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const manager = new RemittanceManager(
      { remittanceModules: [makeModule()], logger },
      wallet,
      comms,
      [thread]
    )
    comms.enqueue(COUNTERPARTY, incoming)

    await manager.syncThreads()

    expect(comms.pending).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith(
      '[RemittanceManager] Rejected unauthorized inbound message',
      expect.objectContaining({ message: expect.stringContaining(error) })
    )
  })

  it('contains an unknown identity response action and records a local thread error', async () => {
    const comms = new BoundaryComms()
    const identityLayer = {
      determineCertificatesToRequest: jest.fn(),
      respondToRequest: jest.fn(async () => ({ action: 'unknown' })),
      assessReceivedCertificateSufficiency: jest.fn()
    } as unknown as IdentityLayer
    const manager = new RemittanceManager(
      { remittanceModules: [], identityLayer, threadIdFactory: makeIdFactory('identity') },
      wallet,
      comms
    )
    comms.enqueue(
      COUNTERPARTY,
      envelope(
        'identityVerificationRequest',
        {
          kind: 'identityVerificationRequest',
          threadId: 'thread-1',
          request: { types: {}, certifiers: [] }
        },
        'identity-request'
      )
    )

    await manager.syncThreads()

    expect(manager.getThreadOrThrow('thread-1').lastError?.message).toContain(
      'Unknown identity response action'
    )
    expect(comms.pending).toHaveLength(1)
  })

  it('continues existing-thread invoicing when identity was already acknowledged', async () => {
    const priorAcknowledgment = envelope(
      'identityVerificationAcknowledgment',
      { kind: 'identityVerificationAcknowledgment', threadId: 'thread-1' },
      'prior-acknowledgment'
    )
    const identityLayer = {
      determineCertificatesToRequest: jest.fn(),
      respondToRequest: jest.fn(),
      assessReceivedCertificateSufficiency: jest.fn()
    } as unknown as IdentityLayer
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        identityLayer,
        options: { identityOptions: { makerRequestIdentity: 'beforeInvoicing' } },
        threadIdFactory: makeIdFactory('acknowledged-invoice')
      },
      wallet,
      new BoundaryComms(),
      [
        makeThread({
          state: 'identityAcknowledged',
          protocolLog: [
            {
              direction: 'out',
              transportMessageId: 'prior-acknowledgment-message',
              envelope: priorAcknowledgment
            }
          ]
        })
      ]
    )

    await expect(
      manager.sendInvoiceForThread('thread-1', {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
      })
    ).resolves.toMatchObject({ threadId: 'thread-1' })
    expect(identityLayer.determineCertificatesToRequest).not.toHaveBeenCalled()
  })

  it('completes required identity exchange before an unsolicited settlement', async () => {
    const comms = new BoundaryComms()
    const identityLayer: IdentityLayer = {
      determineCertificatesToRequest: async ({ threadId }) => ({
        kind: 'identityVerificationRequest',
        threadId,
        request: { types: {}, certifiers: [] }
      }),
      respondToRequest: jest.fn(),
      assessReceivedCertificateSufficiency: async (_counterparty, _response, threadId) => ({
        kind: 'identityVerificationAcknowledgment',
        threadId
      })
    }
    const manager = new RemittanceManager(
      {
        remittanceModules: [makeModule({ allowUnsolicitedSettlements: true })],
        identityLayer,
        options: {
          identityOptions: { takerRequestIdentity: 'beforeSettlement' },
          identityTimeoutMs: 100,
          identityPollIntervalMs: 1
        },
        threadIdFactory: makeIdFactory('identified-settlement')
      },
      wallet,
      comms
    )

    const settlement = manager.sendUnsolicitedSettlement(COUNTERPARTY, {
      moduleId: 'module-1',
      option: {}
    })
    while (comms.sent.length === 0) await new Promise(resolve => setImmediate(resolve))
    const request = JSON.parse(comms.sent[0].body) as RemittanceEnvelope
    comms.enqueue(COUNTERPARTY, {
      v: 1,
      id: 'identity-response',
      kind: 'identityVerificationResponse',
      threadId: request.threadId,
      createdAt: 2,
      payload: {
        kind: 'identityVerificationResponse',
        threadId: request.threadId,
        certificates: []
      }
    })

    await expect(settlement).resolves.toMatchObject({ threadId: request.threadId })
    expect(manager.getThreadOrThrow(request.threadId)).toMatchObject({
      identity: { acknowledgmentSent: true },
      settlement: { kind: 'settlement' }
    })
  })

  it('supports immediate default waits and polling fallback for trusted local state changes', async () => {
    const existingSettlement = makeSettlement()
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, new BoundaryComms(), [
      makeThread({ state: 'settled', settlement: existingSettlement })
    ])

    await expect(manager.waitForSettlement('thread-1')).resolves.toEqual(existingSettlement)
    await expect(manager.waitForState('thread-1', 'settled')).resolves.toMatchObject({
      state: 'settled'
    })

    manager.threads[0].state = 'new'
    const polled = manager.waitForState('thread-1', 'invoiced', {
      timeoutMs: 50,
      pollIntervalMs: 1
    })
    await new Promise(resolve => setImmediate(resolve))
    manager.threads[0].state = 'invoiced'
    await expect(polled).resolves.toMatchObject({ state: 'invoiced' })
  })

  it('rejects a waiting operation when its thread terminates', async () => {
    const comms = new BoundaryComms()
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, comms, [makeThread()])
    const waiting = manager.waitForState('thread-1', 'settled', {
      timeoutMs: 100,
      pollIntervalMs: 1
    })
    await Promise.resolve()
    comms.enqueue(
      COUNTERPARTY,
      envelope('termination', { code: 'stopped', message: 'Peer stopped the remittance' })
    )
    await manager.syncThreads()

    await expect(waiting).rejects.toThrow('Thread entered terminal state: terminated')
  })

  it('retains a received identity response and an empty persisted error message', () => {
    const receivedResponse = envelope(
      'identityVerificationResponse',
      {
        kind: 'identityVerificationResponse',
        threadId: 'thread-1',
        certificates: []
      },
      'received-response'
    )
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, new BoundaryComms(), [
      makeThread({
        state: 'identityResponded',
        protocolLog: [
          {
            direction: 'in',
            transportMessageId: 'received-response-message',
            envelope: receivedResponse
          }
        ],
        processedMessageIds: ['received-response-message'],
        lastError: { message: undefined as never, at: 1 }
      })
    ])

    expect(manager.threads[0].identity.certsReceived).toEqual([])
    expect(manager.threads[0].lastError).toEqual({ message: '', at: 1 })
  })

  it('terminates a valid pending identity response when no identity layer is configured', async () => {
    const comms = new BoundaryComms()
    const request = envelope(
      'identityVerificationRequest',
      {
        kind: 'identityVerificationRequest',
        threadId: 'thread-1',
        request: { types: {}, certifiers: [] }
      },
      'outbound-identity-request'
    )
    const manager = new RemittanceManager(
      { remittanceModules: [], threadIdFactory: makeIdFactory('no-identity-layer') },
      wallet,
      comms,
      [
        makeThread({
          state: 'identityRequested',
          protocolLog: [
            {
              direction: 'out',
              transportMessageId: 'outbound-identity-request-message',
              envelope: request
            }
          ]
        })
      ]
    )
    comms.enqueue(
      COUNTERPARTY,
      envelope('identityVerificationResponse', {
        kind: 'identityVerificationResponse',
        threadId: 'thread-1',
        certificates: []
      })
    )

    await manager.syncThreads()

    expect(comms.pending).toHaveLength(0)
    expect(JSON.parse(comms.sent[0].body)).toMatchObject({
      kind: 'termination',
      payload: {
        message: 'Identity verification response received but no identity layer is configured'
      }
    })
  })

  it('rejects malformed authenticated transport metadata with a contained diagnostic', async () => {
    const comms = new BoundaryComms()
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const manager = new RemittanceManager({ remittanceModules: [], logger }, wallet, comms)
    comms.pending.push({
      messageId: 'wrong-recipient-message',
      sender: COUNTERPARTY,
      recipient: ATTACKER,
      messageBox: 'remittance_inbox',
      body: '{}'
    })

    await manager.syncThreads()

    expect(logger.warn).toHaveBeenCalledWith(
      '[RemittanceManager] Rejected invalid inbound message',
      expect.any(TypeError)
    )
    expect(comms.pending).toHaveLength(1)
  })

  it('refuses additional processing when a thread reaches its record cap', async () => {
    const comms = new BoundaryComms()
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const manager = new RemittanceManager({ remittanceModules: [], logger }, wallet, comms, [
      makeThread({ myRole: 'taker', theirRole: 'maker' })
    ])
    manager.threads[0].processedMessageIds = Array.from(
      { length: 10_000 },
      (_, index) => `processed-${index}`
    )
    comms.enqueue(
      COUNTERPARTY,
      envelope('invoice', makeInvoice({ payee: COUNTERPARTY, payer: LOCAL }))
    )

    await manager.syncThreads()

    expect(logger.warn).toHaveBeenCalledWith('[RemittanceManager] Thread processing limit reached')
    expect(comms.pending).toHaveLength(1)
    expect(manager.threads[0].invoice).toBeUndefined()
  })

  it('reports a persistence failure while containing an inbound adapter failure', async () => {
    const comms = new BoundaryComms()
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
    const stateSaver = jest.fn(async () => {
      throw new Error('state storage offline')
    })
    const manager = new RemittanceManager(
      {
        remittanceModules: [
          makeModule({
            allowUnsolicitedSettlements: true,
            acceptSettlement: async () => {
              throw new Error('adapter failed')
            }
          })
        ],
        stateSaver,
        logger,
        threadIdFactory: makeIdFactory('persistence-failure')
      },
      wallet,
      comms
    )
    const inbound = envelope('settlement', makeSettlement(), 'failing-settlement')
    inbound.threadId = 'new-thread'
    ;(inbound.payload as Settlement).threadId = 'new-thread'
    comms.enqueue(COUNTERPARTY, inbound)

    await manager.syncThreads()

    expect(logger.error).toHaveBeenCalledWith(
      '[RemittanceManager] Failed to persist inbound processing error',
      expect.objectContaining({ message: 'state storage offline' })
    )
    expect(comms.pending).toHaveLength(1)
  })

  it('uses live transport successfully and emits its bounded transport identifier', async () => {
    const comms = Object.assign(new BoundaryComms(), {
      sendLiveMessage: jest.fn(async () => 'live-transport-id')
    })
    const onEvent = jest.fn()
    const manager = new RemittanceManager(
      { remittanceModules: [], onEvent, threadIdFactory: makeIdFactory('live-send') },
      wallet,
      comms
    )

    await manager.sendInvoice(COUNTERPARTY, {
      lineItems: [],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } }
    })

    expect(comms.sendLiveMessage).toHaveBeenCalledTimes(1)
    expect(comms.sent).toHaveLength(0)
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'envelopeSent', transportMessageId: 'live-transport-id' })
    )
  })

  it('rejects an outbound envelope whose encoded form exceeds the transport ceiling', async () => {
    const comms = new BoundaryComms()
    const manager = new RemittanceManager(
      { remittanceModules: [], threadIdFactory: makeIdFactory('oversized') },
      wallet,
      comms,
      [makeThread()]
    )
    const nearLimit = 'x'.repeat(16 * 1024 * 1024 - 32)

    await expect(
      manager.sendInvoiceForThread('thread-1', {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat' } },
        arbitrary: { nearLimit }
      })
    ).rejects.toThrow('Outbound remittance envelope is invalid or exceeds the size limit')
    expect(comms.sent).toHaveLength(0)
  })
})
