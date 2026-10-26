import type { CommsLayer } from '../CommsLayer.js'
import type { IdentityLayer } from '../IdentityLayer.js'
import { RemittanceManager, type Thread } from '../RemittanceManager.js'
import type { RemittanceModule } from '../RemittanceModule.js'
import type { PeerMessage, RemittanceEnvelope, ThreadId } from '../types.js'
import type { PubKeyHex, WalletInterface } from '../../wallet/Wallet.interfaces.js'

const LOCAL = 'local-identity' as PubKeyHex
const COUNTERPARTY = 'counterparty-identity' as PubKeyHex
const ATTACKER = 'attacker-identity' as PubKeyHex

class QueueComms implements CommsLayer {
  readonly pending: PeerMessage[] = []
  readonly sent: Array<{ recipient: string; messageBox: string; body: string }> = []
  private nextId = 1

  enqueue(sender: PubKeyHex, envelope: RemittanceEnvelope): string {
    const messageId = `in-${this.nextId++}`
    this.pending.push({
      messageId,
      sender,
      recipient: LOCAL,
      messageBox: 'remittance_inbox',
      body: JSON.stringify(envelope)
    })
    return messageId
  }

  async sendMessage(args: {
    recipient: PubKeyHex
    messageBox: string
    body: string
  }): Promise<string> {
    this.sent.push(args)
    return `out-${this.nextId++}`
  }

  async listMessages(): Promise<PeerMessage[]> {
    return this.pending.slice()
  }

  async acknowledgeMessage(args: { messageIds: string[] }): Promise<void> {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      if (args.messageIds.includes(this.pending[index].messageId)) this.pending.splice(index, 1)
    }
  }
}

const wallet = {
  getPublicKey: jest.fn(async () => ({ publicKey: LOCAL }))
} as unknown as WalletInterface

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    threadId: 'thread-1' as ThreadId,
    counterparty: COUNTERPARTY,
    myRole: 'maker',
    theirRole: 'taker',
    createdAt: 1,
    updatedAt: 1,
    state: 'identityResponded',
    stateLog: [],
    processedMessageIds: [],
    protocolLog: [],
    identity: {
      certsSent: [],
      certsReceived: [],
      requestSent: false,
      responseSent: true,
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

function settlementEnvelope(id = 'envelope-1'): RemittanceEnvelope {
  return {
    v: 1,
    id,
    kind: 'settlement',
    threadId: 'new-thread' as ThreadId,
    createdAt: 2,
    payload: {
      kind: 'settlement',
      threadId: 'new-thread',
      moduleId: 'module-1',
      optionId: 'module-1',
      sender: COUNTERPARTY,
      createdAt: 2,
      artifact: { amount: 1 }
    }
  }
}

describe('RemittanceManager protocol authority hardening', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rejects identity and settlement injection by a non-counterparty sender', async () => {
    const comms = new QueueComms()
    const acceptSettlement = jest.fn(async () => ({ action: 'accept' as const }))
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement
    }
    const thread = makeThread()
    const manager = new RemittanceManager({ remittanceModules: [module] }, wallet, comms, [thread])

    comms.enqueue(ATTACKER, {
      v: 1,
      id: 'attacker-ack',
      kind: 'identityVerificationAcknowledgment',
      threadId: thread.threadId,
      createdAt: 2,
      payload: {
        kind: 'identityVerificationAcknowledgment',
        threadId: thread.threadId
      }
    })
    const injectedSettlement = settlementEnvelope('attacker-settlement')
    injectedSettlement.threadId = thread.threadId
    ;(injectedSettlement.payload as { threadId: ThreadId; sender: PubKeyHex }).threadId =
      thread.threadId
    ;(injectedSettlement.payload as { threadId: ThreadId; sender: PubKeyHex }).sender = ATTACKER
    comms.enqueue(ATTACKER, injectedSettlement)

    await manager.syncThreads()

    expect(thread.flags.hasIdentified).toBe(false)
    expect(thread.settlement).toBeUndefined()
    expect(acceptSettlement).not.toHaveBeenCalled()
    expect(comms.pending).toHaveLength(2)
  })

  it('deduplicates one envelope delivered under multiple transport IDs', async () => {
    const comms = new QueueComms()
    const acceptSettlement = jest.fn(async () => ({ action: 'accept' as const }))
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement
    }
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms
    )
    const envelope = settlementEnvelope()
    comms.enqueue(COUNTERPARTY, envelope)
    comms.enqueue(COUNTERPARTY, envelope)

    await manager.syncThreads()

    expect(acceptSettlement).toHaveBeenCalledTimes(1)
    expect(manager.threads).toHaveLength(1)
    expect(comms.pending).toHaveLength(0)
  })

  it('deduplicates a sender envelope ID even when replayed under another thread ID', async () => {
    const comms = new QueueComms()
    const acceptSettlement = jest.fn(async () => ({ action: 'accept' as const }))
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement
    }
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms
    )
    comms.enqueue(COUNTERPARTY, settlementEnvelope('sender-scoped-envelope'))
    const replay = settlementEnvelope('sender-scoped-envelope')
    replay.threadId = 'alternate-thread'
    ;(replay.payload as { threadId: ThreadId }).threadId = 'alternate-thread'
    comms.enqueue(COUNTERPARTY, replay)

    await manager.syncThreads()

    expect(acceptSettlement).toHaveBeenCalledTimes(1)
    expect(manager.threads).toHaveLength(1)
    expect(comms.pending).toHaveLength(0)
  })

  it('serializes concurrent deliveries of the same settlement envelope', async () => {
    const comms = new QueueComms()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const acceptSettlement = jest.fn(async () => {
      await gate
      return { action: 'accept' as const }
    })
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement
    }
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms
    )
    comms.enqueue(COUNTERPARTY, settlementEnvelope())

    const first = manager.syncThreads()
    const second = manager.syncThreads()
    await Promise.resolve()
    release()
    await Promise.all([first, second])

    expect(acceptSettlement).toHaveBeenCalledTimes(1)
    expect(comms.pending).toHaveLength(0)
  })

  it('does not disclose settlement adapter failures to the remote peer', async () => {
    const comms = new QueueComms()
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement: async () => {
        throw new Error('wallet credential secret-value')
      }
    }
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms
    )
    comms.enqueue(COUNTERPARTY, settlementEnvelope())

    await manager.syncThreads()

    expect(comms.sent).toHaveLength(1)
    expect(comms.sent[0].body).not.toContain('credential')
    expect(comms.sent[0].body).not.toContain('secret-value')
    expect(JSON.parse(comms.sent[0].body)).toMatchObject({
      payload: { message: 'Settlement processing failed safely.' }
    })
  })

  it('permits only one concurrent outgoing payment for a thread', async () => {
    const comms = new QueueComms()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const buildSettlement = jest.fn(async () => {
      await gate
      return { action: 'settle' as const, artifact: { amount: 1 } }
    })
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: false,
      buildSettlement,
      acceptSettlement: async () => ({ action: 'accept' })
    }
    const invoice = {
      kind: 'invoice' as const,
      threadId: 'thread-1' as ThreadId,
      payee: COUNTERPARTY,
      payer: LOCAL,
      lineItems: [],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
      invoiceNumber: 'invoice-1',
      createdAt: 1,
      options: { 'module-1': { amount: 1 } }
    }
    const thread = makeThread({
      myRole: 'taker',
      theirRole: 'maker',
      state: 'invoiced',
      invoice,
      identity: { ...makeThread().identity, responseSent: false },
      flags: { ...makeThread().flags, hasInvoiced: true }
    })
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms,
      [thread]
    )

    const first = manager.pay(thread.threadId)
    await Promise.resolve()
    await expect(manager.pay(thread.threadId)).rejects.toThrow('already in progress')
    release()
    await first

    expect(buildSettlement).toHaveBeenCalledTimes(1)
    expect(comms.sent).toHaveLength(1)
  })

  it('rejects a non-discriminated settlement build result', async () => {
    const comms = new QueueComms()
    const module = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: false,
      buildSettlement: async () => ({ action: 'accepted', artifact: { amount: 1 } }),
      acceptSettlement: async () => ({ action: 'accept' as const })
    } as unknown as RemittanceModule
    const thread = makeThread({
      myRole: 'taker',
      theirRole: 'maker',
      invoice: {
        kind: 'invoice',
        threadId: 'thread-1',
        payee: COUNTERPARTY,
        payer: LOCAL,
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
        invoiceNumber: 'invoice-1',
        createdAt: 1,
        options: { 'module-1': { amount: 1 } }
      }
    })
    const manager = new RemittanceManager(
      { remittanceModules: [module], options: { receiptProvided: false } },
      wallet,
      comms,
      [thread]
    )

    await expect(manager.pay(thread.threadId)).rejects.toThrow('Unknown settlement build action')
    expect(comms.sent).toHaveLength(0)
  })

  it('copies hydrated state and derives authority flags from protocol evidence', () => {
    const comms = new QueueComms()
    const supplied = makeThread({
      state: 'identityAcknowledged',
      identity: { ...makeThread().identity, responseSent: false },
      flags: { ...makeThread().flags, hasIdentified: true }
    })
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, comms, [supplied])

    supplied.counterparty = ATTACKER
    supplied.flags.hasIdentified = true

    expect(manager.threads[0].counterparty).toBe(COUNTERPARTY)
    expect(manager.threads[0].flags.hasIdentified).toBe(false)
    expect(manager.threads[0].state).toBe('new')
  })

  it('rejects accessor-backed and duplicate persisted state', () => {
    const comms = new QueueComms()
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, comms)
    const getter = jest.fn(() => 1)
    const accessorState = Object.create(null) as Record<string, unknown>
    Object.defineProperty(accessorState, 'v', { enumerable: true, get: getter })
    accessorState.threads = []

    expect(() => manager.loadState(accessorState as never)).toThrow('unsafe property')
    expect(getter).not.toHaveBeenCalled()
    expect(() => manager.loadState({ v: 1, threads: [makeThread(), makeThread()] })).toThrow(
      'must be unique'
    )
  })

  it('rejects persisted financial parties that are not bound to the local identity', async () => {
    const comms = new QueueComms()
    const poisoned = makeThread({
      state: 'invoiced',
      invoice: {
        kind: 'invoice',
        threadId: 'thread-1',
        payee: ATTACKER,
        payer: COUNTERPARTY,
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
        invoiceNumber: 'poisoned',
        createdAt: 1,
        options: {}
      }
    })
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        stateLoader: async () => ({ v: 1, threads: [poisoned] })
      },
      wallet,
      comms
    )

    await expect(manager.init()).rejects.toThrow('invoice parties')
  })

  it('does not treat the peer acknowledgment of our identity as verification of the peer', async () => {
    const comms = new QueueComms()
    const acceptSettlement = jest.fn(async () => ({ action: 'accept' as const }))
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: true,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement
    }
    const thread = makeThread({
      myRole: 'maker',
      theirRole: 'taker',
      protocolLog: [
        {
          direction: 'out',
          transportMessageId: 'identity-response-message',
          envelope: {
            v: 1,
            id: 'identity-response-envelope',
            kind: 'identityVerificationResponse',
            threadId: 'thread-1',
            createdAt: 1,
            payload: {
              kind: 'identityVerificationResponse',
              threadId: 'thread-1',
              certificates: []
            }
          }
        },
        {
          direction: 'in',
          transportMessageId: 'identity-ack-message',
          envelope: {
            v: 1,
            id: 'identity-ack-envelope',
            kind: 'identityVerificationAcknowledgment',
            threadId: 'thread-1',
            createdAt: 2,
            payload: {
              kind: 'identityVerificationAcknowledgment',
              threadId: 'thread-1'
            }
          }
        }
      ],
      processedMessageIds: ['identity-ack-message']
    })
    const manager = new RemittanceManager(
      {
        remittanceModules: [module],
        options: {
          identityOptions: { makerRequestIdentity: 'beforeSettlement' },
          receiptProvided: false
        }
      },
      wallet,
      comms,
      [thread]
    )
    const settlement = settlementEnvelope('unverified-peer-settlement')
    settlement.threadId = thread.threadId
    ;(settlement.payload as { threadId: ThreadId }).threadId = thread.threadId
    comms.enqueue(COUNTERPARTY, settlement)

    await manager.syncThreads()

    expect(manager.threads[0].flags.hasIdentified).toBe(true)
    expect(manager.threads[0].identity.acknowledgmentSent).toBe(false)
    expect(acceptSettlement).not.toHaveBeenCalled()
    expect(JSON.parse(comms.sent[0].body)).toMatchObject({ kind: 'termination' })
  })

  it('rejects malformed identity certificates before invoking the identity policy', async () => {
    const comms = new QueueComms()
    const assessReceivedCertificateSufficiency = jest.fn()
    const identityLayer = {
      determineCertificatesToRequest: jest.fn(),
      respondToRequest: jest.fn(),
      assessReceivedCertificateSufficiency
    } as unknown as IdentityLayer
    const thread = makeThread({
      protocolLog: [
        {
          direction: 'out',
          transportMessageId: 'identity-request-message',
          envelope: {
            v: 1,
            id: 'identity-request-envelope',
            kind: 'identityVerificationRequest',
            threadId: 'thread-1',
            createdAt: 1,
            payload: {
              kind: 'identityVerificationRequest',
              threadId: 'thread-1',
              request: { types: { basic: ['name'] }, certifiers: ['certifier'] }
            }
          }
        }
      ]
    })
    const manager = new RemittanceManager({ remittanceModules: [], identityLayer }, wallet, comms, [
      thread
    ])
    comms.pending.push({
      messageId: 'malformed-response-message',
      sender: COUNTERPARTY,
      recipient: LOCAL,
      messageBox: 'remittance_inbox',
      body: JSON.stringify({
        v: 1,
        id: 'malformed-response-envelope',
        kind: 'identityVerificationResponse',
        threadId: 'thread-1',
        createdAt: 2,
        payload: {
          kind: 'identityVerificationResponse',
          threadId: 'thread-1',
          certificates: [
            {
              type: 'basic',
              certifier: 'certifier',
              subject: COUNTERPARTY,
              fields: { name: 'Alice' },
              serialNumber: 'serial',
              revocationOutpoint: 'outpoint',
              keyringForVerifier: { name: 'key' }
            }
          ]
        }
      })
    })

    await manager.syncThreads()

    expect(assessReceivedCertificateSufficiency).not.toHaveBeenCalled()
    expect(comms.pending).toHaveLength(1)
  })

  it('preserves bounded typed module state but rejects sparse and excessive opaque data', () => {
    const comms = new QueueComms()
    const bytes = new Uint8Array([1, 2, 3])
    const invoice = {
      kind: 'invoice' as const,
      threadId: 'thread-1' as ThreadId,
      payee: LOCAL,
      payer: COUNTERPARTY,
      lineItems: [],
      total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
      invoiceNumber: 'invoice-1',
      createdAt: 1,
      options: { module: { bytes } }
    }
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, comms, [
      makeThread({ state: 'invoiced', invoice })
    ])
    const snapshot = manager.saveState()
    const restored = new RemittanceManager({ remittanceModules: [] }, wallet, comms)
    restored.loadState(snapshot)

    const restoredOption = restored.threads[0].invoice?.options.module
    expect(restoredOption).toBeDefined()
    const restoredBytes = (restoredOption as { bytes: Uint8Array }).bytes
    expect(restoredBytes).toEqual(bytes)
    expect(restoredBytes).not.toBe(bytes)

    const sparse: unknown[] = []
    sparse.length = 1
    const sparseInvoice = { ...invoice, options: { module: sparse } }
    expect(
      () =>
        new RemittanceManager({ remittanceModules: [] }, wallet, comms, [
          makeThread({ state: 'invoiced', invoice: sparseInvoice })
        ])
    ).toThrow('dense indexed values')
    expect(() =>
      restored.loadState({
        v: 1,
        threads: [],
        defaultPaymentOptionId: 'x'.repeat(16 * 1024 * 1024 + 1)
      })
    ).toThrow('aggregate data limit')
  })

  it('sends a validated invoice for an existing maker thread and persists the transition', async () => {
    const comms = new QueueComms()
    const stateSaver = jest.fn()
    const createOption = jest.fn(async ({ invoice }) => ({ quotedTotal: invoice.total.value }))
    const module: RemittanceModule = {
      id: 'module-1',
      name: 'module',
      allowUnsolicitedSettlements: false,
      createOption,
      buildSettlement: async () => ({ action: 'settle', artifact: {} }),
      acceptSettlement: async () => ({ action: 'accept' })
    }
    const thread = makeThread({
      state: 'new',
      identity: { ...makeThread().identity, responseSent: false }
    })
    const manager = new RemittanceManager(
      {
        remittanceModules: [module],
        stateSaver,
        now: () => 10,
        threadIdFactory: () => 'invoice-envelope' as ThreadId
      },
      wallet,
      comms,
      [thread]
    )

    const handle = await manager.sendInvoiceForThread(
      thread.threadId,
      {
        note: 'bounded invoice',
        lineItems: [
          {
            id: 'line-1',
            description: 'Service',
            quantity: '2',
            unitPrice: {
              value: '3',
              unit: { namespace: 'bsv', code: 'sat', decimals: 0 }
            },
            amount: {
              value: '6',
              unit: { namespace: 'bsv', code: 'sat', decimals: 0 }
            }
          }
        ],
        total: { value: '6', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } },
        invoiceNumber: 'invoice-1',
        arbitrary: { orderId: 'order-1' }
      },
      'https://message-box.example'
    )

    expect(handle.threadId).toBe(thread.threadId)
    expect(handle.invoice).toMatchObject({
      payee: LOCAL,
      payer: COUNTERPARTY,
      note: 'bounded invoice',
      options: { 'module-1': { quotedTotal: '6' } }
    })
    expect(createOption).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: thread.threadId, invoice: handle.invoice }),
      expect.objectContaining({ wallet })
    )
    expect(manager.threads[0]).toMatchObject({
      state: 'invoiced',
      flags: { hasInvoiced: true }
    })
    expect(manager.threads[0].protocolLog).toHaveLength(1)
    expect(JSON.parse(comms.sent[0].body)).toMatchObject({
      id: 'invoice-envelope',
      kind: 'invoice',
      threadId: thread.threadId
    })
    expect(stateSaver).toHaveBeenCalledWith(
      expect.objectContaining({ v: 1, threads: [expect.objectContaining({ state: 'invoiced' })] })
    )
  })

  it.each([
    ['non-array modules', {}],
    ['more than 1,000 modules', Array.from({ length: 1001 }, () => null)],
    [
      'a sparse module list',
      (() => {
        const modules: unknown[] = []
        modules.length = 1
        return modules
      })()
    ],
    ['a non-object module', [null]],
    [
      'duplicate module IDs',
      [
        {
          id: 'duplicate',
          allowUnsolicitedSettlements: false,
          buildSettlement: async () => ({ action: 'settle', artifact: {} }),
          acceptSettlement: async () => ({ action: 'accept' })
        },
        {
          id: 'duplicate',
          allowUnsolicitedSettlements: false,
          buildSettlement: async () => ({ action: 'settle', artifact: {} }),
          acceptSettlement: async () => ({ action: 'accept' })
        }
      ]
    ],
    [
      'a module missing its settlement contract',
      [{ id: 'incomplete', allowUnsolicitedSettlements: false }]
    ]
  ])('rejects %s at the trusted module-registration boundary', (_name, remittanceModules) => {
    expect(
      () =>
        new RemittanceManager(
          { remittanceModules: remittanceModules as never },
          wallet,
          new QueueComms()
        )
    ).toThrow(/bounded array|dense array|must be an object|unique|required contract/)
  })

  it.each([
    [{ identityOptions: { makerRequestIdentity: 'sometimes' } }, 'request phases'],
    [{ identityOptions: { takerRequestIdentity: 'sometimes' } }, 'request phases'],
    [{ receiptProvided: 'true' }, 'receiptProvided'],
    [{ autoIssueReceipt: 1 }, 'autoIssueReceipt'],
    [{ invoiceExpirySeconds: -2 }, 'invoiceExpirySeconds'],
    [{ invoiceExpirySeconds: 31_536_001 }, 'invoiceExpirySeconds'],
    [{ identityTimeoutMs: -1 }, 'identityTimeoutMs'],
    [{ identityTimeoutMs: 86_400_001 }, 'identityTimeoutMs'],
    [{ identityPollIntervalMs: 0 }, 'identityPollIntervalMs']
  ])('rejects invalid runtime option %#', (options, message) => {
    expect(
      () =>
        new RemittanceManager(
          { remittanceModules: [], options: options as never },
          wallet,
          new QueueComms()
        )
    ).toThrow(message)
  })

  it('accepts the exact runtime duration and expiry boundaries', () => {
    expect(
      () =>
        new RemittanceManager(
          {
            remittanceModules: [],
            options: {
              receiptProvided: false,
              autoIssueReceipt: false,
              invoiceExpirySeconds: -1,
              identityTimeoutMs: 0,
              identityPollIntervalMs: 1
            }
          },
          wallet,
          new QueueComms()
        )
    ).not.toThrow()
  })

  it.each([
    [
      'conflicting roles',
      () => makeThread({ myRole: 'maker', theirRole: 'maker' }),
      'roles are invalid'
    ],
    [
      'time moving backwards',
      () => makeThread({ createdAt: 2, updatedAt: 1 }),
      'updatedAt precedes createdAt'
    ],
    ['an unknown state', () => makeThread({ state: 'unknown' as never }), 'state is invalid'],
    [
      'duplicate processed messages',
      () => makeThread({ processedMessageIds: ['message-1', 'message-1'] }),
      'duplicate processed message IDs'
    ],
    [
      'a protocol log with an invalid direction',
      () =>
        makeThread({
          protocolLog: [
            {
              direction: 'sideways' as never,
              transportMessageId: 'message-1',
              envelope: settlementEnvelope()
            }
          ]
        }),
      'protocol log direction is invalid'
    ],
    [
      'a protocol envelope bound to another thread',
      () =>
        makeThread({
          protocolLog: [
            {
              direction: 'in',
              transportMessageId: 'message-1',
              envelope: settlementEnvelope()
            }
          ]
        }),
      'protocol log envelope is invalid'
    ],
    [
      'a processed message without inbound evidence',
      () => makeThread({ processedMessageIds: ['message-1'] }),
      'processed message has no inbound protocol evidence'
    ],
    [
      'an invalid last-error record',
      () => makeThread({ lastError: { message: 1 as never, at: 1 } }),
      'last error message must be a bounded string'
    ],
    [
      'an invalid state-log transition',
      () =>
        makeThread({
          stateLog: [{ at: 1, from: 'unknown' as never, to: 'new', reason: 'tampered' }]
        }),
      'state log transition is invalid'
    ]
  ])('rejects persisted thread state containing %s', (_name, makeCandidate, message) => {
    const manager = new RemittanceManager({ remittanceModules: [] }, wallet, new QueueComms())

    expect(() => manager.loadState({ v: 1, threads: [makeCandidate()] })).toThrow(message)
  })

  it('rejects duplicate persisted outbound envelope IDs across threads', () => {
    const makeOutboundLog = (threadId: ThreadId) => ({
      direction: 'out' as const,
      transportMessageId: `message-${threadId}`,
      envelope: {
        v: 1 as const,
        id: 'reused-envelope-id',
        kind: 'identityVerificationAcknowledgment' as const,
        threadId,
        createdAt: 1,
        payload: { kind: 'identityVerificationAcknowledgment' as const, threadId }
      }
    })
    const first = makeThread({ protocolLog: [makeOutboundLog('thread-1')] })
    const second = makeThread({
      threadId: 'thread-2',
      protocolLog: [makeOutboundLog('thread-2')]
    })

    expect(
      () =>
        new RemittanceManager({ remittanceModules: [] }, wallet, new QueueComms(), [first, second])
    ).toThrow('Persisted remittance envelope IDs must be unique')
  })

  it('rejects a generated thread ID collision before sending an invoice', async () => {
    const comms = new QueueComms()
    const manager = new RemittanceManager(
      {
        remittanceModules: [],
        threadIdFactory: () => 'thread-1' as ThreadId
      },
      wallet,
      comms,
      [makeThread()]
    )

    await expect(
      manager.sendInvoice(COUNTERPARTY, {
        lineItems: [],
        total: { value: '1', unit: { namespace: 'bsv', code: 'sat', decimals: 0 } }
      })
    ).rejects.toThrow('Generated remittance thread ID is not unique')
    expect(comms.sent).toHaveLength(0)
  })

  it.each([
    [
      'settlement sender',
      makeThread({
        settlement: {
          kind: 'settlement',
          threadId: 'thread-1',
          moduleId: 'module-1',
          optionId: 'module-1',
          sender: ATTACKER,
          createdAt: 1,
          artifact: {}
        }
      }),
      'settlement sender'
    ],
    [
      'receipt parties',
      makeThread({
        receipt: {
          kind: 'receipt',
          threadId: 'thread-1',
          moduleId: 'module-1',
          optionId: 'module-1',
          payee: ATTACKER,
          payer: COUNTERPARTY,
          createdAt: 1,
          receiptData: {}
        }
      }),
      'receipt parties'
    ]
  ])(
    'rejects a persisted %s not bound to its authenticated thread',
    async (_name, thread, message) => {
      const manager = new RemittanceManager(
        {
          remittanceModules: [],
          stateLoader: async () => ({ v: 1, threads: [thread] })
        },
        wallet,
        new QueueComms()
      )

      await expect(manager.init()).rejects.toThrow(message)
    }
  )
})
