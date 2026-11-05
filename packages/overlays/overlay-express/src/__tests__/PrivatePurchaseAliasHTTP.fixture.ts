import express from 'express'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { createAuthMiddleware } from '@bsv/auth-express-middleware'
import { createPrivatePurchaseRouter } from '../PrivatePurchaseRoutes.js'
import type { PrivatePurchaseRouteOptions } from '../PrivatePurchaseHTTPPorts.js'
import { PrivatePurchaseAccess } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAccess.js'
import { PrivatePurchaseAliasDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAliasDisclosure.js'
import { PrivatePurchaseDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePurchaseDisclosure.js'
import { PrivatePurchaseAliasCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePurchaseAliasCoordinator.js'
import { purchaseAliasCoordinatorFixture } from '../../../../application/output-knowledge/test/private-purchase-alias-coordinator.fixture.js'

/** Actual authenticated HTTP, alias-aware native custody and physical disclosure;
 * controlled domain/admission/chain premises are not BRC197 or SPV qualification.
 * The independent SDK proof-of-work ancestry corpus covers real chain evidence. */
export async function privatePurchaseAliasHTTPFixture(
  overrides: Partial<PrivatePurchaseRouteOptions> = {},
  beforeParser = false
) {
  const owner = purchaseAliasCoordinatorFixture(),
    contract = owner.f.base.f.f
  let permitted = true,
    control = true
  const access = new PrivatePurchaseAccess(
    owner.installation.serviceDomain,
    contract.installation.topic,
    () => permitted,
    'full-purchase-commitment-v1',
    'alias-custody-v1'
  )
  const coordinator = new PrivatePurchaseAliasCoordinator({ ...owner.installation, access })
  const historicalDisclosure = new PrivatePurchaseDisclosure(
    owner.installation.serviceDomain,
    owner.installation.store,
    contract.contracts,
    access,
    owner.installation.clock,
    () => control
  )
  const disclosure = new PrivatePurchaseAliasDisclosure(historicalDisclosure, coordinator)
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
    'x-bsv-overlay-capability': owner.base.caller.capability,
    'x-bsv-overlay-profile': owner.base.caller.profile
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
    historicalDisclosure,
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
                ? owner.f.f.variant(80)
                : { version: 1, acquisitionId: owner.f.base.id }
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
