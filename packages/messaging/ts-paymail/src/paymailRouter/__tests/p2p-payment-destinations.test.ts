import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import P2pPaymentDestinationRoute from '../paymailRoutes/p2pPaymentDestinationRoute.js'

describe('#Paymail Server - P2P Payment Destinations', () => {
  let app: Express

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'
    const routes = [
      new P2pPaymentDestinationRoute({
        domainLogicHandler: (params, body) => {
          void params
          const { satoshis } = body as { satoshis: number }
          return {
            outputs: [
              {
                script: '76a914f32281faa74e2ac037493f7a3cd317e8f5e9673688ac',
                satoshis
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

  it('should get public profile for user paymail', async () => {
    const response = await request(app).post('/p2p-payment-destination/satoshi@bsv.org').send({
      satoshis: 1000
    })
    expect(response.statusCode).toBe(200)
    expect(response.body.outputs[0].script).toEqual(
      '76a914f32281faa74e2ac037493f7a3cd317e8f5e9673688ac'
    )
    expect(response.body.outputs[0].satoshis).toEqual(1000)
    expect(response.body.reference).toEqual('someref')
  })

  it('should return 400 if satoshis is not provided', async () => {
    const response = await request(app).post('/p2p-payment-destination/satoshi@bsv.org').send({
      BSV: 1
    })
    expect(response.statusCode).toBe(400)
    expect(response.text).toEqual('Invalid body: "satoshis" is required')
  })

  it.each([0, -1, 1.5])('should reject invalid satoshi amount %s', async satoshis => {
    const response = await request(app)
      .post('/p2p-payment-destination/satoshi@bsv.org')
      .send({ satoshis })

    expect(response.statusCode).toBe(400)
  })
})
