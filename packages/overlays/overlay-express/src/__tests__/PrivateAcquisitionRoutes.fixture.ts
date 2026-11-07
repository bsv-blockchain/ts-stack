import express from 'express'
import OverlayExpress from '../OverlayExpress.js'
import type { PrivateAcquisitionHostOptions } from '../PrivateOverlayHost.js'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPrivateAcquisitionRouter } from '../PrivateAcquisitionRoutes.js'
import type { PrivateAcquisitionRouteOptions } from '../PrivateAcquisitionHTTPPorts.js'
import { PrivateAcquisitionDisclosure } from '../../../../application/output-knowledge/src/private/PrivateAcquisitionDisclosure.js'
import { acquisitionCoordinatorFixture } from '../../../../application/output-knowledge/test/private-acquisition-coordinator.fixture.js'

export async function privateAcquisitionHTTPFixture(
  overrides:
    | Partial<PrivateAcquisitionRouteOptions>
    | ((
        owner: Awaited<ReturnType<typeof acquisitionCoordinatorFixture>>
      ) => Promise<Partial<PrivateAcquisitionRouteOptions>>) = {},
  beforeParser = false,
  chain?: { network: string; genesisHash: string },
  configureHost?: (host: OverlayExpress, options: PrivateAcquisitionHostOptions) => void
) {
  const owner = await acquisitionCoordinatorFixture({}, chain)
  const f = {
    ...owner,
    contract: { key: owner.f.f.key, installation: owner.f.f.installation, request: owner.request },
    status: { version: 1, acquisitionId: owner.f.id }
  }
  const httpState = { control: true }
  const disclosure = new PrivateAcquisitionDisclosure(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.contracts,
    f.options.access,
    f.options.clock,
    () => httpState.control
  )
  const wallet = new CompletedProtoWallet(f.contract.key)
  const sign = wallet.createSignature.bind(wallet)
  let onSign: (() => void | Promise<void>) | undefined
  wallet.createSignature = async (...args) => {
    const result = await sign(...args)
    await onSign?.()
    return result
  }
  const app = express()
  if (beforeParser) app.use(express.json())
  const auth = createAuthMiddleware({
    wallet,
    allowUnauthenticated: true,
    transportLimits: { requestTimeoutMs: 3000 }
  })
  const installed = typeof overrides === 'function' ? await overrides(f) : overrides
  const options: PrivateAcquisitionRouteOptions = {
    service: f.coordinator,
    disclosure,
    baseURL: f.contract.installation.baseURL,
    authenticate: auth,
    requestTimeoutMs: 10000,
    ...installed
  }
  let host: OverlayExpress | undefined
  let server: ReturnType<typeof createServer>
  if (configureHost) {
    try {
      host = new OverlayExpress('Synthetic private host', f.contract.key.toHex(), 'host.example')
      host.configureLogger({ ...console, log: () => {}, error: () => {} })
      host.port = 0 // OS-assigned port for this isolated local fixture.
      host.enableGASPSync = false
      host.configureEngineParams({ unprovenMaintenanceIntervalMs: 0 })
      // Host composition uses a synthetic engine boundary. Native publication and
      // wallet admission have separate integration fixtures with their real owners.
      Object.assign(host, {
        engine: {
          syncAdvertisements: async () => {},
          lookup: async () => ({ type: 'output-list', outputs: [] })
        },
        knex: { migrate: { latest: async () => [] }, destroy: async () => {} },
        serverWallet: wallet
      })
      const selected = { ...options, identity: f.contract.installation.seller }
      host.configurePrivateAcquisition(selected)
      configureHost(host, selected)
      await host.start()
      server = host.server!
      if (!server.listening)
        await new Promise<void>((resolve, reject) => {
          server.once('listening', resolve)
          server.once('error', reject)
        })
    } catch (error) {
      await host?.close()
      await f.coordinator.stop()
      await f.dispose()
      throw error
    }
  } else {
    app.use(createPrivateAcquisitionRouter(options))
    app.post('/lookup', express.json(), (_req, res) =>
      res.json({ type: 'output-list', outputs: [] })
    )
    server = createServer({ maxHeaderSize: 262144 }, app)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  }
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': f.caller.capability,
    'x-bsv-overlay-profile': f.caller.profile
  }
  const wireHeaders: Headers[] = []
  const clientFor = (key: PrivateKey, signal?: AbortSignal) => {
    let wireCache = 'no-store'
    const authenticated = new AuthFetch(
      new CompletedProtoWallet(key),
      undefined,
      undefined,
      undefined,
      { requestTimeoutMs: 3000 },
      async (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('cache-control', wireCache)
        const response = await fetch(input, {
          ...init,
          headers: sent,
          signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error'
        })
        wireHeaders.push(response.headers)
        return response
      }
    )
    return {
      fetch: async (url: string, init: Parameters<AuthFetch['fetch']>[1] = {}) => {
        const selected = { ...(init.headers as Record<string, string>) }
        wireCache = selected['cache-control'] ?? 'no-store'
        delete selected['cache-control']
        return await authenticated.fetch(url, {
          ...init,
          headers: selected,
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: f.contract.installation.seller
        })
      }
    }
  }
  const client = clientFor(new PrivateKey(84))
  return {
    ...f,
    host,
    server,
    disclosure,
    httpState,
    options,
    client,
    clientFor,
    wireHeaders,
    origin,
    headers,
    onHTTPSign(callback?: () => void | Promise<void>) {
      onSign = callback
    },
    async fetch(operation: 'acquire' | 'recover' = 'acquire', text?: string, payment?: unknown) {
      return await client.fetch(origin + '/api/overlay/v1/private/' + operation, {
        method: 'POST',
        headers: {
          ...headers,
          ...(payment === undefined ? {} : { 'x-bsv-payment': JSON.stringify(payment) })
        },
        body: text ?? JSON.stringify(operation === 'acquire' ? f.contract.request : f.status)
      })
    },
    async close() {
      await f.coordinator.stop()
      server.closeAllConnections()
      if (host) await host.close()
      else
        await new Promise<void>((resolve, reject) =>
          server.close(error => (error ? reject(error) : resolve()))
        )
      await f.dispose()
    }
  }
}
