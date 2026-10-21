import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LockingScript, Spend, UnlockingScript } from '@bsv/sdk'
import { bytesToHex, hexToBytes, leToBigint } from '../bytes.js'
import { sha256 } from '../hkdf.js'
import { deriveRabinFactors, verifyRabinSignature } from '../rabin.js'
import { decodeRabinKey, decodeRabinSignature } from '../RabinPermissionModule.js'
import { encodeScriptNumber, pushScriptNumber, RABIN_PADDING_LIMIT } from '../scriptNumber.js'

const VECTOR_PATH = join(process.cwd(), 'conformance/vectors.json')
const CHECKER = join(process.cwd(), 'conformance/rabin_check.py')

interface SignatureVector {
  messageHex: string
  sigHex: string
  padding: number
  paddingScriptHex: string
  ciphertextHex: string
}

interface KeyVector {
  id: string
  bits: 2048 | 3072 | 4096
  seedHex: string
  pHex: string
  qHex: string
  nHex: string
  keyCiphertextHex: string
  signatures: SignatureVector[]
}

interface VectorDocument {
  salt: string
  keys: KeyVector[]
}

const vectors = JSON.parse(readFileSync(VECTOR_PATH, 'utf8')) as VectorDocument

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Rúnar's on-chain check, including the padding bound that rejects a zero signature whose
 * padding would otherwise be the digest. Stack on entry is signature, then padding.
 */
function rabinLock(modulus: bigint, digest: bigint): LockingScript {
  const program = concat([
    Uint8Array.of(0x76),
    pushScriptNumber(RABIN_PADDING_LIMIT),
    Uint8Array.of(0x9f, 0x69, 0x7c, 0x76, 0x95, 0x93),
    pushScriptNumber(modulus),
    Uint8Array.of(0x97),
    pushScriptNumber(digest),
    Uint8Array.of(0x87)
  ])
  return LockingScript.fromBinary([...program])
}

function spend(lockingScript: LockingScript, unlocking: Uint8Array): boolean {
  try {
    return new Spend({
      sourceTXID: '11'.repeat(32),
      sourceOutputIndex: 0,
      sourceSatoshis: 1,
      lockingScript,
      transactionVersion: 1,
      otherInputs: [],
      outputs: [],
      inputIndex: 0,
      unlockingScript: UnlockingScript.fromBinary([...unlocking]),
      inputSequence: 0xffffffff,
      lockTime: 0
    }).validateJavaScript()
  } catch {
    return false
  }
}

describe('BRC-206 Rabin conformance', () => {
  it('matches the independent Python checker for every committed vector', () => {
    const output = execFileSync('python3', [CHECKER, '--vectors'], {
      encoding: 'utf8'
    })
    expect(output).toContain('checked 3 keys')
    expect(vectors.salt).toBe('BRC-206 p rabin v1')
  })

  it('does not open a caller-supplied checker path', () => {
    const outside = join(process.cwd(), '..', '..', '..', '..', 'etc', 'passwd')
    expect(() =>
      execFileSync('python3', [CHECKER, '--vectors', outside], { encoding: 'utf8' })
    ).toThrow(/usage:/)
    expect(() =>
      execFileSync('python3', [CHECKER, '--generate', outside], { encoding: 'utf8' })
    ).toThrow(/usage:/)
  })

  it('re-derives the 2048-bit vector in TypeScript and verifies every size on chain', async () => {
    for (const key of vectors.keys) {
      const modulus = BigInt(`0x${key.nHex}`)
      const keyBytes = hexToBytes(key.keyCiphertextHex)
      expect(decodeRabinKey([...keyBytes])).toBe(modulus)
      expect(bytesToHex(keyBytes)).toBe(key.keyCiphertextHex)

      if (key.bits === 2048) {
        const factors = await deriveRabinFactors(hexToBytes(key.seedHex), key.bits)
        try {
          expect(bytesToHex(factors.p)).toBe(key.pHex)
          expect(bytesToHex(factors.q)).toBe(key.qHex)
          expect(factors.n).toBe(modulus)
        } finally {
          factors.wipe()
        }
      }

      for (const signature of key.signatures) {
        const message = hexToBytes(signature.messageHex)
        const sig = BigInt(`0x${signature.sigHex}`)
        const ciphertext = hexToBytes(signature.ciphertextHex)
        expect(decodeRabinSignature([...ciphertext])).toEqual({
          signature: sig,
          padding: BigInt(signature.padding)
        })
        expect(encodeScriptNumber(BigInt(signature.padding))).toEqual(
          hexToBytes(signature.paddingScriptHex)
        )
        expect(await verifyRabinSignature(message, sig, BigInt(signature.padding), modulus)).toBe(
          true
        )
        const digest = leToBigint(await sha256(message))
        expect(spend(rabinLock(modulus, digest), ciphertext)).toBe(true)

        const forged = ciphertext.slice()
        forged[forged.length - 1] ^= 0x01
        expect(spend(rabinLock(modulus, digest), forged)).toBe(false)
        expect(await verifyRabinSignature(message, 0n, digest, modulus)).toBe(false)
      }
    }
  })
})
