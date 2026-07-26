import request from 'supertest'
import express, { type Express } from 'express'
import PaymailRouter from '../paymailRouter.js'
import ReceiveTransactionRoute from '../paymailRoutes/receiveTransaction.js'
import PaymailClient from '../../paymailClient/paymailClient.js'
import { ECDSA, PrivateKey, Transaction } from '@bsv/sdk'

describe('#Paymail Server - P2P Receive Transaction', () => {
  let app: Express
  let paymailClient: PaymailClient

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost:3000'
    paymailClient = new PaymailClient()

    const routes = [
      new ReceiveTransactionRoute({
        domainLogicHandler: () => {
          return {
            txid: '5878f6efcb1aa3be389510ae2ff10d0368976bf867e8442b751908f19024f8dd'
          }
        },
        verifySignature: true,
        paymailClient
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, routes })
    app.use(paymailRouter.getRouter())
  })
  it('should receive transaction', async () => {
    const privateKey = PrivateKey.fromRandom()
    const tx = Transaction.fromHex(
      '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000'
    )
    jest.spyOn(paymailClient, 'verifyPublicKey').mockResolvedValue({
      handle: 'halfinny@vistamail.org',
      pubkey: privateKey.toPublicKey().toString(),
      match: true
    })
    const signature = paymailClient.createP2PSignature(tx.id('hex'), privateKey)
    const ecdsaVerify = jest.spyOn(ECDSA, 'verify').mockReturnValue(false)
    const invalidSignatureResponse = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: tx.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature
        },
        reference: 'someRefId'
      })
    ecdsaVerify.mockRestore()

    expect(invalidSignatureResponse.statusCode).toBe(400)
    expect(invalidSignatureResponse.text).toEqual('Invalid Signature')

    const response = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: tx.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature,
          note: 'gm.'
        },
        reference: 'someRefId'
      })
    expect(response.statusCode).toBe(200)
    expect(response.body.txid).toEqual(
      '5878f6efcb1aa3be389510ae2ff10d0368976bf867e8442b751908f19024f8dd'
    )
  })

  it('should reject with invalid signature', async () => {
    const privateKey = PrivateKey.fromRandom()
    const verifyPublicKey = jest.spyOn(paymailClient, 'verifyPublicKey').mockResolvedValue({
      handle: 'halfinny@vistamail.org',
      pubkey: privateKey.toPublicKey().toString(),
      match: true
    })
    verifyPublicKey.mockClear()
    const tx = Transaction.fromHex(
      '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000'
    )
    const response = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: tx.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature: 'invalid signature',
          note: 'gm.'
        },
        reference: 'someRefId'
      })
    expect(response.statusCode).toBe(400)
    expect(response.text).toEqual('Invalid Compact Signature')
    expect(verifyPublicKey).not.toHaveBeenCalled()

    const otherPrivateKey = PrivateKey.fromRandom()
    const mismatchResponse = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: tx.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: otherPrivateKey.toPublicKey().toString(),
          signature: paymailClient.createP2PSignature(tx.id('hex'), privateKey)
        },
        reference: 'someRefId'
      })
    expect(mismatchResponse.statusCode).toBe(400)
    expect(mismatchResponse.text).toEqual('PubKey does not match signature')
    expect(verifyPublicKey).not.toHaveBeenCalled()
  })

  it('should reject with invalid public key', async () => {
    const privateKey = PrivateKey.fromRandom()
    jest.spyOn(paymailClient, 'verifyPublicKey').mockResolvedValue({
      handle: 'halfinny@vistamail.org',
      pubkey: privateKey.toPublicKey().toString(),
      match: false
    })
    const tx = Transaction.fromHex(
      '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000'
    )
    const signature = paymailClient.createP2PSignature(tx.id('hex'), privateKey)
    const response = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: tx.toHex(),
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: privateKey.toPublicKey().toString(),
          signature,
          note: 'gm.'
        },
        reference: 'someRefId'
      })
    expect(response.statusCode).toBe(400)
    expect(response.text).toEqual('Invalid Public Key for sender')
  })

  it('validates request shape before transaction processing', async () => {
    const response = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({ reference: 'someRefId' })

    expect(response.statusCode).toBe(400)
    expect(response.text).toContain('"hex" is required')
  })

  it('accepts valid unsigned transactions when signature verification is disabled', async () => {
    const unsignedApp = express()
    const tx = Transaction.fromHex(
      '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000'
    )
    const route = new ReceiveTransactionRoute({
      domainLogicHandler: () => ({ txid: tx.id('hex') }),
      verifySignature: false,
      paymailClient
    })
    unsignedApp.use(
      new PaymailRouter({ baseUrl: 'http://localhost:3000', routes: [route] }).getRouter()
    )

    const response = await request(unsignedApp)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({ hex: tx.toHex(), reference: 'someRefId' })

    expect(response.statusCode).toBe(200)
    expect(response.body.txid).toBe(tx.id('hex'))
  })

  it('normalizes non-Error transaction parser failures', async () => {
    const parser = jest.spyOn(Transaction, 'fromHex').mockImplementationOnce(() => {
      throw 'parser failed'
    })

    const response = await request(app)
      .post('/receive-transaction/satoshi@bsv.org')
      .send({
        hex: '01',
        reference: 'someRefId',
        metadata: {
          sender: 'halfinny@vistamail.org',
          pubkey: '02abc',
          signature: 'signature'
        }
      })
    parser.mockRestore()

    expect(response.statusCode).toBe(400)
    expect(response.text).toBe('Invalid body: parser failed')
  })
})
