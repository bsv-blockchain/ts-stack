import { PrivateKey } from '../../primitives/index.js'
import * as Utils from '../../primitives/utils.js'
import LockingScript from '../../script/LockingScript.js'
import PushDrop from '../../script/templates/PushDrop.js'
import ProtoWallet from '../../wallet/ProtoWallet.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import {
  decodeAndVerifyUHRPAdvertisement,
  MAX_UHRP_ADVERTISEMENT_URL_BYTES
} from '../UHRPAdvertisementValidation.js'

async function token(
  overrides: Partial<{ url: number[]; expiry: number[]; size: number[]; extra: number[] }> = {}
): Promise<LockingScript> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const identity = await wallet.getPublicKey({ identityKey: true })
  const fields = [
    Utils.toArray(identity.publicKey, 'hex'),
    Array.from({ length: 32 }, (_, index) => index),
    overrides.url ?? Utils.toArray('https://files.example/object', 'utf8'),
    overrides.expiry ?? new Utils.Writer().writeVarIntNum(2_000_000_000).toArray(),
    overrides.size ?? new Utils.Writer().writeVarIntNum(1234).toArray()
  ]
  if (overrides.extra !== undefined) fields.push(overrides.extra)
  return await new PushDrop(wallet as unknown as WalletInterface).lock(
    fields,
    [2, 'uhrp advertisement'],
    '1',
    'anyone',
    true
  )
}

describe('UHRP advertisement authentication', () => {
  it('accepts an exact canonical host-signed token', async () => {
    const decoded = await decodeAndVerifyUHRPAdvertisement(await token())
    expect(decoded.hostIdentityKey).toMatch(/^(02|03)[0-9a-f]{64}$/)
    expect(decoded.hash).toHaveLength(32)
    expect(decoded.hostedFileLocation).toBe('https://files.example/object')
    expect(decoded.expiryTime).toBe(2_000_000_000)
    expect(decoded.fileSize).toBe(1234)
  })

  it('rejects extra signed fields rather than interpreting a prefix', async () => {
    await expect(decodeAndVerifyUHRPAdvertisement(await token({ extra: [1] }))).rejects.toThrow(
      'field count'
    )
  })

  it('rejects CompactSize values with trailing bytes', async () => {
    await expect(
      decodeAndVerifyUHRPAdvertisement(await token({ expiry: [1, 0] }))
    ).rejects.toThrow('expiry time')
  })

  it('rejects oversized or credential-bearing locations', async () => {
    await expect(
      decodeAndVerifyUHRPAdvertisement(
        await token({ url: Utils.toArray(`https://example.com/${'a'.repeat(MAX_UHRP_ADVERTISEMENT_URL_BYTES)}`, 'utf8') })
      )
    ).rejects.toThrow(/oversized|payload|URL/)
    await expect(
      decodeAndVerifyUHRPAdvertisement(
        await token({ url: Utils.toArray('https://user:secret@example.com/file', 'utf8') })
      )
    ).rejects.toThrow('credential-free')
  })

  it('rejects non-canonical script suffixes', async () => {
    const valid = await token()
    const withSuffix = new LockingScript([...valid.chunks, { op: 0x61 }])
    await expect(decodeAndVerifyUHRPAdvertisement(withSuffix)).rejects.toThrow()
  })
})
