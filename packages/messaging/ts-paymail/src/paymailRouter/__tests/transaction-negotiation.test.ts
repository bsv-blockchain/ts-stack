import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import TransactionNegotiationCapabilitiesRoute from '../paymailRoutes/transactionNegotiationCapabilities.js'

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
    const postData = {
      thread_id: 'UniqueID',
      expanded_tx: {
        tx: 'hexstring',
        ancestors: [{ tx: 'hexstring' }]
      },
      expiry: 1234567890,
      timestamp: 1234567890,
      reply_to: { handle: 'satoshi@vistamail.org' }
    }

    const response = await request(app)
      .post('/transaction-negotiation/satoshi@vistamail.org')
      .send(postData)

    expect(response.statusCode).toBe(202)
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
      expanded_tx: { tx: 'hexstring' },
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
