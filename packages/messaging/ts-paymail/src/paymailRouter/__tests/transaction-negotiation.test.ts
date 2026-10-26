import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import TransactionNegotiationCapabilitiesRoute from '../paymailRoutes/transactionNegotiationCapabilities.js'
import { Script, Transaction } from '@bsv/sdk'

const NEGOTIATION_TX = new Transaction(
  1,
  [],
  [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
  0
).toHex()

function validNegotiation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    thread_id: 'UniqueID',
    fees: [{ feeType: 'standard', satoshis: 1, bytes: 1 }],
    expanded_tx: {
      tx: NEGOTIATION_TX,
      ancestors: [{ tx: NEGOTIATION_TX }],
      spent_outputs: [{ value: 1, locking_script: '51' }]
    },
    expiry: 1234567890,
    timestamp: 1234567890,
    reply_to: { handle: 'satoshi@vistamail.org' },
    ...overrides
  }
}

describe('#Paymail Server - Transaction Negotiation', () => {
  let app: Express

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'

    const domainLogicHandler = () => ({})

    const routes = [
      new TransactionNegotiationCapabilitiesRoute({
        domainLogicHandler
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should process valid transaction negotiation request', async () => {
    const postData = validNegotiation()

    const response = await request(app)
      .post('/transaction-negotiation/satoshi@vistamail.org')
      .send(postData)

    expect(response.statusCode).toBe(202)
  })

  it.each([
    'not a URL',
    'http://peer.example/channel',
    'https://user:secret@peer.example/channel',
    'https://peer.example/channel#fragment',
    'https://peer.local/channel',
    'https://peer.localhost/channel',
    'https://localhost./channel',
    'https://peer.localhost./channel',
    'https://127.0.0.1/channel',
    'https://[::1]/channel',
    'https://intranet/channel'
  ])('rejects an unsafe reply peer channel before domain logic: %s', async peer_channel => {
    const response = await request(app)
      .post('/transaction-negotiation/satoshi@vistamail.org')
      .send(
        validNegotiation({
          reply_to: { handle: 'satoshi@vistamail.org', peer_channel }
        })
      )

    expect(response.statusCode).toBe(400)
  })

  it.each([
    validNegotiation({ reply_to: { handle: 'not-a-paymail' } }),
    validNegotiation({ fees: [{ feeType: 'standard', satoshis: -1, bytes: 1 }] }),
    validNegotiation({ fees: [{ feeType: 'unknown', satoshis: 1, bytes: 1 }] }),
    validNegotiation({ fees: [{ feeType: 'data', satoshis: 1, bytes: 0 }] }),
    validNegotiation({
      expanded_tx: { tx: '00', ancestors: [], spent_outputs: [] }
    }),
    validNegotiation({
      expanded_tx: { tx: NEGOTIATION_TX, ancestors: [{ tx: '00' }], spent_outputs: [] }
    }),
    validNegotiation({
      expanded_tx: {
        tx: NEGOTIATION_TX,
        ancestors: [],
        spent_outputs: [{ value: -1, locking_script: '51' }]
      }
    }),
    validNegotiation({
      expanded_tx: {
        tx: NEGOTIATION_TX,
        ancestors: [],
        spent_outputs: [{ value: 1, locking_script: '5' }]
      }
    }),
    validNegotiation({ expiry: -1 }),
    validNegotiation({ timestamp: 1.5 })
  ])('rejects semantically invalid negotiation data', async postData => {
    const response = await request(app)
      .post('/transaction-negotiation/satoshi@vistamail.org')
      .send(postData)

    expect(response.statusCode).toBe(400)
  })

  it.each([
    {
      thread_id: 'missing-expanded',
      expiry: 1234567890,
      timestamp: 1234567890,
      reply_to: { handle: 'satoshi@vistamail.org' }
    },
    {
      thread_id: 'missing-reply',
      expanded_tx: { tx: NEGOTIATION_TX },
      expiry: 1234567890,
      timestamp: 1234567890
    }
  ])('should reject incomplete transaction negotiation requests', async postData => {
    const response = await request(app)
      .post('/transaction-negotiation/satoshi@vistamail.org')
      .send(postData)

    expect(response.statusCode).toBe(400)
  })
})
