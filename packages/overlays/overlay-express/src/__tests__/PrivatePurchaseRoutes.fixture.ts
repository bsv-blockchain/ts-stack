import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPrivatePurchaseRouter } from '../PrivatePurchaseRoutes.js'
import type { PrivatePurchaseRouteOptions } from '../PrivatePurchaseHTTPPorts.js'
import { PrivatePurchaseAccess } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseDisclosure.js'
import { PrivatePurchaseCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePurchaseCoordinator.js'
import { purchaseCoordinatorFixture } from '../../../../application/output-knowledge/test/private-purchase-coordinator.fixture.js'

/** Actual HTTP authentication and native private custody; controlled domain and
 * admission ports do not constitute Bitcoin or covenant evidence. */
export async function privatePurchaseHTTPFixture(
  overrides: Partial<PrivatePurchaseRouteOptions> = {},
  beforeParser = false
) {
  const owner = purchaseCoordinatorFixture(),
    contract = owner.f.f.f
  let permitted = true,
    control = true
  const access = new PrivatePurchaseAccess(
    owner.f.owner.domain,
    contract.installation.topic,
    () => permitted
  )
  const coordinator = new PrivatePurchaseCoordinator({ ...owner.owner, access })
  const disclosure = new PrivatePurchaseDisclosure(
    owner.f.owner.domain,
    owner.f.owner.store,
    contract.contracts,
    access,
    owner.f.clock,
    () => control
  )
  const wallet = new CompletedProtoWallet(contract.key),
    sign = wallet.createSignature.bind(wallet)
  let onSign: (() => void | Promise<void>) | undefined
  wallet.createSignature = async (...args) => {
    const result = await sign(...args)
    await onSign?.()
    return result
  }
  const options: PrivatePurchaseRouteOptions = {
    service: coordinator,
    disclosure,
    baseURL: contract.installation.baseURL,
    identity: contract.installation.seller,
    authenticate: createAuthMiddleware({
      wallet,
      allowUnauthenticated: true,
      transportLimits: { requestTimeoutMs: 3000 }
    }),
    requestTimeoutMs: 10000,
    ...overrides
  }
  const app = express()
  if (beforeParser) app.use(express.json())
  app.use(createPrivatePurchaseRouter(options))
  app.post('/submit', express.json(), (_req, res) =>
    res.json({ legacy: { outputsToAdmit: [0], coinsToRetain: [] } })
  )
  app.post('/lookup', express.json(), (_req, res) => res.json({ type: 'output-list', outputs: [] }))
  const server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-bsv-overlay-capability': owner.caller.capability,
    'x-bsv-overlay-profile': owner.caller.profile
  }
  const wireHeaders: Headers[] = []
  const clientFor = (key: PrivateKey) => {
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
        return authenticated.fetch(url, {
          ...init,
          headers: selected,
          allowPayments: false,
          requireMutualAuth: true,
          expectedIdentityKey: contract.installation.seller
        })
      }
    }
  }
  const client = clientFor(new PrivateKey(44))
  return {
    owner,
    contract,
    coordinator,
    disclosure,
    options,
    origin,
    client,
    clientFor,
    headers,
    wireHeaders,
    setPermitted: (value: boolean) => {
      permitted = value
    },
    setControl: (value: boolean) => {
      control = value
    },
    onHTTPSign: (callback?: () => void | Promise<void>) => {
      onSign = callback
    },
    fetch: (
      operation: 'prepare' | 'submit' | 'recover' = 'prepare',
      text?: string,
      extra: Record<string, string> = {}
    ) =>
      client.fetch(origin + '/api/overlay/v1/purchases/' + operation, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body:
          text ??
          JSON.stringify(
            operation === 'prepare'
              ? contract.request
              : operation === 'submit'
                ? owner.f.candidate
                : { version: 1, acquisitionId: owner.f.id }
          )
      }),
    close: async () => {
      await coordinator.stop()
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
      await owner.dispose()
    }
  }
}
