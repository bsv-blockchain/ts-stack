import { CompletedProtoWallet, PrivateKey, SignedMessage, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import { signBRC77, verifyBRC77 } from './brc77.js'

const key = PrivateKey.fromRandom()
const wallet = new CompletedProtoWallet(key)
const signer = key.toPublicKey().toString()
const message = Utils.toArray('BRC-178 attestation\nexample', 'utf8')

describe('BRC-77 over a wallet', () => {
  it('produces signatures SignedMessage.verify accepts', async () => {
    const signature = await signBRC77(wallet, message)
    expect(SignedMessage.verify(message, signature)).toBe(true)
    expect(verifyBRC77(message, signature)).toEqual({ valid: true, signer })
  })

  it('accepts signatures made by SignedMessage.sign with a raw key', () => {
    expect(verifyBRC77(message, SignedMessage.sign(message, key))).toEqual({ valid: true, signer })
  })

  it('uses a fresh key ID for every signature', async () => {
    expect(await signBRC77(wallet, message)).not.toEqual(await signBRC77(wallet, message))
  })

  it('rejects a tampered message', async () => {
    const signature = await signBRC77(wallet, message)
    expect(verifyBRC77([...message, 0], signature).valid).toBe(false)
  })

  it('rejects recipient-bound signatures, wrong versions, and truncated input', async () => {
    const recipient = PrivateKey.fromRandom().toPublicKey()
    expect(verifyBRC77(message, SignedMessage.sign(message, key, recipient)).valid).toBe(false)
    const signature = await signBRC77(wallet, message)
    expect(verifyBRC77(message, [0, ...signature.slice(1)]).valid).toBe(false)
    expect(verifyBRC77(message, signature.slice(0, 40)).valid).toBe(false)
    expect(verifyBRC77(message, []).valid).toBe(false)
  })
})
