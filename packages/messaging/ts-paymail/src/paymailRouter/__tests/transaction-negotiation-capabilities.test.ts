import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import TransactionNegotiationCapabilitiesRoute from '../paymailRoutes/negotiationCapability.js'
describe('#Paymail Server - Transaction Negotiation Capabilities', () => {
  let app: Express

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'
    const routes = [
      new TransactionNegotiationCapabilitiesRoute({
        send_disabled: false,
        auto_send_response: false,
        receive: true,
        three_step_exchange: true,
        four_step_exchange: false,
        auto_exchange_response: true
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should get transaction negotiation capabilities', async () => {
    const response = await request(app).get(
      '/transaction-negotiation-capabilities/satoshi@vistamail.org'
    )
    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({
      send_disabled: false,
      auto_send_response: false,
      receive: true,
      three_step_exchange: true,
      four_step_exchange: false,
      auto_exchange_response: true
    })
  })
})
