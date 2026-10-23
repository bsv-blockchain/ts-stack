import type { WalletEncryptArgs as EncryptArgs } from '@bsv/sdk'
import type { RabinPermissionModule } from '../RabinPermissionModule.js'
import vectorsJson from './fixtures/brc206-vectors.json'

export interface KeyVector {
  name: string
  request: { protocolID: [2, string]; keyID: string; counterparty: string; plaintext: string }
  derivation: { rootPrivateKey: string; derivationProtocolID: [2, string]; seed: string }
  expansion: { info: string; okmLength: number; okm: string }
  key: {
    bits: 2048 | 3072 | 4096
    p: string
    q: string
    n: string
    pOffset: number
    qOffset: number
  }
  response: { ciphertext: string; nScriptNum: string }
}

export interface SignatureVector {
  name: string
  keyVector: string
  request: { protocolID: [2, string]; keyID: string; counterparty: string; plaintext: string }
  message: { hex: string; sha256: string; h: string }
  signature: { padding: number; sig: string; sigScriptNum: string; paddingScriptNum: string }
  response: { ciphertext: string }
}

export interface Vectors {
  parameters: {
    walletA: string
    walletB: string
    walletBIdentity: string
    logicalProtocolID: string
    keyID: string
  }
  keys: KeyVector[]
  signatures: SignatureVector[]
  paddingEncodings: Array<{ padding: number; scriptNum: string }>
}

export const vectors = vectorsJson as unknown as Vectors

export const keyVector = (name: string): KeyVector => {
  const found = vectors.keys.find(vector => vector.name === name)
  if (found === undefined) throw new Error(`missing key vector ${name}`)
  return found
}

export const fromHex = (hex: string): number[] => {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

export const toHex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

export const beHex = (hex: string): bigint => BigInt(`0x${hex}`)

export const ORIGINATOR = 'oracle.example'

export const encryptArgs = (
  operation: 'key' | 'sign',
  overrides: Partial<EncryptArgs> = {},
  bits = 2048
): EncryptArgs => ({
  protocolID: [0, `p rabin ${operation} ${bits} example oracle`],
  keyID: 'feed 1',
  counterparty: 'self',
  plaintext: operation === 'sign' ? [0x61, 0x62, 0x63] : [],
  ...overrides
})

export const execute = async (
  module: RabinPermissionModule,
  args: unknown,
  method = 'encrypt',
  originator: unknown = ORIGINATOR
): Promise<{ ciphertext: number[] }> =>
  await module.handleRequest(
    { method, args: args as object, originator: originator as string },
    async () => {
      throw new Error('underlying wallet must not be called')
    }
  )

export const observe = async <T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  await promise.then(
    value => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
