import { PrivateKey, Transaction } from '@bsv/sdk'
import express, { type Express } from 'express'
import request from 'supertest'

import PaymailClient from '../../paymailClient/paymailClient.js'
import PaymailRouter from '../paymailRouter.js'
import SimpleP2pOrdinalReceiveRoute from '../paymailRoutes/receiveOrdinalTransaction.js'

const RAW_TRANSACTION =
  '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000'

describe('#Paymail Server - Simple Ordinal P2P Receive Transaction', () => {
  let app: Express
  let paymailClient: PaymailClient

  beforeEach(() => {
    app = express()
    paymailClient = new PaymailClient()
    const route = new SimpleP2pOrdinalReceiveRoute({
      domainLogicHandler: () => ({ txid: 'accepted-txid', note: 'accepted' }),
      verifySignature: true,
      paymailClient
    })
    app.use(new PaymailRouter({ baseUrl: 'http://localhost:3000', routes: [route] }).getRouter())
  })

  it('accepts a correctly signed ordinal transaction at the protocol endpoint', async () => {
    const privateKey = PrivateKey.fromRandom()
    const transaction = Transaction.fromHex(RAW_TRANSACTION)
    jest.spyOn(paymailClient, 'verifyPublicKey').mockResolvedValue({
      handle: 'halfinny@vistamail.org',
      pubkey: privateKey.toPublicKey().toString(),
      match: true
    })

    const response = await request(app)
      .post('/receive-ordinal-tx/satoshi@bsv.org')
      .send({
        hex: transaction.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature: paymailClient.createP2PSignature(transaction.id('hex'), privateKey),
          note: 'ordinal'
        },
        reference: 'ordinal-reference'
      })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ txid: 'accepted-txid', note: 'accepted' })
  })

  it('rejects malformed transactions before signature or ownership work', async () => {
    const verifyPublicKey = jest.spyOn(paymailClient, 'verifyPublicKey')
    const response = await request(app)
      .post('/receive-ordinal-tx/satoshi@bsv.org')
      .send({
        hex: 'not-a-transaction',
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: '02abc',
          signature: 'invalid'
        },
        reference: 'ordinal-reference'
      })

    expect(response.statusCode).toBe(400)
    expect(response.text).toContain('Invalid body')
    expect(verifyPublicKey).not.toHaveBeenCalled()
  })

  it('rejects malformed signatures before an outbound ownership lookup', async () => {
    const privateKey = PrivateKey.fromRandom()
    const transaction = Transaction.fromHex(RAW_TRANSACTION)
    const verifyPublicKey = jest.spyOn(paymailClient, 'verifyPublicKey')
    const response = await request(app)
      .post('/receive-ordinal-tx/satoshi@bsv.org')
      .send({
        hex: transaction.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature: 'invalid'
        },
        reference: 'ordinal-reference'
      })

    expect(response.statusCode).toBe(400)
    expect(response.text).toBe('Invalid Compact Signature')
    expect(verifyPublicKey).not.toHaveBeenCalled()
  })

  it('rejects a valid signature when Paymail ownership does not match', async () => {
    const privateKey = PrivateKey.fromRandom()
    const transaction = Transaction.fromHex(RAW_TRANSACTION)
    jest.spyOn(paymailClient, 'verifyPublicKey').mockResolvedValue({
      handle: 'halfinny@vistamail.org',
      pubkey: privateKey.toPublicKey().toString(),
      match: false
    })
    const response = await request(app)
      .post('/receive-ordinal-tx/satoshi@bsv.org')
      .send({
        hex: transaction.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature: paymailClient.createP2PSignature(transaction.id('hex'), privateKey)
        },
        reference: 'ordinal-reference'
      })

    expect(response.statusCode).toBe(400)
    expect(response.text).toBe('Invalid Public Key for sender')
  })

  it('supports an explicit endpoint with signature verification disabled', async () => {
    const unsignedApp = express()
    const route = new SimpleP2pOrdinalReceiveRoute({
      endpoint: '/custom-ordinal/:paymail',
      domainLogicHandler: () => ({ txid: 'unsigned-txid' }),
      verifySignature: false,
      paymailClient
    })
    unsignedApp.use(
      new PaymailRouter({ baseUrl: 'http://localhost:3000', routes: [route] }).getRouter()
    )

    const response = await request(unsignedApp).post('/custom-ordinal/satoshi@bsv.org').send({
      hex: RAW_TRANSACTION,
      reference: 'ordinal-reference'
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toEqual({ txid: 'unsigned-txid', note: '' })
  })
})
