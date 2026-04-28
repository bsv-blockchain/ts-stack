import request from 'supertest'
import express from 'express'
import PaymailRouter from '../../../dist/cjs/src/paymailRouter/paymailRouter.js'
import TransactionNegotiationCapabilitiesRoute from '../../../dist/cjs/src/paymailRouter/paymailRoutes/transactionNegotiationCapabilities.js'

describe('#Paymail Server - Transaction Negotiation', () => {
  let app

  beforeAll(() => {
    app = express()
    app.use(express.json())
    const baseUrl = 'http://localhost:3000'

    const domainLogicHandler = async (name, domain, body) => {
      // Implement your domain logic here, and return the appropriate response
      return {} // Placeholder response
    }

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
})
