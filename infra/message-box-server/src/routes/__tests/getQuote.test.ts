import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import type { Response } from 'express'
import getQuote, {
  MAX_QUOTE_RECIPIENTS,
  type GetQuoteRequest
} from '../permissions/getQuote.js'

function createResponse (): jest.Mocked<Response> {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  } as unknown as jest.Mocked<Response>
}

describe('GET /permissions/quote workload limits', () => {
  let res: jest.Mocked<Response>

  beforeEach(() => {
    res = createResponse()
  })

  test('rejects an oversized recipient list before validating its entries', async () => {
    const recipients = Array.from(
      { length: MAX_QUOTE_RECIPIENTS + 1 },
      (_, index) => `deliberately-invalid-key-${index}`
    )
    const req = {
      auth: { identityKey: 'authenticated-sender' },
      query: { recipient: recipients, messageBox: 'inbox' }
    } as unknown as GetQuoteRequest

    await getQuote.func(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_TOO_MANY_RECIPIENTS',
      description: `A quote may include at most ${MAX_QUOTE_RECIPIENTS} recipients.`
    })
  })
})
