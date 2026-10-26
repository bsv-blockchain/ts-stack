import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import LockingScript from '../../script/LockingScript'
import PushDrop from '../../script/templates/PushDrop'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { WalletProtocol } from '../../wallet/Wallet.interfaces'
import { decodeAndVerifyRegistryToken } from '../registryTokenValidation'

const protocolID: WalletProtocol = [1, 'basketmap']

async function validToken(overrides: Partial<Record<number, number[]>> = {}): Promise<{
  lockingScript: LockingScript
  operator: string
}> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const { publicKey: operator } = await wallet.getPublicKey({ identityKey: true })
  const fields = [
    Utils.toArray('payments', 'utf8'),
    Utils.toArray('Payments', 'utf8'),
    Utils.toArray('https://example.com/icon.png', 'utf8'),
    Utils.toArray('Payment outputs', 'utf8'),
    Utils.toArray('https://example.com/docs', 'utf8'),
    Utils.toArray(operator, 'utf8')
  ].map((field, index) => overrides[index] ?? field)
  const lockingScript = await new PushDrop(wallet).lock(fields, protocolID, '1', 'anyone', true)
  return { lockingScript, operator }
}

describe('registry token authentication', () => {
  it('accepts a canonical signed token linked to its registry operator', async () => {
    const { lockingScript, operator } = await validToken()

    await expect(decodeAndVerifyRegistryToken('basket', lockingScript)).resolves.toEqual([
      'payments',
      'Payments',
      'https://example.com/icon.png',
      'Payment outputs',
      'https://example.com/docs',
      operator
    ])
  })

  it('rejects a payload changed after the operator signed it', async () => {
    const { lockingScript } = await validToken()
    const chunks = lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[2].data![0] ^= 1

    await expect(decodeAndVerifyRegistryToken('basket', new LockingScript(chunks))).rejects.toThrow(
      /[Ss]ignature/
    )
  })

  it('rejects a non-canonical PushDrop envelope even when its decoded fields are signed', async () => {
    const { lockingScript } = await validToken()
    const chunks = lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[2].op = 0x4c

    await expect(decodeAndVerifyRegistryToken('basket', new LockingScript(chunks))).rejects.toThrow(
      'canonical PushDrop'
    )
  })

  it('rejects malformed UTF-8 even when the operator signed the exact bytes', async () => {
    const { lockingScript } = await validToken({ 0: [0xc3, 0x28] })

    await expect(decodeAndVerifyRegistryToken('basket', lockingScript)).rejects.toThrow(/utf-8/i)
  })

  it('rejects oversized signed fields', async () => {
    const { lockingScript } = await validToken({
      3: Array.from({ length: 16 * 1024 + 1 }, () => 65)
    })

    await expect(decodeAndVerifyRegistryToken('basket', lockingScript)).rejects.toThrow(
      'oversized field'
    )
  })
})
