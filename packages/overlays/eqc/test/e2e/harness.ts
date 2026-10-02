import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import type { LookupAnswer, LookupQuestion, WalletInterface } from '@bsv/sdk'
import express from 'express'

import type { LookupResolverLike } from '../../src/client/discovery.js'
import { createEconomicQueryHost } from '../../src/host/handlers.js'
import type { QueryProvider } from '../../src/host/providers.js'
import { ECONOMIC_PATHS } from '../../src/protocol/query.js'
import { slapTokenOutput } from '../support/transactions.js'
import { HostWallet } from '../support/wallets.js'

/**
 * SLAP advertisements are https-only from SDK 2.8.0, so hosts are advertised and addressed as
 * `https://127.0.0.1:<port>` and this fetch carries each request over plain HTTP to the loopback
 * server. BRC-104 signs the path and query, not the scheme, so authentication is unaffected.
 */
export const loopbackFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  if (!url.startsWith('https://127.0.0.1:')) throw new Error(`unexpected e2e URL ${url}`)
  return await fetch(`http://${url.slice('https://'.length)}`, init)
}

export interface E2EHost {
  /** The https URL the host is advertised and addressed by; see {@link loopbackFetch}. */
  url: string
  wallet: HostWallet
  close: () => Promise<void>
}

export async function startHost(options: {
  providers: QueryProvider[]
  delayMs?: number
  /** Answer every query with a complete BRC-105 challenge for this many satoshis. */
  demand402Sats?: number
  /** Answer every query with a JSON string body of this many bytes. */
  oversizedBodyBytes?: number
}): Promise<E2EHost> {
  const wallet = new HostWallet()
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.use(createAuthMiddleware({ wallet, allowUnauthenticated: true, logLevel: 'error' }))
  if (options.delayMs !== undefined) {
    const delayMs = options.delayMs
    app.use((_req, _res, next) => {
      setTimeout(next, delayMs)
    })
  }
  if (options.demand402Sats !== undefined) {
    const satoshis = options.demand402Sats
    app.post(ECONOMIC_PATHS.query, (_req, res) => {
      res
        .status(402)
        .set({
          'x-bsv-payment-version': '1.0',
          'x-bsv-payment-satoshis-required': String(satoshis),
          'x-bsv-payment-derivation-prefix': 'AAECAwQFBgcICQoLDA0ODw=='
        })
        .json({ status: 'error', code: 'ERR_PAYMENT_REQUIRED', satoshisRequired: satoshis })
    })
  }
  if (options.oversizedBodyBytes !== undefined) {
    const filler = 'x'.repeat(options.oversizedBodyBytes)
    app.post(ECONOMIC_PATHS.query, (_req, res) => {
      res.json(filler)
    })
  }
  // Compile-time proof that an express Application satisfies RouterLike.
  createEconomicQueryHost({
    wallet,
    providers: options.providers,
    logger: { error: () => undefined }
  }).mount(app)

  const server: Server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    listening.once('error', reject)
  })
  const { port } = server.address() as AddressInfo
  return {
    url: `https://127.0.0.1:${port}`,
    wallet,
    close: async () =>
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

/** Stands in for the SLAP trackers: answers `ls_slap` with real advertisement tokens. */
export function slapResolver(
  service: string,
  entries: Array<{ url: string; advertiser: WalletInterface }>
): LookupResolverLike {
  return {
    async query(question: LookupQuestion): Promise<LookupAnswer> {
      if (question.service !== 'ls_slap') return { type: 'output-list', outputs: [] }
      const outputs = await Promise.all(
        entries.map(async entry => await slapTokenOutput(entry.advertiser, entry.url, service))
      )
      return { type: 'output-list', outputs }
    }
  }
}
