import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import OrdinalP2pPaymentDestinationRoute from '../paymailRoutes/simpleP2pOrdinalDestinationsRoute.js'

describe('#Paymail Server - Simple Ordinal P2P Payment Destinations', () => {
  let app: Express

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'
    const routes = [
      new OrdinalP2pPaymentDestinationRoute({
        domainLogicHandler: () => {
          return {
            outputs: [
              {
                script: '76a914f32281faa74e2ac037493f7a3cd317e8f5e9673688ac'
              }
            ],
            reference: 'someref'
          }
        }
      })
    ]
    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should get ordinal p2p destination', async () => {
    const response = await request(app)
      .post('/ordinal-p2p-payment-destination/satoshi@bsv.org')
      .send({
        ordinals: 1
      })
    expect(response.statusCode).toBe(200)
    expect(response.body.outputs[0].script).toEqual(
      '76a914f32281faa74e2ac037493f7a3cd317e8f5e9673688ac'
    )
    expect(response.body.reference).toEqual('someref')
  })

  it('should return 400 if ordinals is not provided', async () => {
    const response = await request(app)
      .post('/ordinal-p2p-payment-destination/satoshi@bsv.org')
      .send({
        BSV: 1
      })
    expect(response.statusCode).toBe(400)
    expect(response.text).toEqual('Invalid body: "ordinals" is required')
  })

  it.each([0, -1, 1.5])('should reject invalid ordinal count %s', async ordinals => {
    const response = await request(app)
      .post('/ordinal-p2p-payment-destination/satoshi@bsv.org')
      .send({ ordinals })

    expect(response.statusCode).toBe(400)
  })
})
