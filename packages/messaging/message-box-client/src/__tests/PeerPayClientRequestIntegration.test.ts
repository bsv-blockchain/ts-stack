/* eslint-env jest */
/**
 * Integration tests for the PeerPayClient payment request flow.
 *
 * Uses a MockMessageBus to simulate the MessageBox server in memory,
 * wiring the PeerPayClient methods (sendMessage, listMessages, acknowledgeMessage,
 * getIdentityKey) to the mock bus so that full round-trip flows can be tested
 * without hitting a real server.
 */

import { PeerPayClient, PAYMENT_REQUESTS_MESSAGEBOX, PAYMENT_REQUEST_RESPONSES_MESSAGEBOX, STANDARD_PAYMENT_MESSAGEBOX } from '../PeerPayClient.js'
import { PeerMessage } from '../types.js'
import { PrivateKey, CreateHmacResult, WalletClient } from '@bsv/sdk'
import { jest } from '@jest/globals'

// ---------------------------------------------------------------------------
// Mock @bsv/sdk the same way as PeerPayClientUnit.test.ts
// ---------------------------------------------------------------------------
jest.mock('@bsv/sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actualSDK = jest.requireActual('@bsv/sdk') as any
  return {
    ...actualSDK,
    WalletClient: jest.fn().mockImplementation(() => ({
      getPublicKey: jest.fn(),
      createAction: jest.fn(),
      internalizeAction: jest.fn(),
      createHmac: jest.fn<() => Promise<CreateHmacResult>>().mockResolvedValue({
        hmac: [1, 2, 3, 4, 5]
      }),
      verifyHmac: jest.fn<() => Promise<{ valid: true }>>().mockResolvedValue({ valid: true as const })
    }))
  }
})

// ---------------------------------------------------------------------------
// MockMessageBus
// ---------------------------------------------------------------------------
/**
 * Stores messages per (recipient, messageBox) pair in memory.
 * Provides send / list / ack helpers that the wired client delegates to.
 */
class MockMessageBus {
  private counter = 0
  // key: `${recipient}::${messageBox}`
  private readonly store = new Map<string, PeerMessage[]>()

  private key (recipient: string, messageBox: string): string {
    return `${recipient}::${messageBox}`
  }

  send (params: { recipient: string, messageBox: string, body: string, sender: string }): { status: string, messageId: string } {
    const { recipient, messageBox, body, sender } = params
    const k = this.key(recipient, messageBox)
    const messageId = `msg-${++this.counter}`
    const now = new Date().toISOString()
    const msg: PeerMessage = { messageId, sender, body, created_at: now, updated_at: now }
    const existing = this.store.get(k)
    if (existing != null) {
      existing.push(msg)
    } else {
      this.store.set(k, [msg])
    }
    return { status: 'success', messageId }
  }

  list (recipient: string, messageBox: string): PeerMessage[] {
    return this.store.get(this.key(recipient, messageBox)) ?? []
  }

  ack (recipient: string, messageBox: string, messageIds: string[]): void {
    const k = this.key(recipient, messageBox)
    const msgs = this.store.get(k)
    if (msgs == null) return
    const remaining = msgs.filter(m => !messageIds.includes(m.messageId))
    this.store.set(k, remaining)
  }

  /** Convenience: clear everything */
  reset (): void {
    this.store.clear()
    this.counter = 0
  }
}

// ---------------------------------------------------------------------------
// createWiredClient
// ---------------------------------------------------------------------------
/**
 * Creates a PeerPayClient whose sendMessage, listMessages, acknowledgeMessage,
 * and getIdentityKey are wired to the provided MockMessageBus instance.
 *
 * The identityKey is the "address" used as recipient/sender for messages
 * sent through the bus.
 *
 * sendPayment is mocked to be a no-op so tests that call fulfillPaymentRequest
 * don't need a real wallet.
 */
function createWiredClient (params: {
  bus: MockMessageBus
  identityKey: string
  walletClient: jest.Mocked<WalletClient>
}): PeerPayClient {
  const { bus, identityKey, walletClient } = params

  const client = new PeerPayClient({
    messageBoxHost: 'https://message-box-us-1.bsvb.tech',
    walletClient
  })

  // Wire getIdentityKey
  jest.spyOn(client, 'getIdentityKey').mockResolvedValue(identityKey)

  // Wire sendMessage: route to the bus using the current client identity as sender
  jest.spyOn(client, 'sendMessage').mockImplementation(async (sendParams: any) => {
    const body = typeof sendParams.body === 'string' ? sendParams.body : JSON.stringify(sendParams.body)
    return bus.send({
      recipient: sendParams.recipient,
      messageBox: sendParams.messageBox,
      body,
      sender: identityKey
    })
  })

  // Wire listMessages: retrieve from bus for this identity as recipient
  jest.spyOn(client, 'listMessages').mockImplementation(async (listParams: any) => {
    return bus.list(identityKey, listParams.messageBox)
  })

  // Wire acknowledgeMessage: remove messages from bus
  // We need to know which messageBox to remove from — scan all boxes for this recipient
  jest.spyOn(client, 'acknowledgeMessage').mockImplementation(async (ackParams: any) => {
    const { messageIds } = ackParams
    // Attempt to ack from all known messageBoxes
    for (const mb of [PAYMENT_REQUESTS_MESSAGEBOX, PAYMENT_REQUEST_RESPONSES_MESSAGEBOX, STANDARD_PAYMENT_MESSAGEBOX]) {
      bus.ack(identityKey, mb, messageIds)
    }
    return 'acknowledged'
  })

  // Mock sendPayment to be a no-op (avoids needing real wallet for tx creation)
  jest.spyOn(client, 'sendPayment').mockResolvedValue(undefined)

  return client
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('PeerPayClient — Integration: payment request flow', () => {
  let bus: MockMessageBus
  let mockWalletRequester: jest.Mocked<WalletClient>
  let mockWalletPayer: jest.Mocked<WalletClient>
  const REQUESTER_KEY = PrivateKey.fromRandom().toPublicKey().toString()
  const PAYER_KEY = PrivateKey.fromRandom().toPublicKey().toString()

  beforeEach(() => {
    jest.clearAllMocks()
    bus = new MockMessageBus()

    mockWalletRequester = new WalletClient() as jest.Mocked<WalletClient>
    mockWalletRequester.getPublicKey.mockResolvedValue({ publicKey: REQUESTER_KEY })

    mockWalletPayer = new WalletClient() as jest.Mocked<WalletClient>
    mockWalletPayer.getPublicKey.mockResolvedValue({ publicKey: PAYER_KEY })
  })

  // -------------------------------------------------------------------------
  // Test 1: Full round-trip — request → fulfill → requester sees paid response
  // -------------------------------------------------------------------------
  it('Test 1: full round-trip: request → fulfill → requester sees paid response', async () => {
    const requester = createWiredClient({ bus, identityKey: REQUESTER_KEY, walletClient: mockWalletRequester })
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    // Requester sends a payment request to payer
    const { requestId } = await requester.requestPayment({
      recipient: PAYER_KEY,
      amount: 5000,
      description: 'Invoice #1',
      expiresAt: Date.now() + 60000
    })

    expect(requestId).toBeTruthy()

    // Payer lists incoming requests
    const incoming = await payer.listIncomingPaymentRequests()
    expect(incoming).toHaveLength(1)
    expect(incoming[0].requestId).toBe(requestId)
    expect(incoming[0].amount).toBe(5000)

    // Payer fulfills the request
    await payer.fulfillPaymentRequest({ request: incoming[0] })

    // Requester checks for responses
    const responses = await requester.listPaymentRequestResponses()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ requestId, status: 'paid', amountPaid: 5000 })
  })

  // -------------------------------------------------------------------------
  // Test 2: Full round-trip — request → decline → requester sees declined
  // -------------------------------------------------------------------------
  it('Test 2: full round-trip: request → decline → requester sees declined response', async () => {
    const requester = createWiredClient({ bus, identityKey: REQUESTER_KEY, walletClient: mockWalletRequester })
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    const { requestId } = await requester.requestPayment({
      recipient: PAYER_KEY,
      amount: 3000,
      description: 'Invoice #2',
      expiresAt: Date.now() + 60000
    })

    const incoming = await payer.listIncomingPaymentRequests()
    expect(incoming).toHaveLength(1)

    await payer.declinePaymentRequest({ request: incoming[0], note: 'No funds' })

    const responses = await requester.listPaymentRequestResponses()
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ requestId, status: 'declined', note: 'No funds' })
  })

  // -------------------------------------------------------------------------
  // Test 3: Request → cancel → payer no longer sees the request
  // -------------------------------------------------------------------------
  it('Test 3: request → cancel → payer no longer sees the request', async () => {
    const requester = createWiredClient({ bus, identityKey: REQUESTER_KEY, walletClient: mockWalletRequester })
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    const { requestId, requestProof } = await requester.requestPayment({
      recipient: PAYER_KEY,
      amount: 2000,
      description: 'Cancellable request',
      expiresAt: Date.now() + 60000
    })

    // Confirm payer can see it before cancellation
    const beforeCancel = await payer.listIncomingPaymentRequests()
    expect(beforeCancel).toHaveLength(1)

    // Requester cancels the request
    await requester.cancelPaymentRequest({ recipient: PAYER_KEY, requestId, requestProof })

    // Payer should now see zero active requests (the cancel message causes filtering)
    const afterCancel = await payer.listIncomingPaymentRequests()
    expect(afterCancel).toHaveLength(0)
  })

  // -------------------------------------------------------------------------
  // Test 4: Expired request is filtered out automatically
  // -------------------------------------------------------------------------
  it('Test 4: expired request is filtered out automatically', async () => {
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    // Inject an already-expired request directly onto the bus (expiresAt in the past)
    const expiredBody = JSON.stringify({
      requestId: 'expired-req-1',
      amount: 4000,
      description: 'Already expired',
      expiresAt: Date.now() - 10000, // in the past
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: expiredBody, sender: REQUESTER_KEY })

    // Also inject a valid request so the filter has something to keep
    const validBody = JSON.stringify({
      requestId: 'valid-req-1',
      amount: 4000,
      description: 'Still valid',
      expiresAt: Date.now() + 60000,
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: validBody, sender: REQUESTER_KEY })

    const requests = await payer.listIncomingPaymentRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toBe('valid-req-1')
  })

  // -------------------------------------------------------------------------
  // Test 5: Requests below minAmount are auto-acknowledged and excluded
  // -------------------------------------------------------------------------
  it('Test 5: requests below minAmount are auto-acknowledged and excluded', async () => {
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    // Inject a request below the minAmount threshold
    const smallBody = JSON.stringify({
      requestId: 'req-small',
      amount: 100, // below minAmount of 1000
      description: 'Too small',
      expiresAt: Date.now() + 60000,
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: smallBody, sender: REQUESTER_KEY })

    // Inject a valid request that passes the filter
    const okBody = JSON.stringify({
      requestId: 'req-ok',
      amount: 5000,
      description: 'Just right',
      expiresAt: Date.now() + 60000,
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: okBody, sender: REQUESTER_KEY })

    const requests = await payer.listIncomingPaymentRequests(undefined, { minAmount: 1000, maxAmount: 10000 })
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toBe('req-ok')

    // The small request should have been auto-acknowledged (removed from bus)
    const remaining = bus.list(PAYER_KEY, PAYMENT_REQUESTS_MESSAGEBOX)
    const remainingIds = remaining.map(m => {
      const b = JSON.parse(m.body as string)
      return b.requestId
    })
    expect(remainingIds).not.toContain('req-small')
  })

  // -------------------------------------------------------------------------
  // Test 6: Requests above maxAmount are auto-acknowledged and excluded
  // -------------------------------------------------------------------------
  it('Test 6: requests above maxAmount are auto-acknowledged and excluded', async () => {
    const payer = createWiredClient({ bus, identityKey: PAYER_KEY, walletClient: mockWalletPayer })

    // Inject a request above the maxAmount threshold
    const largeBody = JSON.stringify({
      requestId: 'req-large',
      amount: 99999, // above maxAmount of 10000
      description: 'Too large',
      expiresAt: Date.now() + 60000,
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: largeBody, sender: REQUESTER_KEY })

    // Inject a valid request that passes the filter
    const okBody = JSON.stringify({
      requestId: 'req-ok-2',
      amount: 5000,
      description: 'Just right',
      expiresAt: Date.now() + 60000,
      senderIdentityKey: REQUESTER_KEY,
      requestProof: 'mock-proof'
    })
    bus.send({ recipient: PAYER_KEY, messageBox: PAYMENT_REQUESTS_MESSAGEBOX, body: okBody, sender: REQUESTER_KEY })

    const requests = await payer.listIncomingPaymentRequests(undefined, { minAmount: 1000, maxAmount: 10000 })
    expect(requests).toHaveLength(1)
    expect(requests[0].requestId).toBe('req-ok-2')

    // The large request should have been auto-acknowledged (removed from bus)
    const remaining = bus.list(PAYER_KEY, PAYMENT_REQUESTS_MESSAGEBOX)
    const remainingIds = remaining.map(m => {
      const b = JSON.parse(m.body as string)
      return b.requestId
    })
    expect(remainingIds).not.toContain('req-large')
  })
})
