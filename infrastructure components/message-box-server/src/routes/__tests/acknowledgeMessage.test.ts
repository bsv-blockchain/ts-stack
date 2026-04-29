/* eslint-env jest */
import acknowledgeMessage, { AcknowledgeRequest } from '../acknowledgeMessage.js'
import mockKnex, { Tracker } from 'mock-knex'
import { Response } from 'express'

const knex = acknowledgeMessage.knex
let queryTracker: Tracker

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

let validReq: AcknowledgeRequest

describe('acknowledgeMessage', () => {
  beforeAll(() => {
    (mockKnex as any).mock(knex)
  })

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => { })

    queryTracker = (mockKnex as any).getTracker() as Tracker
    queryTracker.install()

    validReq = {
      auth: {
        identityKey: 'mockIdKey'
      },
      body: {
        messageIds: ['123']
      },
      get: jest.fn(),
      header: jest.fn()
    } as unknown as AcknowledgeRequest
  })

  afterEach(() => {
    jest.clearAllMocks()

    if (queryTracker !== null && queryTracker !== undefined) {
      queryTracker.uninstall()
    }
  })

  afterAll(() => {
    (mockKnex as any).unmock(knex)
  })

  it('Throws an error if messageId is missing', async () => {
    delete validReq.body.messageIds
    await acknowledgeMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_MESSAGE_ID_REQUIRED'
    }))
  })

  it('Throws an error if messageIds is not an Array', async () => {
    validReq.body.messageIds = '24' as unknown as string[]

    await acknowledgeMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_MESSAGE_ID',
      description: 'Message IDs must be formatted as an array of strings!'
    }))
  }, 7000)

  it('Deletes a message', async () => {
    queryTracker.on('query', (q, s) => {
      if (s === 1) {
        expect(q.method).toEqual('del')
        expect(q.sql).toEqual(
          'delete from `messages` where `recipient` = ? and `messageId` in (?)'
        )
        expect(q.bindings).toEqual([
          'mockIdKey',
          '123'
        ])
        q.response(true)
      } else {
        q.response([])
      }
    })

    await acknowledgeMessage.func(validReq, mockRes as Response)
    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'success'
    }))
  })

  it('Throws an error if deletion fails', async () => {
    queryTracker.on('query', (q, step) => {
      if (step === 1) {
        expect(q.method).toEqual('del')
        expect(q.sql).toEqual('delete from `messages` where `recipient` = ? and `messageId` in (?)')
        expect(q.bindings).toEqual(['mockIdKey', '123'])

        q.response(0) // Simulate deletion failure
      } else {
        q.response([]) // Prevent test from hanging due to unhandled second query
      }
    })

    await acknowledgeMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_ACKNOWLEDGMENT',
      description: 'Message not found!'
    }))
  }, 7000)

  it('Throws unknown errors', async () => {
    queryTracker.on('query', () => {
      throw new Error('Failed')
    })

    await acknowledgeMessage.func(validReq, mockRes as Response)

    expect(mockRes.status).toHaveBeenCalledWith(500)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INTERNAL_ERROR',
      description: 'An internal error has occurred while acknowledging the message'
    }))
  })
})
