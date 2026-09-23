import express from 'express'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  AuthFetch,
  Beef,
  PrivateKey,
  PublicKey,
  ProtoWallet,
  Script,
  Transaction,
  P2PKH,
  type WalletInterface,
  type CreateActionArgs
} from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware } from '../index.js'
import type { PaymentRequest } from '../types.js'

jest.setTimeout(30_000)
const servers: Server[] = []
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(
    servers.splice(0).map(async server => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error == null ? resolve() : reject(error)))
      )
    })
  )
})

async function fixture(
  options: {
    ancestorBytes?: number
    enableMultipart?: boolean
    raw?: boolean
    proxyBodyLimit?: number
    fetchHook?: (url: string, init: RequestInit) => RequestInit
  } = {}
) {
  const serverWallet = new ProtoWallet(new PrivateKey(23)) as unknown as WalletInterface
  const clientWallet = new ProtoWallet(new PrivateKey(24)) as unknown as WalletInterface
  const accepted = new Set<string>()
  serverWallet.internalizeAction = jest.fn(async args => {
    const beef = Beef.fromBinaryStrict(args.tx)
    const txid = beef.atomicTxid!
    const remittance = args.outputs[0].paymentRemittance!
    const key = await serverWallet.getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: `${remittance.derivationPrefix} ${remittance.derivationSuffix}`,
      counterparty: remittance.senderIdentityKey,
      forSelf: true
    })
    // Derive through the actual wallet, independently of the client's prepared output.
    expect(beef.findTxid(txid)!.tx!.outputs[0].lockingScript.toHex()).toBe(
      new P2PKH().lock(PublicKey.fromString(key.publicKey).toAddress()).toHex()
    )
    if (accepted.has(txid)) return { accepted: true as const, isMerge: true }
    accepted.add(txid)
    return { accepted: true as const, isMerge: false }
  })
  clientWallet.abortAction = jest.fn(async () => ({ aborted: true }))
  clientWallet.createAction = jest.fn(async (args: CreateActionArgs) => {
    if (args.options?.sendWith !== undefined)
      return {
        sendWithResults: args.options.sendWith.map(txid => ({ txid, status: 'unproven' as const }))
      }
    expect(args.options?.noSend).toBe(true)
    const source = new Transaction()
    source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM('OP_TRUE') })
    if ((options.ancestorBytes ?? 0) > 0)
      source.addOutput({
        satoshis: 0,
        lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'01'.repeat(options.ancestorBytes!)}`)
      })
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    tx.addOutput({
      satoshis: args.outputs![0].satoshis,
      lockingScript: Script.fromHex(args.outputs![0].lockingScript)
    })
    return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
  })
  const app = express()
  if (options.raw === false) app.use(express.json())
  app.use(createAuthMiddleware({ wallet: serverWallet, captureRawBody: options.raw !== false }))
  app.use(
    createPaymentMiddleware({
      wallet: serverWallet,
      enableMultipart: options.enableMultipart !== false,
      calculateRequestPrice: () => 10
    })
  )
  const handler = jest.fn((req: PaymentRequest, res: express.Response) =>
    res.json({
      method: req.method,
      url: req.originalUrl,
      mediaType: req.headers['content-type'],
      raw: req.rawBody === undefined ? null : Buffer.from(req.rawBody).toString('base64'),
      parsed: req.body,
      paid: req.payment?.accepted
    })
  )
  app.use(handler)
  const upstream = await listen(createServer(app))
  const bodyLimit = options.proxyBodyLimit ?? 256 * 1024
  const proxy = createServer({ maxHeaderSize: 6 * 1024 }, (req, res) => {
    const chunks: Buffer[] = []
    let size = 0
    if (Number(req.headers['content-length'] ?? 0) > bodyLimit) {
      res.writeHead(413, { Connection: 'close' })
      res.end()
      return
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > bodyLimit) {
        res.writeHead(413, { Connection: 'close' })
        res.end()
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      const destination = new URL(req.url!, upstream)
      const forward = httpRequest(
        destination,
        { method: req.method, headers: req.headers },
        upstreamResponse => {
          res.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers)
          upstreamResponse.pipe(res)
        }
      )
      forward.on('error', () => {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      })
      forward.end(Buffer.concat(chunks))
    })
  })
  const origin = await listen(proxy)
  const fetchClient: typeof fetch = async (url, init = {}) =>
    fetch(url, options.fetchHook?.(String(url), init) ?? init)
  const client = new AuthFetch(clientWallet, undefined, undefined, undefined, {}, fetchClient)
  jest.spyOn(client as any, 'logPaymentAttempt').mockImplementation(() => {})
  return { client, clientWallet, serverWallet, handler, origin }
}

describe('BRC-118 through signed HTTP and a 6 KiB-header proxy', () => {
  it.each([
    ['application/json; charset=utf-8', Buffer.from('{ "snow": "雪" }\n')],
    ['application/octet-stream', Buffer.from([0, 128, 255, 13, 10, 0])],
    ['text/plain', Buffer.alloc(0)],
    [
      'multipart/form-data; boundary=inner',
      Buffer.from(
        '--inner\r\nContent-Disposition: form-data; name="upload"; filename="file.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\u0000\u00ff\r\n--inner--\r\n'
      )
    ]
  ])('preserves original %s payload through a large payment', async (contentType, body) => {
    const { client, clientWallet, serverWallet, handler, origin } = await fixture({
      ancestorBytes: 12_000
    })
    const response = await client.fetch(`${origin}/paid?q=retained`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      paymentRetryAttempts: 1
    })
    const result = await response.json()
    expect({ status: response.status, result }).toMatchObject({
      status: 200,
      result: { paid: true }
    })
    expect(result).toMatchObject({
      method: 'POST',
      url: '/paid?q=retained',
      mediaType: contentType,
      raw: body.toString('base64'),
      paid: true
    })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(serverWallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
  })

  it('keeps header transport compatible with a server whose raw multipart path is disabled', async () => {
    const { client, origin, handler } = await fixture({ raw: false })
    expect((await client.fetch(`${origin}/paid`, { paymentRetryAttempts: 1 })).status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('refuses a large payment for a header-only server and releases the reservation', async () => {
    const { client, origin, clientWallet, handler, serverWallet } = await fixture({
      enableMultipart: false,
      ancestorBytes: 12_000
    })
    await expect(
      client.fetch(`${origin}/paid`, { method: 'POST', paymentRetryAttempts: 1 })
    ).rejects.toMatchObject({ code: 'ERR_PAYMENT_TRANSPORT', payment: { aborted: true } })
    expect(clientWallet.createAction).toHaveBeenCalledTimes(1)
    expect(handler).not.toHaveBeenCalled()
    expect(serverWallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('treats a real unsigned proxy body refusal as terminal without a second spend', async () => {
    const { client, origin, clientWallet, serverWallet, handler } = await fixture({
      ancestorBytes: 12_000,
      proxyBodyLimit: 4000
    })
    await expect(client.fetch(`${origin}/paid`, { method: 'POST' })).rejects.toMatchObject({
      code: 'ERR_PAYMENT_SIZE',
      httpStatus: 413,
      authenticated: false,
      payment: { state: 'submitted' }
    })
    expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
    expect(clientWallet.abortAction).not.toHaveBeenCalled()
    expect(serverWallet.internalizeAction).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('reproduces a real proxy header refusal below the selection threshold without retrying the spend', async () => {
    const { client, origin, clientWallet, serverWallet, handler } = await fixture({
      ancestorBytes: 5000
    })
    await expect(client.fetch(`${origin}/paid`, { method: 'POST' })).rejects.toMatchObject({
      code: 'ERR_PAYMENT_SIZE',
      httpStatus: 431,
      authenticated: false
    })
    expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
    expect(clientWallet.abortAction).not.toHaveBeenCalled()
    expect(serverWallet.internalizeAction).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it.each(['boundary', 'payment', 'payload', 'signature'])(
    'rejects modified %s before payment or route work',
    async change => {
      const { client, origin, handler, serverWallet, clientWallet } = await fixture({
        ancestorBytes: 12_000,
        fetchHook: (_url, init) => {
          const headers = { ...init.headers } as Record<string, string>
          if (!headers['content-type']?.startsWith('multipart/form-data')) return init
          if (change === 'boundary') headers['content-type'] += 'changed'
          if (change === 'signature') headers['x-bsv-auth-signature'] = '00'
          let body = init.body
          if (change === 'payment' || change === 'payload') {
            const bytes = Buffer.from(body as Uint8Array)
            const target = bytes.indexOf(change === 'payment' ? 'transaction' : 'original')
            bytes[target] ^= 1
            body = bytes
          }
          return { ...init, headers, body }
        }
      })
      await expect(
        client.fetch(`${origin}/paid`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'original',
          paymentRetryAttempts: 1
        })
      ).rejects.toThrow()
      expect(serverWallet.internalizeAction).not.toHaveBeenCalled()
      expect(handler).not.toHaveBeenCalled()
      expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
    }
  )
  it('rejects a newly authenticated replay of the same multipart payment', async () => {
    let captured: { body: Uint8Array; contentType: string } | undefined
    const { client, origin, handler, serverWallet, clientWallet } = await fixture({
      ancestorBytes: 12_000,
      fetchHook: (_url, init) => {
        const contentType = (init.headers as Record<string, string>)['content-type']
        if (contentType?.startsWith('multipart/form-data'))
          captured = { body: new Uint8Array(init.body as Uint8Array), contentType }
        return init
      }
    })
    expect((await client.fetch(`${origin}/paid`, { method: 'POST' })).status).toBe(200)
    expect(captured).toBeDefined()
    const replay = await client.fetch(`${origin}/paid`, {
      method: 'POST',
      body: captured!.body,
      headers: { 'content-type': captured!.contentType }
    })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ code: 'ERR_PAYMENT_REPLAYED' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(serverWallet.internalizeAction).toHaveBeenCalledTimes(2)
    expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'does not rerun the route or pay again after a wallet failure (accepted before error=%s)',
    async acceptedFirst => {
      const { client, origin, handler, serverWallet, clientWallet } = await fixture({
        ancestorBytes: 12_000
      })
      const original = serverWallet.internalizeAction
      serverWallet.internalizeAction = jest.fn(async args => {
        if (acceptedFirst) await original(args)
        throw new Error('private wallet provider context')
      })
      const response = await client.fetch(`${origin}/paid`, { method: 'POST' })
      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).toContain('ERR_PAYMENT_FAILED')
      expect(body).not.toContain('private wallet provider context')
      expect(handler).not.toHaveBeenCalled()
      expect(serverWallet.internalizeAction).toHaveBeenCalledTimes(1)
      expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
      expect(clientWallet.abortAction).not.toHaveBeenCalled()
    }
  )

  it('rejects simultaneous signed header and multipart payment sources before wallet work', async () => {
    let captured: { body: Uint8Array; contentType: string } | undefined
    const { client, origin, handler, serverWallet, clientWallet } = await fixture({
      ancestorBytes: 12_000,
      fetchHook: (_url, init) => {
        const contentType = (init.headers as Record<string, string>)['content-type']
        if (contentType?.startsWith('multipart/form-data'))
          captured = { body: new Uint8Array(init.body as Uint8Array), contentType }
        return init
      }
    })
    expect((await client.fetch(`${origin}/paid`, { method: 'POST' })).status).toBe(200)
    const response = await client.fetch(`${origin}/paid`, {
      method: 'POST',
      body: captured!.body,
      headers: { 'content-type': captured!.contentType, 'x-bsv-payment': '{}' }
    })
    expect(response.status).toBe(400)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(serverWallet.internalizeAction).toHaveBeenCalledTimes(1)
    expect(clientWallet.createAction).toHaveBeenCalledTimes(2)
  })
})
