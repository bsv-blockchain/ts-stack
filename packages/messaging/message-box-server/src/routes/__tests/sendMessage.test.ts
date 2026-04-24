/* eslint-env jest */
import sendMessage, { calculateMessagePrice, Message, SendMessageRequest } from '../sendMessage.js'
import mockKnex from 'mock-knex'
import { Response } from 'express'
import type { Tracker } from 'mock-knex'
import { Logger } from '../../utils/logger.js'
import axios from 'axios'
import type { AxiosInstance as AxiosInstanceType } from 'axios'
import AxiosMockAdapter from 'axios-mock-adapter'

global.fetch = jest.fn()

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
let validMessageBox: { messageBoxId: number, type: string }

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

  afterAll(() => {
    mockKnex.unmock(knex)
  })

  it('Throws an error if message is missing', async () => {
    validReq.body = {} // Ensure body exists, but message is missing

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_MESSAGE_REQUIRED',
      description: 'Please provide a valid message to send!'
    }))
  })

  it('Throws an error if message is not an object', async () => {
    validReq.body.message = 'My message to send' as unknown as Message

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGEBOX',
      description: 'Invalid message box.'
    }))
  })

  it('Throws an error if recipient is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.recipient = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_RECIPIENT_REQUIRED',
      description: 'Missing recipient(s). Provide "recipient" or "recipients".'
    }))
  })

  it('Throws an error if recipient is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.recipient = 123 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_RECIPIENT_KEY'
    }))
  })

  it('Returns error if messageBox is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.messageBox = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGEBOX'
    }))
  })

  it('Throws an error if messageBox is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.messageBox = 123 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGEBOX',
      description: 'Invalid message box.'
    }))
  })

  it('Throws an error if the message body is not a string', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.body = 42 as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGE_BODY',
      description: 'Invalid message body.'
    }))
  })

  it('Returns error if message body is missing', async () => {
    if (validReq.body.message !== null && validReq.body.message !== undefined) {
      validReq.body.message.body = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGE_BODY',
      description: 'Invalid message body.'
    }))
  })

  it('Returns base price for an empty message', () => {
    const price = calculateMessagePrice('')
    expect(price).toBe(2) // Base price only
  })

  it('Calculates price for a small message (below 1KB)', () => {
    const price = calculateMessagePrice('Hello, world!')
    expect(price).toBe(5) // Base price only
  })

  it('Calculates price for a 2KB message', () => {
    const message = 'a'.repeat(2048) // 2KB
    const price = calculateMessagePrice(message)
    expect(price).toBe(8) // Base price + 2KB
  })

  it('Adds priority fee when enabled', () => {
    const price = calculateMessagePrice('Hello', true)
    expect(price).toBe(5) // Base price
  })

  it('Handles large messages (5KB)', () => {
    const message = 'a'.repeat(5120) // 5KB
    const price = calculateMessagePrice(message)
    expect(price).toBe(17) // Base price + 5KB
  })

  it('Handles edge case of exactly 1KB message', () => {
    const message = 'a'.repeat(1024) // Exactly 1KB
    const price = calculateMessagePrice(message)
    expect(price).toBe(5) // Base price + 1KB
  })

  it('Handles edge case of 1KB + 1 byte message', () => {
    const message = 'a'.repeat(1025) // 1KB + 1 byte
    const price = calculateMessagePrice(message)
    expect(price).toBe(8) // Rounded up to 2KB
  })

  it('Handles messages larger than 10KB', () => {
    const message = 'a'.repeat(10240) // 10KB
    const price = calculateMessagePrice(message)
    expect(price).toBe(32) // Base price + 10KB
  })

  it('Returns error if messageId is missing', async () => {
    if (validReq.body.message !== undefined && validReq.body.message !== null) {
      validReq.body.message.messageId = undefined as unknown as string
    }

    await sendMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_MESSAGEID_REQUIRED',
      description: 'Missing messageId.'
    }))
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
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success'
    }))
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
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success'
    }))
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
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INTERNAL'
    }))
  })


  it('creates a new messageBox when one does not exist for recipient', async () => {
    queryTracker.on('query', (q, step) => {
      if (step === 1) q.response(undefined) // messageBox not found
      else if (step === 2) q.response(1) // messageBox insert
      else if (step === 3) q.response({ messageBoxId: 42 }) // get messageBoxId for message insert
      else if (step === 4) q.response(1) // insert message
      else q.response([])
    })

    await sendMessage.func(validReq, mockRes)

    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success'
    }))
  })
})
