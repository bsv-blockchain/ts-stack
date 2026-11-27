import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import {
  PermissionRequest,
  PermissionsManagerConfig,
  WalletPermissionsManager
} from '../WalletPermissionsManager'

jest.mock('@bsv/sdk', () => MockedBSV_SDK)

const ADMIN = 'admin.example'
const APP = 'app.example'
const COUNTERPARTY = `02${'ab'.repeat(32)}`
const VERIFIER = `02${'cd'.repeat(32)}`

const counterpartyProtocol = `counterparty key linkage revelation ${COUNTERPARTY}`
const specificProtocol = 'specific key linkage revelation invoice 7'
const specificLevelOneProtocol = 'specific key linkage revelation invoice all'

function create(config: PermissionsManagerConfig = {}) {
  const underlying = mockUnderlyingWallet()
  // Grouped prompts fetch a manifest. These tests isolate the linkage flags.
  const manager = new WalletPermissionsManager(underlying, ADMIN, {
    seekGroupedPermission: false,
    ...config
  })
  return { underlying, manager }
}

function counterpartyArgs() {
  return {
    privileged: false as const,
    verifier: VERIFIER,
    counterparty: COUNTERPARTY,
    privilegedReason: 'show the root shared secret'
  }
}

function specificArgs(level: 1 | 2 = 2) {
  return {
    privileged: false as const,
    verifier: VERIFIER,
    counterparty: COUNTERPARTY,
    protocolID: [level, 'invoice'] as [1 | 2, string],
    keyID: '7',
    privilegedReason: 'show one invoice hmac'
  }
}

async function queued(manager: WalletPermissionsManager): Promise<Map<string, PermissionRequest>> {
  await new Promise(resolve => setTimeout(resolve, 30))
  const active = (manager as any).activeRequests as Map<string, { request: PermissionRequest }>
  return new Map([...active.entries()].map(([id, entry]) => [id, entry.request]))
}

async function denyAll(manager: WalletPermissionsManager, ids: Iterable<string>): Promise<void> {
  for (const id of ids) await manager.denyPermission(id)
}

describe('WalletPermissionsManager key-linkage permission flags', () => {
  it('keeps both reveals gated when the new flags are omitted', async () => {
    const defaults = new WalletPermissionsManager(mockUnderlyingWallet(), ADMIN)
    const defaultsConfig = (defaults as any).config as PermissionsManagerConfig
    expect(defaultsConfig.seekPermissionsForKeyLinkageRevelation).toBe(true)
    expect(defaultsConfig.seekPermissionsForCounterpartyKeyLinkageRevelation).toBeUndefined()
    expect(defaultsConfig.seekPermissionsForSpecificKeyLinkageRevelation).toBeUndefined()

    const { underlying, manager } = create()
    const stored = (manager as any).config as PermissionsManagerConfig
    expect(stored.seekPermissionsForKeyLinkageRevelation).toBe(true)
    expect(stored.seekPermissionsForCounterpartyKeyLinkageRevelation).toBeUndefined()
    expect(stored.seekPermissionsForSpecificKeyLinkageRevelation).toBeUndefined()

    const counterpartyCall = manager.revealCounterpartyKeyLinkage(counterpartyArgs(), APP)
    const counterpartyQueue = await queued(manager)
    expect([...counterpartyQueue.values()]).toEqual([
      expect.objectContaining({
        type: 'protocol',
        usageType: 'counterpartyLinkageRevelation',
        protocolID: [2, counterpartyProtocol],
        counterparty: VERIFIER
      })
    ])
    expect(underlying.revealCounterpartyKeyLinkage).not.toHaveBeenCalled()
    await denyAll(manager, counterpartyQueue.keys())
    await expect(counterpartyCall).rejects.toThrow(/Permission denied/)

    const specificCall = manager.revealSpecificKeyLinkage(specificArgs(), APP)
    const specificQueue = await queued(manager)
    expect([...specificQueue.values()]).toEqual([
      expect.objectContaining({
        type: 'protocol',
        usageType: 'specificLinkageRevelation',
        protocolID: [2, specificProtocol],
        counterparty: VERIFIER
      })
    ])
    expect(underlying.revealSpecificKeyLinkage).not.toHaveBeenCalled()
    await denyAll(manager, specificQueue.keys())
    await expect(specificCall).rejects.toThrow(/Permission denied/)

    const levelOneCall = manager.revealSpecificKeyLinkage(specificArgs(1), APP)
    const levelOneQueue = await queued(manager)
    expect([...levelOneQueue.values()]).toEqual([
      expect.objectContaining({
        usageType: 'specificLinkageRevelation',
        protocolID: [2, specificLevelOneProtocol]
      })
    ])
    await denyAll(manager, levelOneQueue.keys())
    await expect(levelOneCall).rejects.toThrow(/Permission denied/)
  })

  it('lets the legacy flag alone gate both reveals', async () => {
    const { underlying, manager } = create({ seekPermissionsForKeyLinkageRevelation: false })
    const stored = (manager as any).config as PermissionsManagerConfig
    expect(stored.seekPermissionsForCounterpartyKeyLinkageRevelation).toBeUndefined()
    expect(stored.seekPermissionsForSpecificKeyLinkageRevelation).toBeUndefined()

    await expect(manager.revealCounterpartyKeyLinkage(counterpartyArgs(), APP)).resolves.toBeDefined()
    await expect(manager.revealSpecificKeyLinkage(specificArgs(), APP)).resolves.toBeDefined()
    expect(underlying.revealCounterpartyKeyLinkage).toHaveBeenCalledTimes(1)
    expect(underlying.revealSpecificKeyLinkage).toHaveBeenCalledTimes(1)
    expect(((manager as any).activeRequests as Map<string, unknown>).size).toBe(0)
  })

  it('gates counterparty linkage while leaving specific linkage ungated', async () => {
    const { underlying, manager } = create({
      seekPermissionsForCounterpartyKeyLinkageRevelation: true,
      seekPermissionsForSpecificKeyLinkageRevelation: false
    })

    await expect(manager.revealSpecificKeyLinkage(specificArgs(), APP)).resolves.toBeDefined()
    expect(underlying.revealSpecificKeyLinkage).toHaveBeenCalledTimes(1)
    expect(((manager as any).activeRequests as Map<string, unknown>).size).toBe(0)

    const call = manager.revealCounterpartyKeyLinkage(counterpartyArgs(), APP)
    const queue = await queued(manager)
    expect([...queue.values()]).toEqual([
      expect.objectContaining({ usageType: 'counterpartyLinkageRevelation', protocolID: [2, counterpartyProtocol] })
    ])
    expect(underlying.revealCounterpartyKeyLinkage).not.toHaveBeenCalled()
    await denyAll(manager, queue.keys())
    await expect(call).rejects.toThrow(/Permission denied/)
  })

  it('gates specific linkage while leaving counterparty linkage ungated', async () => {
    const { underlying, manager } = create({
      seekPermissionsForKeyLinkageRevelation: true,
      seekPermissionsForCounterpartyKeyLinkageRevelation: false
    })

    await expect(manager.revealCounterpartyKeyLinkage(counterpartyArgs(), APP)).resolves.toBeDefined()
    expect(underlying.revealCounterpartyKeyLinkage).toHaveBeenCalledTimes(1)

    const call = manager.revealSpecificKeyLinkage(specificArgs(), APP)
    const queue = await queued(manager)
    expect([...queue.values()]).toEqual([
      expect.objectContaining({ usageType: 'specificLinkageRevelation', protocolID: [2, specificProtocol] })
    ])
    expect(underlying.revealSpecificKeyLinkage).not.toHaveBeenCalled()
    await denyAll(manager, queue.keys())
    await expect(call).rejects.toThrow(/Permission denied/)
  })

  it('lets each new flag override the legacy combined flag', async () => {
    const { underlying, manager } = create({
      seekPermissionsForKeyLinkageRevelation: false,
      seekPermissionsForCounterpartyKeyLinkageRevelation: true,
      seekPermissionsForSpecificKeyLinkageRevelation: false
    })

    await expect(manager.revealSpecificKeyLinkage(specificArgs(), APP)).resolves.toBeDefined()
    expect(underlying.revealSpecificKeyLinkage).toHaveBeenCalledTimes(1)

    const call = manager.revealCounterpartyKeyLinkage(counterpartyArgs(), APP)
    const queue = await queued(manager)
    expect([...queue.values()][0]?.usageType).toBe('counterpartyLinkageRevelation')
    expect(underlying.revealCounterpartyKeyLinkage).not.toHaveBeenCalled()
    await denyAll(manager, queue.keys())
    await expect(call).rejects.toThrow(/Permission denied/)
  })

  it('keeps the legacy linkageRevelation usage on the combined flag only', async () => {
    const splitOff = create({
      seekPermissionsForKeyLinkageRevelation: true,
      seekPermissionsForCounterpartyKeyLinkageRevelation: false,
      seekPermissionsForSpecificKeyLinkageRevelation: false
    })
    const legacyCall = splitOff.manager.ensureProtocolPermission({
      originator: APP,
      privileged: false,
      protocolID: [2, 'legacy linkage'],
      counterparty: VERIFIER,
      usageType: 'linkageRevelation'
    })
    const queue = await queued(splitOff.manager)
    expect([...queue.values()]).toEqual([
      expect.objectContaining({ usageType: 'linkageRevelation', protocolID: [2, 'legacy linkage'] })
    ])
    await denyAll(splitOff.manager, queue.keys())
    await expect(legacyCall).rejects.toThrow(/Permission denied/)

    const legacyOff = create({
      seekPermissionsForKeyLinkageRevelation: false,
      seekPermissionsForCounterpartyKeyLinkageRevelation: true,
      seekPermissionsForSpecificKeyLinkageRevelation: true
    })
    await expect(
      legacyOff.manager.ensureProtocolPermission({
        originator: APP,
        privileged: false,
        protocolID: [2, 'legacy linkage'],
        counterparty: VERIFIER,
        usageType: 'linkageRevelation'
      })
    ).resolves.toBe(true)
    expect(((legacyOff.manager as any).activeRequests as Map<string, unknown>).size).toBe(0)
  })

  it('still refuses reserved-protocol specific linkage before asking for permission', async () => {
    for (const config of [
      {},
      { seekPermissionsForSpecificKeyLinkageRevelation: false },
      { seekPermissionsForKeyLinkageRevelation: false }
    ] satisfies PermissionsManagerConfig[]) {
      const { underlying, manager } = create(config)
      await expect(
        manager.revealSpecificKeyLinkage(
          {
            counterparty: COUNTERPARTY,
            verifier: VERIFIER,
            protocolID: [2, 'admin example'],
            keyID: '1'
          },
          APP
        )
      ).rejects.toThrow(/reserved protocol/)
      expect(underlying.revealSpecificKeyLinkage).not.toHaveBeenCalled()
      expect(((manager as any).activeRequests as Map<string, unknown>).size).toBe(0)
    }
  })
})
