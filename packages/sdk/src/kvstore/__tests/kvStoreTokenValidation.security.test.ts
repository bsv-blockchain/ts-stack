import PrivateKey from '../../primitives/PrivateKey'
import * as Utils from '../../primitives/utils'
import LockingScript from '../../script/LockingScript'
import PushDrop from '../../script/templates/PushDrop'
import ProtoWallet from '../../wallet/ProtoWallet'
import type { WalletProtocol } from '../../wallet/Wallet.interfaces'
import { decodeAndVerifyKVStoreToken, validateKVStoreTags } from '../kvStoreTokenValidation'

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

  it.each([33, 60, 240, 1024])(
    'authenticates all %i signed tags without a count cap',
    async count => {
      const tags = Array.from({ length: count }, (_, index) => `post:${index}`)
      const { lockingScript } = await token(undefined, undefined, tags)

      await expect(decodeAndVerifyKVStoreToken(lockingScript)).resolves.toEqual(
        expect.objectContaining({ tags })
      )
    }
  )

  it.each([
    ['duplicate', 'post:0', /unique/],
    ['empty', '', /length/],
    ['oversized UTF-8', 'é'.repeat(129), /length/],
    ['non-string', 42, /length/]
  ])('still rejects a %s tag after the former count boundary', async (_name, tag, error) => {
    const tags = [...Array.from({ length: 33 }, (_, index) => `post:${index}`), tag]
    const { lockingScript } = await token(undefined, undefined, tags as string[])

    await expect(decodeAndVerifyKVStoreToken(lockingScript)).rejects.toThrow(error as RegExp)
  })

  it('retains the signed-token field byte bound for an oversized tag payload', async () => {
    const { lockingScript } = await token(undefined, undefined, ['one'])
    const chunks = lockingScript.chunks.map(chunk => ({
      op: chunk.op,
      data: chunk.data == null ? undefined : [...chunk.data]
    }))
    chunks[6] = { op: 0x4e, data: Array.from({ length: 1024 * 1024 + 1 }, () => 0x61) }

    await expect(decodeAndVerifyKVStoreToken(new LockingScript(chunks))).rejects.toThrow(
      'oversized field'
    )
  })

  it.each([
    ['protocol shape', 0, '{}', /exactly two fields/],
    ['protocol security level', 0, '[3,"kvstore"]', /protocol ID is invalid/],
    ['key byte bound', 1, 'k'.repeat(801), /key has an invalid length/],
    ['value byte bound', 2, 'v'.repeat(1024 * 1024 + 1), /oversized field/]
  ])('preserves the %s check when lifting the tag-count cap', async (_name, field, text, error) => {
    const tags = Array.from({ length: 60 }, (_, index) => `post:${index}`)
    const { lockingScript } = await token(
      undefined,
      { [field as number]: Utils.toArray(text as string, 'utf8') },
      tags
    )

    await expect(decodeAndVerifyKVStoreToken(lockingScript)).rejects.toThrow(error as RegExp)
  })

  it('preserves the compressed-controller byte bound for larger tag sets', async () => {
    const tags = Array.from({ length: 60 }, (_, index) => `post:${index}`)
    const { lockingScript } = await token(
      undefined,
      { 3: Array.from({ length: 32 }, () => 0x11) },
      tags
    )

    await expect(decodeAndVerifyKVStoreToken(lockingScript)).rejects.toThrow(
      'controller is invalid'
    )
  })

  it('preserves the existing error identity and diagnostic for a non-array tag schema', () => {
    let failure: unknown
    try {
      validateKVStoreTags({ tags: [] })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect(Object.getPrototypeOf(failure)).toBe(Error.prototype)
    expect(failure).toHaveProperty('message', 'KVStore tags must be a bounded array')
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
