/* eslint-env jest */
// Set up environment variables
process.env.MIN_HOSTING_MINUTES = '10'

const quote = require('../quote').default
const getPriceForFile = require(
  '../../utils/getPriceForFile'
).default
const { log } = require('../../logger')

const {
  MIN_HOSTING_MINUTES
} = process.env

jest.mock('../../utils/getPriceForFile')
jest.mock('../../logger', () => ({
  log: {
    error: jest.fn()
  }
}))

const mockRes = {}
mockRes.status = jest.fn(() => mockRes)
mockRes.json = jest.fn(() => mockRes)
let validReq

describe('quote', () => {
  beforeEach(() => {
    getPriceForFile.mockReturnValue(1024)
    validReq = {
      body: {
        fileSize: 65000,
        retentionPeriod: 525600
      }
    }
  })
  afterEach(() => {
    jest.clearAllMocks()
  })
  it('Returns error if fileSize missing', async () => {
    delete validReq.body.fileSize
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_NO_SIZE'
    }))
  })
  it('Returns error if retentionPeriod missing', async () => {
    delete validReq.body.retentionPeriod
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_NO_RETENTION_PERIOD'
    }))
  })
  it('Returns error if fileSize is not an int', async () => {
    validReq.body.fileSize = -3.14
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_SIZE'
    }))
  })
  it('Returns error if retentionPeriod is invalid', async () => {
    validReq.body.retentionPeriod = 525600.1
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_RETENTION_PERIOD'
    }))
  })
  it('Returns error if retentionPeriod is under MIN_HOSTING_MINUTES', async () => {
    validReq.body.retentionPeriod = MIN_HOSTING_MINUTES - 1
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_RETENTION_PERIOD'
    }))
  })
  it('Returns error if retentionPeriod is over 130 years', async () => {
    validReq.body.retentionPeriod = 525600 * 140 // 140 years
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 'error',
      code: 'ERR_INVALID_RETENTION_PERIOD'
    }))
  })
  it('Call getPriceForFile with correct parameters', async () => {
    await quote.func(validReq, mockRes)
    expect(getPriceForFile).toHaveBeenCalledWith({
      fileSize: 65000,
      retentionPeriod: 525600
    })
  })
  it('Returns successful response', async () => {
    await quote.func(validReq, mockRes)
    expect(mockRes.status).toHaveBeenCalledWith(200)
    expect(mockRes.json).toHaveBeenCalledWith({
      quote: 1024
    })
  })
  it('returns a sanitized internal error for unknown failures', async () => {
    getPriceForFile.mockImplementation(() => {
      throw new Error('Failed')
    })
    await quote.func(validReq, mockRes)
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'quote.handle',
        outcome: 'error',
        err: expect.any(Error)
      }),
      'Quote handler failed'
    )
    expect(mockRes.status).toHaveBeenCalledWith(500)
    expect(mockRes.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error has occurred.'
    })
  })
})
