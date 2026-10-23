import { describe, expect, it } from '@jest/globals'
import * as client from '@bsv/wallet-toolbox-client'
import * as mobile from '@bsv/wallet-toolbox-mobile'

// React Native hosts alias @bsv/wallet-toolbox-client to
// @bsv/wallet-toolbox-mobile (contract §2.6, D21). Every toolbox symbol the
// module imports must therefore exist, with the same shape, in the mobile
// entry. A gap is fixed by a named export in wallet-toolbox/src/index.mobile.ts,
// never by forking the module.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Type-level parity: fails to compile if the mobile entry drops or changes a
// type the module imports from the client entry.
const typeParity: [
  Same<client.PermissionsModule, mobile.PermissionsModule>,
  Same<client.PermissionsModuleAction, mobile.PermissionsModuleAction>,
  Same<client.PermissionsModuleNext, mobile.PermissionsModuleNext>,
  Same<client.PermissionsModuleRequest, mobile.PermissionsModuleRequest>
] = [true, true, true, true]

describe('@bsv/wallet-toolbox-mobile export parity', () => {
  it('exports every toolbox value the module imports', () => {
    expect(typeof mobile.encryptMetadata).toBe('function')
    expect(typeof mobile.maybeDecryptMetadata).toBe('function')
    expect(typeof mobile.sdk.specOpBasketPrefixOutputs).toBe('string')
    expect(mobile.sdk.specOpBasketPrefixOutputs).toBe(client.sdk.specOpBasketPrefixOutputs)
  })

  it('exports every toolbox type the module imports', () => {
    expect(typeParity).toEqual([true, true, true, true])
  })
})
