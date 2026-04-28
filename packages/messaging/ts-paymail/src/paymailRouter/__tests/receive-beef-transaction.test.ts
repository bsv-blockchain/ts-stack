import request from 'supertest'
import express from 'express'
import PaymailRouter from '../../../dist/cjs/src/paymailRouter/paymailRouter.js'
import ReceiveBeefTransactionRoute from '../../../dist/cjs/src/paymailRouter/paymailRoutes/receiveBeefTransaction.js'
import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient'
import { PrivateKey, Transaction } from '@bsv/sdk'

describe('#Paymail Server - P2P Receive Beef Transaction', () => {
  let app
  let paymailClient

  beforeAll(() => {
    app = express()
    const baseUrl = 'http://localhost'
    const basePath = '/paymail'
    paymailClient = new PaymailClient(null, { dns: null }, null)

    const routes = [
      new ReceiveBeefTransactionRoute({
        domainLogicHandler: () => {
          return {
            txid: '5878f6efcb1aa3be389510ae2ff10d0368976bf867e8442b751908f19024f8dd'
          }
        },
        verifySignature: true,
        paymailClient
      })
    ]

    const paymailRouter = new PaymailRouter({ baseUrl, basePath, routes })
    app.use(paymailRouter.getRouter())
  })

  it('should reject with a 400 with invalid Beef transaction', async () => {
    const response = await request(app).post('/paymail/receive-beef-transaction/satoshi@bsv.org').send({
      beef: '01000000012adda020db81f2155ebba69e7c841275517ebf91674268c32ff2f5c7e2853b2c010000006b483045022100872051ef0b6c47714130c12a067db4f38b988bfc22fe270731c2146f5229386b02207abf68bbf092ec03e2c616defcc4c868ad1fc3cdbffb34bcedfab391a1274f3e412102affe8c91d0a61235a3d07b1903476a2e2f7a90451b2ed592fea9937696a07077ffffffff02ed1a0000000000001976a91491b3753cf827f139d2dc654ce36f05331138ddb588acc9670300000000001976a914da036233873cc6489ff65a0185e207d243b5154888ac00000000',
      metadata: {
        sender: 'halfinny@vistamail.org',
        pubkey: '02d362a22ddc1a299122455690bec54397ae0b1b2765e4f1687cb479271c050a40',
        signature: 'signature(txid)',
        note: 'gm.'
      },
      reference: 'someRefId'
    })
    expect(response.statusCode).toBe(400)
    expect(response.error.text).toEqual('Invalid body: Serialized BEEF must start with 4022206465 or 4022206466 but starts with 1')
  })

  it.skip('should receive beef transaction', async () => {
    const privateKey = PrivateKey.fromRandom()
    const tx = Transaction.fromHexBEEF('0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000')
    paymailClient.verifyPublicKey = jest.fn().mockResolvedValue({ match: true })
    const signature = paymailClient.createP2PSignature(tx.id('hex'), privateKey)
    const response = await request(app).post('/paymail/receive-beef-transaction/satoshi@bsv.org').send({
      beef: tx.toHexBEEF(),
      metadata: {
        sender: 'halfinny@vistamail.org',
        pubkey: privateKey.toPublicKey().toString(),
        signature,
        note: 'gm.'
      },
      reference: 'someRefId'
    })
    expect(response.statusCode).toBe(200)
    expect(response.body.txid).toEqual('5878f6efcb1aa3be389510ae2ff10d0368976bf867e8442b751908f19024f8dd')
  })

  it('should reject with invalid signature', async () => {
    paymailClient.verifyPublicKey = jest.fn().mockResolvedValue({ match: true })
    const privateKey = PrivateKey.fromRandom()
    const tx = Transaction.fromHexBEEF('0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000')
    const response = await request(app).post('/paymail/receive-beef-transaction/satoshi@bsv.org').send({
      beef: tx.toHexBEEF(),
      metadata: {
        sender: 'halfinny@vistamail.org',
        pubkey: privateKey.toPublicKey().toString(),
        signature: 'cafebabe',
        note: 'gm.'
      },
      reference: 'someRefId'
    })
    expect(response.statusCode).toBe(400)
    expect(response.error.text).toEqual('Signature DER must start with 0x30')
  })

  it('should reject with invalid public key', async () => {
    paymailClient.verifyPublicKey = jest.fn().mockResolvedValue({ match: false })
    const privateKey = PrivateKey.fromRandom()
    const tx = Transaction.fromHexBEEF('0100beef01fe636d0c0007021400fe507c0c7aa754cef1f7889d5fd395cf1f785dd7de98eed895dbedfe4e5bc70d1502ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e010b00bc4ff395efd11719b277694cface5aa50d085a0bb81f613f70313acd28cf4557010400574b2d9142b8d28b61d88e3b2c3f44d858411356b49a28a4643b6d1a6a092a5201030051a05fc84d531b5d250c23f4f886f6812f9fe3f402d61607f977b4ecd2701c19010000fd781529d58fc2523cf396a7f25440b409857e7e221766c57214b1d38c7b481f01010062f542f45ea3660f86c013ced80534cb5fd4c19d66c56e7e8c5d4bf2d40acc5e010100b121e91836fd7cd5102b654e9f72f3cf6fdbfd0b161c53a9c54b12c841126331020100000001cd4e4cac3c7b56920d1e7655e7e260d31f29d9a388d04910f1bbd72304a79029010000006b483045022100e75279a205a547c445719420aa3138bf14743e3f42618e5f86a19bde14bb95f7022064777d34776b05d816daf1699493fcdf2ef5a5ab1ad710d9c97bfb5b8f7cef3641210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013e660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000001000100000001ac4e164f5bc16746bb0868404292ac8318bbac3800e4aad13a014da427adce3e000000006a47304402203a61a2e931612b4bda08d541cfb980885173b8dcf64a3471238ae7abcd368d6402204cbf24f04b9aa2256d8901f0ed97866603d2be8324c2bfb7a37bf8fc90edd5b441210263e2dee22b1ddc5e11f6fab8bcd2378bdd19580d640501ea956ec0e786f93e76ffffffff013c660000000000001976a9146bfd5c7fbe21529d45803dbcf0c87dd3c71efbc288ac0000000000')
    const response = await request(app).post('/paymail/receive-beef-transaction/satoshi@bsv.org').send({
      beef: tx.toHexBEEF(),
      metadata: {
        sender: 'halfinny@vistamail.org',
        pubkey: privateKey.toPublicKey().toString(),
        signature: 'invalid signature',
        note: 'gm.'
      },
      reference: 'someRefId'
    })
    expect(response.statusCode).toBe(400)
    expect(response.error.text).toEqual('Invalid Public Key for sender')
  })
})
