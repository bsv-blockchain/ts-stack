import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import type { Response } from 'express'
import type { Knex } from 'knex'
import getQuote, {
  QUOTE_CONCURRENCY,
  MAX_QUOTE_RECIPIENTS,
  type GetQuoteRequest
} from '../permissions/getQuote.js'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'

const VALID_RECIPIENT = '028d37b941208cd6b8a4c28288eda5f2f16c2b3ab0fcb6d13c18b47fe37b971fc1'

function createResponse(): jest.Mocked<Response> {
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

  test('bounds database concurrency while preserving ordered quote results', async () => {
    let activeRecipientQueries = 0
    let maximumRecipientQueries = 0

    const knex = ((table: string) => {
      const query = {
        where: () => query,
        select: () => query,
        first: async () => {
          if (table === 'server_fees') return { delivery_fee: 2 }
          activeRecipientQueries += 1
          maximumRecipientQueries = Math.max(maximumRecipientQueries, activeRecipientQueries)
          await new Promise<void>(resolve => setImmediate(resolve))
          activeRecipientQueries -= 1
          return { recipient_fee: 3 }
        }
      }
      return query
    }) as unknown as Knex
    bindMessageBoxRuntime({ knex })

    const recipients = Array.from({ length: QUOTE_CONCURRENCY + 2 }, () => VALID_RECIPIENT)
    const req = {
      auth: { identityKey: VALID_RECIPIENT },
      query: { recipient: recipients, messageBox: 'inbox' }
    } as unknown as GetQuoteRequest

    await getQuote.func(req, res)

    const payload = res.json.mock.calls.at(-1)?.[0] as {
      quotesByRecipient: unknown[]
      totals: { deliveryFees: number; recipientFees: number }
    }
    expect(res.status).toHaveBeenCalledWith(200)
    expect(maximumRecipientQueries).toBe(QUOTE_CONCURRENCY)
    expect(payload.quotesByRecipient).toHaveLength(recipients.length)
    expect(payload.totals).toMatchObject({
      deliveryFees: recipients.length * 2,
      recipientFees: recipients.length * 3
    })
  })

  test('fails closed when permission storage is unavailable', async () => {
    const knex = (() => {
      const query = {
        where: () => query,
        select: () => query,
        first: async () => {
          throw new Error('database unavailable')
        }
      }
      return query
    }) as unknown as Knex
    bindMessageBoxRuntime({ knex })

    const req = {
      auth: { identityKey: VALID_RECIPIENT },
      query: { recipient: VALID_RECIPIENT, messageBox: 'inbox' }
    } as unknown as GetQuoteRequest

    await getQuote.func(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_INTERNAL',
      description: 'An internal error has occurred.'
    })
  })
})
