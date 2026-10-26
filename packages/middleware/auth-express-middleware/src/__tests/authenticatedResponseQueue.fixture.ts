import { rateLimit } from 'express-rate-limit'
import express, { type Request, type Response } from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '../index.js'
import { MockWallet } from './MockWallet.js'

export async function queueFixture(
  route: (req: Request, res: Response) => void,
  options: {
    timeout?: number
    maxBytes?: number
    before?: (req: Request, res: Response) => void
    received?: (response: globalThis.Response) => void
    logger?: typeof console
  } = {}
) {
  // Public synthetic identities; this fixture never creates funded actions.
  const serverWallet = new MockWallet(new PrivateKey(85)),
    clientWallet = new MockWallet(new PrivateKey(86))
  let onSign: (() => void | Promise<void>) | undefined
  const sign = serverWallet.createSignature.bind(serverWallet)
  serverWallet.createSignature = async (...args) => {
    const result = await sign(...args)
    const pending = onSign
    if (pending !== undefined) {
      onSign = undefined
      await pending()
    }
    return result
  }
  const app = express()
  app.use(rateLimit({ windowMs: 60000, limit: 20000 }))
  app.use(express.json())
  app.use((req, res, next) => {
    options.before?.(req, res)
    next()
  })
  app.use(
    createAuthMiddleware({
      wallet: serverWallet,
      allowUnauthenticated: true,
      logger: options.logger,
      logLevel: options.logger === undefined ? undefined : 'debug',
      transportLimits: {
        requestTimeoutMs: options.timeout ?? 1000,
        maxResponseBytes: options.maxBytes ?? 8388608
      }
    })
  )
  app.post('/queue', route)
  const server: Server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/queue`
  const client = new AuthFetch(
    clientWallet,
    undefined,
    undefined,
    undefined,
    {},
    async (...args) => {
      const response = await fetch(...args)
      options.received?.(response)
      return response
    }
  )
  return {
    url,
    client,
    server,
    clientIdentity: (await clientWallet.getPublicKey({ identityKey: true })).publicKey,
    onSign(callback: () => void | Promise<void>) {
      onSign = callback
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      )
    }
  }
}
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}
