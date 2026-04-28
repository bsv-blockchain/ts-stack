import request from 'supertest'
import express from 'express'
import PaymailRouter from '../../../dist/cjs/src/paymailRouter/paymailRouter.js'
import OrdinalP2pPaymentDestinationRoute from '../../../dist/cjs/src/paymailRouter/paymailRoutes/simpleP2pOrdinalDestinationsRoute.js'
import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient.js'

describe('#Paymail Server - Simple Ordinal P2P Payment Destinations', () => {
  let app
  let client: PaymailClient

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'
    client = new PaymailClient(undefined, undefined, undefined)
    const routes = [
      new OrdinalP2pPaymentDestinationRoute({
        domainLogicHandler: (name, domain, body) => {
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
    const response = await request(app).post('/ordinal-p2p-payment-destination/satoshi@bsv.org').send({
      ordinals: 1
    })
    expect(response.statusCode).toBe(200)
    expect(response.body.outputs[0].script).toEqual('76a914f32281faa74e2ac037493f7a3cd317e8f5e9673688ac')
    expect(response.body.reference).toEqual('someref')
  })

  it('should return 400 if ordinals is not provided', async () => {
    const response = await request(app).post('/ordinal-p2p-payment-destination/satoshi@bsv.org').send({
      BSV: 1
    })
    expect(response.statusCode).toBe(400)
    expect(response.error.text).toEqual('Invalid body: "ordinals" is required')
  })
})
