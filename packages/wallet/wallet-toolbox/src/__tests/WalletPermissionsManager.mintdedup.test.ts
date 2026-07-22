/**
 * Duplicate-token minting regression tests.
 *
 * Granted permission tokens are only cached once their on-chain mint
 * completes (network seconds). Historically, identical requests arriving in
 * that window re-prompted the user and minted duplicate tokens — and since
 * default grants never expire, the renewal-time coalescing that would merge
 * duplicates never ran. These tests pin the fixed behavior:
 *  - a valid token or fresh grant never re-prompts or re-mints
 *  - ensures arriving during an in-flight mint wait for it instead of
 *    re-prompting
 *  - stacked first-contact grants for the same permission mint ONE token
 *  - a failed mint re-opens the window (no false "granted" state)
 *  - spending authorizations are excluded from grant-dedup (amount semantics)
 */
import { MockedBSV_SDK } from './WalletPermissionsManager.fixtures'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { mockUnderlyingWallet } from './WalletPermissionsManager.fixtures'

const PROTO = { originator: 'app.example.com', protocolID: [1, 'testproto'] as [number, string], counterparty: 'self' }

const validToken = {
  tx: [1, 2, 3],
  txid: 'existing-token-txid',
  outputIndex: 0,
  outputScript: 'aa',
  satoshis: 1,
  originator: 'app.example.com',
  rawOriginator: 'app.example.com',
  expiry: 0, // never expires
  privileged: false,
  securityLevel: 1,
  protocol: 'testproto',
  counterparty: 'self'
}

describe('WalletPermissionsManager duplicate mint prevention', () => {
  let underlying: jest.Mocked<any>
  let manager: WalletPermissionsManager
  let promptCount: number
  let requestIDs: string[]

  const ensureProto = async (usageType: any) =>
    await manager.ensureProtocolPermission({ ...PROTO, reason: 't', seekPermission: true, usageType })

  const mints = (): number => underlying.createAction.mock.calls.length

  beforeEach(() => {
    underlying = mockUnderlyingWallet()
    manager = new WalletPermissionsManager(underlying, 'admin.test.com', {
      seekProtocolPermissionsForEncrypting: true,
      seekProtocolPermissionsForHMAC: true,
      seekProtocolPermissionsForSigning: true
    })
    promptCount = 0
    requestIDs = []
    // App-style callback: record the request; granting happens separately.
    manager.bindCallback('onProtocolPermissionRequested', (req: any) => {
      promptCount++
      requestIDs.push(req.requestID)
    })
  })

  it('steady state: a valid never-expiring token never re-prompts or mints', async () => {
    ;(manager as any).findProtocolToken = jest.fn().mockResolvedValue(validToken)

    for (const usageType of ['generic', 'signing', 'encrypting', 'hmac', 'publicKey']) {
      expect(await ensureProto(usageType)).toBe(true)
    }
    expect(promptCount).toBe(0)
    expect(mints()).toBe(0)
  })

  it('an ensure arriving during an in-flight mint waits instead of re-prompting', async () => {
    let releaseMint!: () => void
    const gate = new Promise<void>(r => { releaseMint = r })
    const originalCreateAction = underlying.createAction.getMockImplementation()
    underlying.createAction.mockImplementation(async (args: any) => {
      await gate
      return originalCreateAction!(args)
    })

    const ensure1 = ensureProto('generic')
    await new Promise(r => setTimeout(r, 20))
    expect(promptCount).toBe(1)

    // User clicks Grant; mint is now in flight (gated).
    const grant1 = manager.grantPermission({ requestID: requestIDs[0] })

    // The app's original call resumes before the mint completes.
    await expect(ensure1).resolves.toBe(true)

    // A follow-up identical request arrives during the mint window.
    const ensure2 = ensureProto('generic')
    await new Promise(r => setTimeout(r, 50))
    expect(promptCount).toBe(1) // no re-prompt

    releaseMint()
    await grant1
    await expect(ensure2).resolves.toBe(true)
    expect(promptCount).toBe(1)
    expect(mints()).toBe(1)
  })

  it('stacked first-contact grants for one permission mint exactly one token', async () => {
    // Four concurrent usage types, no token yet: four prompts by design…
    const ensures = ['generic', 'signing', 'encrypting', 'hmac'].map(ensureProto)
    await new Promise(r => setTimeout(r, 30))
    expect(promptCount).toBe(4)

    // …but granting them all mints ONE token, not four.
    for (const id of requestIDs) await manager.grantPermission({ requestID: id })
    await Promise.all(ensures)
    expect(mints()).toBe(1)
  })

  it('a failed mint re-opens the window instead of faking success', async () => {
    underlying.createAction.mockRejectedValueOnce(new Error('mint failed'))

    const ensure1 = ensureProto('generic')
    await new Promise(r => setTimeout(r, 20))
    await expect(manager.grantPermission({ requestID: requestIDs[0] })).rejects.toThrow('mint failed')
    await expect(ensure1).resolves.toBe(true) // waiter was already resolved by grant

    // The failed mint must not have cached the permission: a new request
    // prompts again (and this time mints successfully).
    const ensure2 = ensureProto('generic')
    await new Promise(r => setTimeout(r, 20))
    expect(promptCount).toBe(2)
    await manager.grantPermission({ requestID: requestIDs[1] })
    await expect(ensure2).resolves.toBe(true)
    expect(mints()).toBe(2) // one failed attempt + one success
  })

  it('spending authorizations are excluded from grant-dedup', async () => {
    const spendingRequest = {
      type: 'spending',
      originator: 'app.example.com',
      spending: { satoshis: 1000 },
      renewal: false
    }
    // Seed two active spending requests directly (their prompt flow is
    // exercised elsewhere; this pins grantPermission's dedup exclusion).
    ;(manager as any).activeRequests.set('spend-1', { request: spendingRequest, pending: [] })
    ;(manager as any).activeRequests.set('spend-2', { request: spendingRequest, pending: [] })

    await manager.grantPermission({ requestID: 'spend-1', amount: 1000 })
    await manager.grantPermission({ requestID: 'spend-2', amount: 1000 })
    expect(mints()).toBe(2) // every spending grant is honored as-is

    // Contrast: identical protocol grants dedupe.
    const protoRequest = { type: 'protocol', originator: 'app.example.com', privileged: false, protocolID: [1, 'p'], counterparty: 'self', renewal: false }
    ;(manager as any).activeRequests.set('proto-1', { request: protoRequest, pending: [] })
    ;(manager as any).activeRequests.set('proto-2', { request: protoRequest, pending: [] })
    await manager.grantPermission({ requestID: 'proto-1' })
    await manager.grantPermission({ requestID: 'proto-2' })
    expect(mints()).toBe(3) // only one more mint for the two protocol grants
  })
})
