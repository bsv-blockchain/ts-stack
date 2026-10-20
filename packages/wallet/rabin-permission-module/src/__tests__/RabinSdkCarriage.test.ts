import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CachedKeyDeriver,
  PrivateKey,
  WalletClient,
  WalletWireProcessor,
  WalletWireTransceiver,
  validateWalletResult,
  type WalletInterface
} from '@bsv/sdk'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { RabinPermissionModule } from '../RabinPermissionModule.js'
import type { RabinKeyDeriver } from '../types.js'
import { decodeRabinKey, decodeRabinSignature } from '../index.js'
import { verifyRabinSignature } from '../rabin.js'

const VECTOR_PATH = join(process.cwd(), 'conformance/vectors.json')
const seedHex = (
  JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as {
    keys: Array<{ seedHex: string; bits: number }>
  }
).keys.find(key => key.bits === 2048)?.seedHex

const PROTOCOL = [0, 'p rabin sign 2048 rabin oracle feed'] as const
const KEY_PROTOCOL = [0, 'p rabin key 2048 rabin oracle feed'] as const

function fastDeriver(): RabinKeyDeriver & { calls: number } {
  const state = {
    calls: 0,
    derivePrivateKey: () => {
      state.calls += 1
      return new PrivateKey(seedHex ?? '', 'hex', 'be', 'nocheck')
    }
  }
  return state
}

function hosted(module: RabinPermissionModule): {
  manager: WalletPermissionsManager
  client: WalletClient
  wire: WalletClient
} {
  const underlying = {
    async encrypt(): Promise<never> {
      throw new Error('underlying encrypt must not run')
    }
  } as unknown as WalletInterface
  const manager = new WalletPermissionsManager(underlying, 'admin.example', {
    permissionModules: { rabin: module }
  })
  return {
    manager,
    client: new WalletClient(manager, 'app.example'),
    wire: new WalletClient(
      new WalletWireTransceiver(new WalletWireProcessor(manager)),
      'app.example'
    )
  }
}

describe('Rabin SDK carriage', () => {
  it('returns an encrypt result the SDK accepts and both clients can carry', async () => {
    expect(seedHex).toMatch(/^[0-9a-f]{64}$/)
    const deriver = fastDeriver()
    const module = new RabinPermissionModule({ keyDeriver: deriver })
    const { client, wire } = hosted(module)
    const plaintext = [...Buffer.from('rabin')]

    const direct = await client.encrypt({
      protocolID: [...PROTOCOL],
      keyID: 'price',
      plaintext
    })
    expect(() => validateWalletResult('encrypt', direct)).not.toThrow()
    expect(
      direct.ciphertext.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ).toBe(true)

    const carried = await wire.encrypt({
      protocolID: [...PROTOCOL],
      keyID: 'price',
      plaintext
    })
    expect(carried.ciphertext).toEqual(direct.ciphertext)
    expect(deriver.calls).toBe(1)

    const key = await client.encrypt({
      protocolID: [...KEY_PROTOCOL],
      keyID: 'price',
      plaintext: []
    })
    expect(() => validateWalletResult('encrypt', key)).not.toThrow()
    const modulus = decodeRabinKey(key.ciphertext)
    const signature = decodeRabinSignature(direct.ciphertext)
    expect(
      await verifyRabinSignature(
        Uint8Array.from(plaintext),
        signature.signature,
        signature.padding,
        modulus
      )
    ).toBe(true)

    await expect(
      client.decrypt({
        protocolID: [...PROTOCOL],
        keyID: 'price',
        ciphertext: direct.ciphertext
      })
    ).rejects.toThrow('square-root oracle')
    await expect(
      wire.decrypt({
        protocolID: [...KEY_PROTOCOL],
        keyID: 'price',
        ciphertext: key.ciphertext
      })
    ).rejects.toThrow('Wallet operation failed')
    expect(deriver.calls).toBe(1)
    module.dispose()
  })

  it('derives the carriage seed through BRC-42 before HKDF', async () => {
    const root = new PrivateKey(11)
    let observed = ''
    const module = new RabinPermissionModule({
      keyDeriver: {
        derivePrivateKey: (protocol, keyID, counterparty) => {
          const scalar = new CachedKeyDeriver(root).derivePrivateKey(protocol, keyID, counterparty)
          observed = scalar.toHex()
          return scalar
        }
      }
    })
    const { manager } = hosted(module)
    const result = await manager.encrypt(
      {
        protocolID: [0, 'p rabin key 2048 brc42 rabin probe'],
        keyID: 'probe',
        plaintext: [],
        counterparty: 'self'
      },
      'app.example'
    )
    expect(observed).toMatch(/^[0-9a-f]{64}$/)
    expect(() => validateWalletResult('encrypt', result)).not.toThrow()
    expect(decodeRabinKey(result.ciphertext) > 0n).toBe(true)
    module.dispose()
  })
})
