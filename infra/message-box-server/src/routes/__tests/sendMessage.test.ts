/* eslint-env jest */
import sendMessage, {
  calculateMessagePrice,
  MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_BOX_BYTES,
  MAX_MESSAGE_ID_BYTES,
  MAX_MESSAGE_RECIPIENTS,
  Message,
  SendMessageRequest
} from '../sendMessage.js'
import mockKnex from 'mock-knex'
import { Response } from 'express'
import type { Tracker } from 'mock-knex'
import knexLib from 'knex'
import knexConfig from '../../../knexfile.js'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'
import { Logger } from '../../utils/logger.js'
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
let validMessageBox: { messageBoxId: number; type: string }

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

    jest.spyOn(console, 'error').mockImplementation((...args) => originalError(...args))
    jest.spyOn(console, 'log').mockImplementation((...args) => originalLog(...args))
    jest.spyOn(console, 'warn').mockImplementation((...args) => originalWarn(...args))

    const instance: AxiosInstanceType = axios
    // eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore
    axiosMock = new AxiosMockAdapter(instance)

    queryTracker = mockKnex.getTracker()
    queryTracker.install()

    // Mock Data
    validRes = {
      status: 'success'
    }
    validMessageBox = {
      messageBoxId: 42,
      type: 'payment_inbox'
    }

    validReq = {
      auth: {
        identityKey: 'mockIdKey'
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
    queryTracker.on('query', (q, step: number) => {
      if (step === 1) {
        q.response(0) // Simulate that the messageBox does not exist
      } else if (step === 2) {
        q.response([validMessageBox]) // Simulate messageBox being inserted
      } else if (step === 3) {
        q.response([validMessageBox]) // Simulate finding a valid messageBoxId
      } else {
        q.response([]) // Default response
      }
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
  })

  it('Silently ignores duplicate messages via onConflict().ignore()', async () => {
    queryTracker.on('query', (q, step: number) => {
      if (step === 1) {
        q.response({ messageBoxId: 42, type: 'payment_inbox' }) // messageBox exists
      } else if (step === 2) {
        q.response({ messageBoxId: 42 }) // get messageBoxId for insert
      } else if (step === 3) {
        q.response(0) // insert with onConflict().ignore() returns 0 rows affected
      } else {
        q.response([])
      }
    })

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
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
    queryTracker.on('query', (q, step) => {
      if (step === 1)
        q.response(undefined) // messageBox not found
      else if (step === 2)
        q.response(1) // messageBox insert
      else if (step === 3)
        q.response({ messageBoxId: 42 }) // get messageBoxId for message insert
      else if (step === 4)
        q.response(1) // insert message
      else q.response([])
    })

    await sendMessage.func(validReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success'
      })
    )
  })
})
