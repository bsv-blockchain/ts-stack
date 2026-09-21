import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { GroupMessagingError } from '../../errors.js'
import { IdentityService } from '../../identity/index.js'
import { DEFAULT_CIPHERSUITE } from '../../types.js'
import { MlsEngine } from '../engine.js'
import { decodeState, encodeState } from '../state.js'

describe('group state serialization', () => {
  it('round-trips and re-attaches the authentication service', async () => {
    const identity = await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom()))
    const engine = new MlsEngine({ identity })
    const minted = await engine.createKeyPackage()
    const { state } = await engine.createGroup({
      keyPackage: minted.keyPackage,
      privateKeyPackage: minted.privateKeyPackage
    })

    const restored = decodeState(state, DEFAULT_CIPHERSUITE)

    // decodeGroupState drops clientConfig; without re-attaching it, every
    // credential check silently reverts to the permissive default.
    expect(
      await restored.clientConfig.authService.validateCredential(
        { credentialType: 'basic', identity: new Uint8Array([1]) },
        new Uint8Array(32)
      )
    ).toBe(false)

    expect(encodeState(restored)).toEqual(state)
  })

  it('rejects undecodable bytes', () => {
    expect(() => decodeState(new Uint8Array([1, 2, 3]), DEFAULT_CIPHERSUITE)).toThrow()
  })

  it('rejects bytes appended after a valid state', async () => {
    const identity = await IdentityService.open(new KeyDeriver(PrivateKey.fromRandom()))
    const engine = new MlsEngine({ identity })
    const minted = await engine.createKeyPackage()
    const { state } = await engine.createGroup({
      keyPackage: minted.keyPackage,
      privateKeyPackage: minted.privateKeyPackage
    })

    const padded = new Uint8Array(state.length + 1)
    padded.set(state)

    expect(() => decodeState(padded, DEFAULT_CIPHERSUITE)).toThrow(GroupMessagingError)
  })
})
