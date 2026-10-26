/* eslint-env jest */
import sendMessage, {
  calculateMessagePrice,
  MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_BOX_BYTES,
  MAX_MESSAGE_ID_BYTES,
  MAX_MESSAGE_RECIPIENTS,
  Message,
  paymentOutputCoversDeliveryFee,
  SendMessageRequest
} from '../sendMessage.js'
import mockKnex from 'mock-knex'
import { Response } from 'express'
import { Beef, P2PKH, PrivateKey, ProtoWallet, PublicKey, Script, Transaction } from '@bsv/sdk'
import type { Tracker } from 'mock-knex'
import knexLib from 'knex'
import knexConfig from '../../../knexfile.js'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'
import { Logger } from '../../utils/logger.js'
import type { TransactionalPaymentReplayStore } from '../../security/TransactionalPaymentReplayStore.js'
import axios from 'axios'
import type { AxiosInstance as AxiosInstanceType } from 'axios'
import AxiosMockAdapter from 'axios-mock-adapter'

global.fetch = jest.fn()

const testKnex =
  (knexLib as any).default?.(knexConfig.development) ?? (knexLib as any)(knexConfig.development)
bindMessageBoxRuntime({ knex: testKnex })
const knex = sendMessage.knex
let queryTracker: Tracker
let axiosMock: AxiosMockAdapter
let mockPaymentIntent: { request_digest: string; status: string; attempt_token: string } | undefined
const VALID_RECIPIENT = '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'
const UNCOMPRESSED_RECIPIENT = PublicKey.fromString(VALID_RECIPIENT).encode(false, 'hex') as string
const VALID_SENDER = PrivateKey.fromRandom().toPublicKey().toString()
const UNCOMPRESSED_SENDER = PublicKey.fromString(VALID_SENDER).encode(false, 'hex') as string
const SECOND_RECIPIENT = PrivateKey.fromRandom().toPublicKey().toString()

function replayStore(
  claim: (transactionId: string) => boolean | Promise<boolean> = async () => true
): TransactionalPaymentReplayStore {
  return {
    claim,
    claimInTransaction: async transactionId => await claim(transactionId)
  }
}

// Define Mock Express Response Object
const mockRes: jest.Mocked<Response> = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
  sendStatus: jest.fn().mockReturnThis(),
  send: jest.fn().mockReturnThis(),
  end: jest.fn().mockReturnThis(),
  setHeader: jest.fn().mockReturnThis(),
  getHeader: jest.fn(),
  getHeaders: jest.fn(),
  header: jest.fn().mockReturnThis(),
  type: jest.fn().mockReturnThis(),
  format: jest.fn(),
  location: jest.fn().mockReturnThis(),
  redirect: jest.fn().mockReturnThis(),
  append: jest.fn().mockReturnThis(),
  render: jest.fn(),
  vary: jest.fn().mockReturnThis(),
  cookie: jest.fn().mockReturnThis(),
  clearCookie: jest.fn().mockReturnThis()
} as unknown as jest.Mocked<Response>

let validReq: SendMessageRequest
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let validRes: { status: string }
function successfulStoreResponse(q: { sql: string; response: (value: unknown) => void }): void {
  if (q.sql.includes('message_payment_intents')) {
    const query = q as typeof q & { bindings?: unknown[] }
    if (q.sql.startsWith('insert')) {
      mockPaymentIntent = {
        request_digest: String(query.bindings?.[2]),
        status: 'prepared',
        attempt_token: String(query.bindings?.[0])
      }
      q.response([1])
    } else if (q.sql.startsWith('select')) {
      q.response(mockPaymentIntent == null ? [] : [mockPaymentIntent])
    } else if (q.sql.startsWith('update')) {
      if (mockPaymentIntent != null) {
        mockPaymentIntent.status = q.sql.includes('completed') ? 'completed' : 'wallet_accepted'
      }
      q.response(1)
    } else {
      mockPaymentIntent = undefined
      q.response(1)
    }
  } else if (q.sql.includes('select `identityKey`, `messageBoxId` from `messageBox`')) {
    q.response([
      {
        identityKey: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
        messageBoxId: 42
      }
    ])
  } else if (q.sql.includes('message_count') && q.sql.includes('body_bytes')) {
    q.response([{ message_count: 0, body_bytes: 0 }])
  } else {
    q.response([])
  }
}

function recipientFeeStoreResponse(
  q: { sql: string; response: (value: unknown) => void },
  recipientFee: number
): void {
  if (q.sql.includes('message_permissions')) {
    q.response([{ recipient_fee: recipientFee }])
    return
  }
  successfulStoreResponse(q)
}

function deliveryPayment(satoshis: number): SendMessageRequest['body']['payment'] {
  const transaction = new Transaction()
  transaction.addOutput({ satoshis, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinaryAtomic(transaction.id('hex')),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: 'cHJlZml4',
          derivationSuffix: 'c3VmZml4',
          senderIdentityKey: VALID_SENDER
        }
      }
    ],
    description: 'Delivery payment'
  }
}

async function recipientPayment(
  satoshis: number,
  recipient: string = VALID_RECIPIENT,
  lockingRecipient: string = recipient
): Promise<NonNullable<SendMessageRequest['body']['payment']>> {
  const derivationPrefix = 'cHJlZml4'
  const derivationSuffix = 'c3VmZml4'
  const wallet = new ProtoWallet('anyone')
  const { publicKey } = await wallet.getPublicKey({
    protocolID: [2, '3241645161d8'],
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: lockingRecipient
  })
  const senderIdentityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
  const transaction = new Transaction()
  transaction.addOutput({
    satoshis,
    lockingScript: new P2PKH().lock(PublicKey.fromString(publicKey).toAddress())
  })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  return {
    tx: beef.toBinaryAtomic(transaction.id('hex')),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey }
      }
    ],
    description: 'Recipient payment'
  }
}

describe('sendMessage', () => {
  // Capture original console methods
  const originalError = console.error
  const originalLog = console.log
  const originalWarn = console.warn

  beforeAll(() => {
    mockKnex.mock(knex)
  })

  beforeEach(() => {
    Logger.enable()
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore()
    })

    jest.spyOn(console, 'error').mockImplementation((...args) => originalError(...args))
    jest.spyOn(console, 'log').mockImplementation((...args) => originalLog(...args))
    jest.spyOn(console, 'warn').mockImplementation((...args) => originalWarn(...args))

    const instance: AxiosInstanceType = axios
    // eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore
    axiosMock = new AxiosMockAdapter(instance)

    queryTracker = mockKnex.getTracker()
    queryTracker.install()
    mockPaymentIntent = undefined

    // Mock Data
    validRes = {
      status: 'success'
    }
    validReq = {
      auth: {
        identityKey: VALID_SENDER
      },
      body: {
        message: {
          messageId: 'mock-message-id',
          recipient: '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1',
          messageBox: 'payment_inbox',
          body: JSON.stringify({})
        }
      },
      get: jest.fn(),
      header: jest.fn()
    } as unknown as SendMessageRequest
  })

  afterEach(() => {
    delete process.env.MESSAGE_BOX_MAX_SENDER_MESSAGES
    delete process.env.MESSAGE_BOX_MAX_SENDER_BYTES
    delete process.env.MESSAGE_BOX_MAX_INBOX_MESSAGES
    delete process.env.MESSAGE_BOX_MAX_INBOX_BYTES
    delete process.env.MESSAGE_BOX_DB_DEADLOCK_RETRIES
    delete process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS
    delete process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS
    jest.clearAllMocks()

    if (queryTracker !== null && queryTracker !== undefined) {
      queryTracker.uninstall()
    }

    axiosMock?.restore()
  })

  afterAll(async () => {
    mockKnex.unmock(knex)
    await testKnex.destroy()
  })

  it('Throws an error if message is missing', async () => {
    validReq.body = {} // Ensure body exists, but message is missing

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_MESSAGE_REQUIRED',
        description: 'Please provide a valid message to send!'
      })
    )
  })

  it('Throws an error if message is not an object', async () => {
    validReq.body.message = 'My message to send' as unknown as Message

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_MESSAGEBOX',
        description: 'Invalid message box.'
      })
    )
  })

  it('Throws an error if recipient is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.recipient = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_RECIPIENT_REQUIRED',
        description: 'Missing recipient(s). Provide "recipient" or "recipients".'
      })
    )
  })

  it('Throws an error if recipient is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.recipient = 123 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_RECIPIENT_KEY'
      })
    )
  })

  it('rejects object recipients without invoking coercion hooks', async () => {
    const toStringGetter = jest.fn(() => () => VALID_RECIPIENT)
    const recipient = Object.create(null) as Record<string, unknown>
    Object.defineProperty(recipient, 'toString', {
      enumerable: true,
      configurable: true,
      get: toStringGetter
    })
    validReq.body.message!.recipients = [recipient as unknown as string]

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_RECIPIENT_KEY' })
    )
    expect(toStringGetter).not.toHaveBeenCalled()
  })

  it('Returns error if messageBox is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.messageBox = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_MESSAGEBOX'
      })
    )
  })

  it('Throws an error if messageBox is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.messageBox = 123 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_MESSAGEBOX',
        description: 'Invalid message box.'
      })
    )
  })

  it('Throws an error if the message body is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.body = 42 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_MESSAGE_BODY',
        description: 'Invalid message body.'
      })
    )
  })

  it('Returns error if message body is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.body = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INVALID_MESSAGE_BODY',
        description: 'Invalid message body.'
      })
    )
  })

  it('rejects recipient fan-out above the service limit', async () => {
    const recipient = validReq.body.message?.recipient as string
    validReq.body.message!.recipient = Array(MAX_MESSAGE_RECIPIENTS + 1).fill(recipient)

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_TOO_MANY_RECIPIENTS'
      })
    )
  })

  it('rejects message-box names above the byte limit', async () => {
    validReq.body.message!.messageBox = 'b'.repeat(MAX_MESSAGE_BOX_BYTES + 1)

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_MESSAGEBOX_TOO_LARGE'
      })
    )
  })

  it.each([' inbox', 'inbox ', 'in\nbox', 'in\u0085box'])(
    'rejects an ambiguous message-box name %#',
    async messageBox => {
      validReq.body.message!.messageBox = messageBox

      await sendMessage.func(validReq, mockRes as Response)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_INVALID_MESSAGEBOX' })
      )
    }
  )

  it('rejects message IDs above the byte limit', async () => {
    validReq.body.message!.messageId = 'i'.repeat(MAX_MESSAGE_ID_BYTES + 1)

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_INVALID_MESSAGEID'
      })
    )
  })

  it.each([' id', 'id ', 'id\n', 'id\u0085'])(
    'rejects an ambiguous message ID %#',
    async messageId => {
      validReq.body.message!.messageId = messageId

      await sendMessage.func(validReq, mockRes as Response)

      expect(mockRes.status).toHaveBeenCalledWith(400)
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ERR_INVALID_MESSAGEID' })
      )
    }
  )

  it('rejects message bodies above the byte limit before database work', async () => {
    validReq.body.message!.body = 'm'.repeat(MAX_MESSAGE_BODY_BYTES + 1)

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(413)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'ERR_MESSAGE_BODY_TOO_LARGE'
      })
    )
  })

  it.each([
    ['an empty message', '', false, 2],
    ['a small message below 1 KiB', 'Hello, world!', false, 5],
    ['a 2 KiB message', 'a'.repeat(2048), false, 8],
    ['priority mode', 'Hello', true, 5],
    ['a 5 KiB message', 'a'.repeat(5120), false, 17],
    ['an exact 1 KiB boundary', 'a'.repeat(1024), false, 5],
    ['one byte above 1 KiB', 'a'.repeat(1025), false, 8],
    ['a 10 KiB message', 'a'.repeat(10240), false, 32]
  ])('calculates the expected price for %s', (_case, message, priority, expectedPrice) => {
    expect(calculateMessagePrice(message, priority)).toBe(expectedPrice)
  })

  it('Returns error if messageId is missing', async () => {
    if (validReq.body.message !== undefined && validReq.body.message !== null) {
      validReq.body.message.messageId = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_MESSAGEID_REQUIRED',
        description: 'Missing messageId.'
      })
    )
  })

  it('Creates a messageBox when it does not exist', async () => {
    queryTracker.on('query', q => successfulStoreResponse(q))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
  })

  it('stores an accepted uncompressed recipient under its canonical identity', async () => {
    const bindings: unknown[] = []
    validReq.body.message!.recipient = UNCOMPRESSED_RECIPIENT
    queryTracker.on('query', q => {
      bindings.push(...(q.bindings ?? []))
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(bindings).toContain(VALID_RECIPIENT)
    expect(bindings).not.toContain(UNCOMPRESSED_RECIPIENT)
    expect(mockRes.status).toHaveBeenCalledWith(200)
  })

  it('uses the canonical authenticated sender for permission and storage authority', async () => {
    const bindings: unknown[] = []
    validReq.auth!.identityKey = UNCOMPRESSED_SENDER
    queryTracker.on('query', q => {
      bindings.push(...(q.bindings ?? []))
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(bindings).toContain(VALID_SENDER)
    expect(bindings).not.toContain(UNCOMPRESSED_SENDER)
    expect(mockRes.status).toHaveBeenCalledWith(200)
  })

  it('rejects an invalid authenticated sender identity', async () => {
    validReq.auth!.identityKey = 'not-a-public-key'

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_AUTH_IDENTITY' })
    )
  })

  it('rejects recipients that become duplicates after key canonicalization', async () => {
    validReq.body.message!.recipient = [VALID_RECIPIENT, UNCOMPRESSED_RECIPIENT]
    validReq.body.message!.messageId = ['batch-1', 'batch-2']

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_DUPLICATE_RECIPIENT' })
    )
  })

  it('fails closed when a persisted server delivery fee is invalid', async () => {
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: '1' }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(500)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', code: 'ERR_INTERNAL' })
    )
  })

  it('fails closed when a persisted recipient fee is invalid', async () => {
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([])
        return
      }
      if (q.sql.includes('message_permissions')) {
        q.response([{ recipient_fee: '1' }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(500)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', code: 'ERR_INTERNAL' })
    )
  })

  it('rejects a truthy non-boolean wallet payment verdict before storing the message', async () => {
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(),
      wallet: {
        internalizeAction: jest.fn(async () => ({ accepted: 'true' }))
      } as never
    })
    validReq.body.payment = deliveryPayment(1)
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 1 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(409)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
  })

  it('rejects an accepted but underpaid delivery output before wallet internalization', async () => {
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true }))
    }
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(),
      wallet: wallet as never
    })
    validReq.body.payment = deliveryPayment(1)
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 2 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INSUFFICIENT_PAYMENT' })
    )
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('requires the server delivery fee once per batch recipient', async () => {
    validReq.body.message!.recipient = [VALID_RECIPIENT, SECOND_RECIPIENT]
    validReq.body.message!.messageId = ['batch-1', 'batch-2']
    validReq.body.payment = deliveryPayment(1)
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 1 }])
        return
      }
      if (q.sql.includes('message_permissions')) {
        q.response([{ recipient_fee: 0 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INSUFFICIENT_PAYMENT' })
    )
  })

  it('rejects a previously claimed delivery payment after exact wallet acceptance', async () => {
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true }))
    }
    const claim = jest.fn(async () => false)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      wallet: wallet as never
    })
    validReq.body.payment = deliveryPayment(2)
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 1 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(409)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
    expect(claim).toHaveBeenCalledTimes(1)
    expect(wallet.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('rejects a merge-resume payment whose remittance is not bound to the sender', async () => {
    const wallet = {
      internalizeAction: jest.fn(async () => ({ accepted: true, isMerge: true }))
    }
    const claim = jest.fn(async () => true)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      wallet: wallet as never
    })
    const payment = deliveryPayment(2)!
    payment.outputs[0].paymentRemittance!.senderIdentityKey = VALID_RECIPIENT
    validReq.body.payment = payment
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 1 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_PAYMENT' })
    )
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('prices only a wallet-payment output on the declared Atomic BEEF transaction', () => {
    const exact = deliveryPayment(2)!
    expect(paymentOutputCoversDeliveryFee(exact, 2)).toBe(true)
    expect(paymentOutputCoversDeliveryFee(exact, 3)).toBe(false)
    expect(paymentOutputCoversDeliveryFee({ ...exact, tx: [...exact.tx, 0] }, 2)).toBe(false)
    expect(
      paymentOutputCoversDeliveryFee(
        { ...exact, outputs: [{ ...exact.outputs[0], protocol: 'basket insertion' }] },
        1
      )
    ).toBe(false)
  })

  it('rejects an underpaid recipient output before replay claim or message storage', async () => {
    const claim = jest.fn(async () => true)
    const verifyPaymentTransaction = jest.fn(async () => true)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: verifyPaymentTransaction
    })
    validReq.body.payment = await recipientPayment(1)
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 2))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INSUFFICIENT_RECIPIENT_PAYMENT' })
    )
    expect(verifyPaymentTransaction).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects a recipient output locked to a different identity', async () => {
    const claim = jest.fn(async () => true)
    const otherRecipient = (
      await new ProtoWallet(PrivateKey.fromRandom()).getPublicKey({ identityKey: true })
    ).publicKey
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: jest.fn(async () => true)
    })
    validReq.body.payment = await recipientPayment(2, VALID_RECIPIENT, otherRecipient)
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 2))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_RECIPIENT_PAYMENT' })
    )
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects reuse of one transaction output for multiple recipient fees', async () => {
    const recipientB = (
      await new ProtoWallet(PrivateKey.fromRandom()).getPublicKey({ identityKey: true })
    ).publicKey
    const payment = await recipientPayment(2)
    payment.outputs.push({ ...payment.outputs[0] })
    validReq.body.message!.recipient = [VALID_RECIPIENT, recipientB]
    validReq.body.message!.messageId = ['message-a', 'message-b']
    validReq.body.payment = payment
    const claim = jest.fn(async () => true)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: jest.fn(async () => true)
    })
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 1))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_RECIPIENT_PAYMENT' })
    )
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects an economically invalid recipient transaction before replay claim', async () => {
    const claim = jest.fn(async () => true)
    const verifyPaymentTransaction = jest.fn(async () => false)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: verifyPaymentTransaction
    })
    validReq.body.payment = await recipientPayment(2)
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 2))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_INVALID_RECIPIENT_PAYMENT' })
    )
    expect(verifyPaymentTransaction).toHaveBeenCalledWith(validReq.body.payment!.tx)
    expect(claim).not.toHaveBeenCalled()
  })

  it('rejects replay of a recipient-only payment transaction', async () => {
    const claim = jest.fn(async () => false)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: jest.fn(async () => true)
    })
    validReq.body.payment = await recipientPayment(2)
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 2))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(409)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ERR_PAYMENT_REPLAYED' })
    )
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it('accepts one valid and newly claimed recipient payment', async () => {
    const claim = jest.fn(async () => true)
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      paymentTransactionVerifier: jest.fn(async () => true)
    })
    validReq.body.payment = await recipientPayment(2)
    queryTracker.on('query', q => recipientFeeStoreResponse(q, 2))

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }))
    expect(claim).toHaveBeenCalledTimes(1)
  })

  it('rejects a duplicate message and rolls the transaction back', async () => {
    queryTracker.on('query', q => {
      if (q.sql.startsWith('insert into `messages`')) {
        const error = Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
        q.reject(error)
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_DUPLICATE_MESSAGE'
      })
    )
  })

  it('retries the complete storage transaction after a transient resource-lock deadlock', async () => {
    process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS = '1'
    process.env.MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS = '1'
    let resourceLockAttempts = 0
    queryTracker.on('query', q => {
      if (q.sql.startsWith('select') && q.sql.includes('from `message_resource_locks`')) {
        resourceLockAttempts += 1
        if (resourceLockAttempts === 1) {
          q.reject(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
          return
        }
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(resourceLockAttempts).toBe(2)
    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
  })

  it('rejects storage atomically when the shared sender quota is exhausted', async () => {
    process.env.MESSAGE_BOX_MAX_SENDER_MESSAGES = '1'
    queryTracker.on('query', q => {
      if (q.sql.includes('message_count') && q.sql.includes('where `sender` = ?')) {
        q.response([{ message_count: 1, body_bytes: 2 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(429)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_SENDER_QUOTA_EXCEEDED',
        resource: 'messages',
        limit: 1
      })
    )
  })

  it('does not internalize or claim a valid payment when quota validation rejects delivery', async () => {
    process.env.MESSAGE_BOX_MAX_SENDER_MESSAGES = '1'
    const claim = jest.fn(async () => true)
    const wallet = { internalizeAction: jest.fn(async () => ({ accepted: true })) }
    bindMessageBoxRuntime({
      knex: testKnex,
      paymentReplayStore: replayStore(claim),
      wallet: wallet as never
    })
    validReq.body.payment = deliveryPayment(2)
    queryTracker.on('query', q => {
      if (q.sql.includes('from `server_fees`')) {
        q.response([{ delivery_fee: 1 }])
        return
      }
      if (q.sql.includes('message_count') && q.sql.includes('where `sender` = ?')) {
        q.response([{ message_count: 1, body_bytes: 2 }])
        return
      }
      successfulStoreResponse(q)
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(429)
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('Returns internal error if unexpected error occurs', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {})
    jest.spyOn(console, 'log').mockImplementation(() => {})
    queryTracker.on('query', () => {
      throw new Error('Unexpected failure') // Simulating an unexpected database failure
    })

    await sendMessage.func(validReq, mockRes as Response)

    // Ensure the response status is set
    expect(mockRes.status).toHaveBeenCalledTimes(1)
    expect(mockRes.status).toHaveBeenCalledWith(500)

    // Ensure the response body is set
    expect(mockRes.json).toHaveBeenCalledTimes(1)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        code: 'ERR_INTERNAL'
      })
    )
  })

  it('creates a new messageBox when one does not exist for recipient', async () => {
    queryTracker.on('query', q => successfulStoreResponse(q))

    await sendMessage.func(validReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
  })
})
