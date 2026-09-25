import {
  KeyDeriver,
  LookupAnswer,
  LookupResolver,
  PrivateKey,
  WalletClient,
  WalletWireProcessor,
  WalletWireTransceiver
} from '@bsv/sdk'
import { Wallet } from '../Wallet'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { WalletSettingsManager } from '../WalletSettingsManager'
import { WalletStorageManager } from '../storage/WalletStorageManager'
import { WalletServices } from '../sdk/WalletServices.interfaces'
import {
  createIdentityVerificationFixture,
  IdentityVerificationFixture
} from '../utility/__tests__/identityVerification.fixtures'

// Signed identity certificate -> Wallet -> WalletPermissionsManager -> SDK WalletClient
// and binary BRC-100 wire, with no network access. Each caller path must apply the
// same overlay matching contract when re-binding results to the lookup they answered.

function managerFor(fixture: IdentityVerificationFixture): WalletPermissionsManager {
  const keyDeriver = new KeyDeriver(new PrivateKey(15))
  const trustSettings = {
    trustLevel: 1,
    trustedCertifiers: [
      {
        identityKey: fixture.certificate.certifier,
        name: 'Synthetic certifier',
        description: 'Synthetic identity test certifier',
        trust: 1
      }
    ]
  }
  const query = async (): Promise<LookupAnswer> => ({
    type: 'output-list',
    outputs: [{ beef: fixture.certificateBEEF, outputIndex: 0 }]
  })
  const wallet = new Wallet({
    chain: 'main',
    keyDeriver,
    storage: new WalletStorageManager(keyDeriver.identityKey),
    services: { getChainTracker: async () => fixture.confirmedTracker } as unknown as WalletServices,
    lookupResolver: { query } as unknown as LookupResolver,
    settingsManager: { get: async () => ({ trustSettings }) } as unknown as WalletSettingsManager
  })
  return new WalletPermissionsManager(wallet, 'admin.example', {
    seekPermissionsForIdentityResolution: false
  })
}

describe('identity discovery across BRC-100 caller paths', () => {
  let fixture: IdentityVerificationFixture
  beforeEach(async () => {
    fixture = await createIdentityVerificationFixture()
  })

  const callers = {
    'permission manager': (manager: WalletPermissionsManager) => manager,
    'SDK WalletClient': (manager: WalletPermissionsManager) => new WalletClient(manager, 'app.example'),
    'binary BRC-100 wire': (manager: WalletPermissionsManager) =>
      new WalletWireTransceiver(new WalletWireProcessor(manager))
  }

  describe.each(Object.entries(callers))('%s', (_, callerFor) => {
    it('returns the verified certificate for an identity-key lookup', async () => {
      const caller = callerFor(managerFor(fixture))
      const result = await caller.discoverByIdentityKey({ identityKey: fixture.certificate.subject }, 'app.example')
      expect(result.totalCertificates).toBe(1)
      expect(result.certificates[0].decryptedFields).toEqual({ name: 'Alice' })
    })

    it.each([{ name: 'Alice' }, { any: 'alice' }, { name: 'ali' }, { name: 'ali', company: ' ' }])(
      'returns the verified certificate for attributes %j',
      async attributes => {
        const caller = callerFor(managerFor(fixture))
        const result = await caller.discoverByAttributes({ attributes }, 'app.example')
        expect(result.totalCertificates).toBe(1)
        expect(result.certificates[0].subject).toBe(fixture.certificate.subject)
      }
    )

    it('still drops certificates that do not answer the lookup', async () => {
      const caller = callerFor(managerFor(fixture))
      await expect(
        caller.discoverByAttributes({ attributes: { any: 'mallory' } }, 'app.example')
      ).resolves.toEqual({ totalCertificates: 0, certificates: [] })
    })
  })
})
