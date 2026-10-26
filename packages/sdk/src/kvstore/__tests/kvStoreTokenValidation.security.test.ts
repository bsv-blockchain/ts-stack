import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import LockingScript from '../../script/LockingScript'
import PushDrop from '../../script/templates/PushDrop'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { WalletProtocol } from '../../wallet/Wallet.interfaces'
import { decodeAndVerifyKVStoreToken } from '../kvStoreTokenValidation'

const protocolID: WalletProtocol = [1, 'kvstore']
const key = 'security-key'

async function token(
  wallet = new ProtoWallet(PrivateKey.fromRandom()),
  overrides: Partial<Record<number, number[]>> = {},
  tags?: string[]
): Promise<{ lockingScript: LockingScript; controller: string }> {
  const { publicKey: controller } = await wallet.getPublicKey({ identityKey: true })
  const fields = [
    Utils.toArray(JSON.stringify(protocolID), 'utf8'),
    Utils.toArray(key, 'utf8'),
    Utils.toArray('security-value', 'utf8'),
    Utils.toArray(controller, 'hex')
  ]
  if (tags !== undefined) fields.push(Utils.toArray(JSON.stringify(tags), 'utf8'))
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
  return {
    controller,
    lockingScript: await new PushDrop(wallet).lock(fields, protocolID, key, 'anyone', true)
  }
}

describe('GlobalKVStore token authentication', () => {
  it('accepts a canonical controller-signed token linked to the claimed controller', async () => {
    const { lockingScript, controller } = await token(undefined, undefined, ['one', 'two'])

    await expect(decodeAndVerifyKVStoreToken(lockingScript)).resolves.toEqual({
      protocolID,
      protocolIDText: JSON.stringify(protocolID),
      key,
      value: 'security-value',
      controller,
      tags: ['one', 'two']
    })
  })

  it('rejects an attacker token that claims a different controller', async () => {
    const attackerWallet = new ProtoWallet(PrivateKey.fromRandom())
    const victim = PrivateKey.fromRandom().toPublicKey().toString()
    const { lockingScript } = await token(attackerWallet, {
      3: Utils.toArray(victim, 'hex')
    })

    await expect(decodeAndVerifyKVStoreToken(lockingScript)).rejects.toThrow(/controller|signature/)
  })

  it('rejects a payload changed after it was signed', async () => {
    const { lockingScript } = await token()
    const chunks = lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[4].data![0] ^= 1

    await expect(decodeAndVerifyKVStoreToken(new LockingScript(chunks))).rejects.toThrow(
      /signature/i
    )
  })

  it('rejects non-canonical push encodings', async () => {
    const { lockingScript } = await token()
    const chunks = lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[2].op = 0x4c

    await expect(decodeAndVerifyKVStoreToken(new LockingScript(chunks))).rejects.toThrow(
      'canonical PushDrop'
    )
  })

  it('rejects malformed UTF-8 and invalid signed tag schemas', async () => {
    const malformed = await token(undefined, { 2: [0xc3, 0x28] })
    const invalidTags = await token(undefined, { 4: Utils.toArray('{"not":"tags"}', 'utf8') }, [])

    await expect(decodeAndVerifyKVStoreToken(malformed.lockingScript)).rejects.toThrow(/utf-8/i)
    await expect(decodeAndVerifyKVStoreToken(invalidTags.lockingScript)).rejects.toThrow(/tags/i)
  })
})
