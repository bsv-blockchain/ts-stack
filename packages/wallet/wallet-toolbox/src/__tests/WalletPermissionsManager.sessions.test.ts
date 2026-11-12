import { jest } from '@jest/globals'
import { mockUnderlyingWallet, MockedBSV_SDK } from './WalletPermissionsManager.fixtures'
import { WalletPermissionsManager, type PermissionRequest } from '../WalletPermissionsManager'
jest.mock('@bsv/sdk', () => MockedBSV_SDK)

const protocol = {
  originator: 'poker.example',
  privileged: false,
  protocolID: [2, 'poker transcript'] as [2, string],
  counterparty: 'anyone',
  usageType: 'signing' as const
}
function setup() {
  const underlying = mockUnderlyingWallet()
  const manager = new WalletPermissionsManager(underlying, 'admin.example', {
    differentiateActionLabelOperations: true,
    preferAppPermissionGroups: true
  })
  jest.spyOn(manager as any, 'findProtocolToken').mockResolvedValue(undefined)
  jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue(null)
  return { manager, underlying }
}

describe('bounded wallet session permissions', () => {
  it('allows a whole feature without token creation, isolates origins and counterparties, and revokes immediately', async () => {
    const { manager, underlying } = setup()
    manager.bindCallback('onProtocolPermissionRequested', async request => {
      await manager.grantPermission({ requestID: request.requestID, sessionDurationMs: 60_000 })
    })
    await expect(manager.ensureProtocolPermission(protocol)).resolves.toBe(true)
    await expect(manager.ensureProtocolPermission({ ...protocol, seekPermission: false })).resolves.toBe(true)
    await expect(
      manager.ensureProtocolPermission({ ...protocol, originator: 'other.example', seekPermission: false })
    ).rejects.toThrow()
    await expect(
      manager.ensureProtocolPermission({ ...protocol, counterparty: 'self', seekPermission: false })
    ).rejects.toThrow()
    expect(underlying.createAction).not.toHaveBeenCalled()
    expect(manager.listSessionPermissions()).toHaveLength(1)
    manager.revokeSessionPermissions('poker.example')
    await expect(manager.ensureProtocolPermission({ ...protocol, seekPermission: false })).rejects.toThrow()
  })

  it('expires and rejects invalid lifetimes without allowing the pending call', async () => {
    const { manager } = setup()
    manager.bindCallback('onProtocolPermissionRequested', async request => {
      await expect(
        manager.grantPermission({ requestID: request.requestID, sessionDurationMs: 1_800_001 })
      ).rejects.toThrow(/duration/)
      await manager.grantPermission({ requestID: request.requestID, sessionDurationMs: 10 })
    })
    await manager.ensureProtocolPermission(protocol)
    await new Promise(resolve => setTimeout(resolve, 15))
    await expect(manager.ensureProtocolPermission({ ...protocol, seekPermission: false })).rejects.toThrow()
  })

  it('separates applying a label from reading history and retains legacy broad grants', async () => {
    const { manager } = setup()
    const seen: PermissionRequest[] = []
    manager.bindCallback('onProtocolPermissionRequested', async request => {
      seen.push(request)
      await manager.grantPermission({ requestID: request.requestID, sessionDurationMs: 60_000 })
    })
    await manager.ensureLabelAccess({ originator: protocol.originator, label: 'Poker', usageType: 'apply' })
    await expect(
      manager.ensureLabelAccess({
        originator: protocol.originator,
        label: 'Poker',
        usageType: 'list',
        seekPermission: false
      })
    ).rejects.toThrow()
    expect(seen[0].actionLabel).toEqual({ label: 'Poker', operation: 'apply' })
    await manager.ensureLabelAccess({ originator: protocol.originator, label: 'Poker', usageType: 'list' })
    expect(seen).toHaveLength(2)
    expect(seen[1].usageType).toBe('labelList')
    await expect(
      manager.ensureProtocolPermission({ ...protocol, protocolID: [1, 'admin label apply Poker'] })
    ).rejects.toThrow(/admin-only/)
    const legacy = setup().manager
    jest.spyOn(legacy, 'hasProtocolPermission').mockResolvedValue(true)
    await expect(
      legacy.ensureLabelAccess({
        originator: protocol.originator,
        label: 'Poker',
        usageType: 'list',
        seekPermission: false
      })
    ).resolves.toBe(true)
  })

  it('groups ECPM and signatures across declared self/anyone scopes without minting', async () => {
    const { manager, underlying } = setup()
    const permissions = {
      protocolPermissions: [
        { protocolID: [2, 'p ecpm poker deck'] as [2, string], counterparty: 'self', description: 'Protect cards' },
        { protocolID: protocol.protocolID, counterparty: 'anyone', description: 'Sign gameplay' }
      ]
    }
    jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue(permissions)
    manager.bindCallback('onGroupedPermissionRequested', async request => {
      expect(request.permissions.protocolPermissions).toHaveLength(2)
      await manager.grantGroupedPermission({
        requestID: request.requestID,
        granted: request.permissions,
        sessionDurationMs: 60_000
      })
    })
    await manager.ensureProtocolPermission(protocol)
    await expect(
      manager.ensureProtocolPermission({
        ...protocol,
        protocolID: [2, 'p ecpm poker deck'],
        counterparty: 'self',
        seekPermission: false
      })
    ).resolves.toBe(true)
    expect(underlying.createAction).not.toHaveBeenCalled()
  })
  it('does not re-prompt for a capability unchecked in an explicit app group', async () => {
    const { manager } = setup()
    jest.spyOn(manager as any, 'fetchManifestGroupPermissions').mockResolvedValue({
      protocolPermissions: [
        { protocolID: protocol.protocolID, counterparty: 'anyone', description: 'Signing' },
        { protocolID: [2, 'p ecpm poker deck'], counterparty: 'self', description: 'Cards' }
      ]
    })
    const individual = jest.fn()
    manager.bindCallback('onProtocolPermissionRequested', individual)
    manager.bindCallback('onGroupedPermissionRequested', async request => {
      await manager.grantGroupedPermission({
        requestID: request.requestID,
        granted: {
          protocolPermissions: request.permissions.protocolPermissions!.filter(p => p.counterparty === 'self')
        },
        sessionDurationMs: 60_000
      })
    })
    await expect(manager.ensureProtocolPermission(protocol)).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
    expect(individual).not.toHaveBeenCalled()
  })
})
