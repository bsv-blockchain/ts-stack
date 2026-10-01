import { WalletCore } from '../../core/WalletCore'
import { createDIDMethods, DID } from '../did'

const PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('wallet identity-key DID methods', () => {
  it('uses only the selected wallet identity key without network or transaction operations', () => {
    const getClient = jest.fn(() => {
      throw new Error('No wallet operations permitted')
    })
    const core = { getIdentityKey: () => PUBLIC_KEY, getClient } as unknown as WalletCore
    const methods = createDIDMethods(core)
    const document = methods.getDID()
    expect(document.id).toBe(DID.fromIdentityKey(PUBLIC_KEY))
    expect(methods.resolveDID(document.id).didDocument).toEqual(document)
    expect(getClient).not.toHaveBeenCalled()
    for (const obsolete of ['createDID', 'updateDID', 'deactivateDID', 'registerDID', 'listDIDs']) {
      expect(methods).not.toHaveProperty(obsolete)
    }
  })
})
