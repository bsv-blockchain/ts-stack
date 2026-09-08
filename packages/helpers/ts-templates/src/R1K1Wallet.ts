import {
  Hash,
  LockingScript,
  OP,
  PrivateKey,
  Script,
  type ScriptTemplate,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import {
  R1_K1_K1_SLOT_OFFSET,
  R1_K1_R1_CODE_SEPARATOR_OFFSET,
  R1_K1_R1_SLOT_OFFSET,
  R1_K1_TEMPLATE_BYTE_LENGTH,
  R1_K1_TEMPLATE_GZIP_BASE64,
  R1_K1_TEMPLATE_SHA256
} from './R1K1Wallet.artifact.js'

export type R1K1Bytes = string | number[] | Uint8Array

/**
 * Signs an already-hashed 32-byte transaction digest with a P-256 key.
 *
 * A YubiKey PIV implementation should pass this digest unchanged to the PIV
 * GENERAL AUTHENTICATE command and return either its DER ECDSA signature or a
 * raw 64-byte r || s signature.
 */
export type R1K1P256DigestSigner = (digest: Uint8Array) => Promise<R1K1Bytes> | R1K1Bytes

export interface R1K1R1UnlockParams {
  path: 'r1'
  publicKey: R1K1Bytes
  salt: R1K1Bytes
  signDigest: R1K1P256DigestSigner
  sourceSatoshis?: number
  lockingScript?: Script
}

export interface R1K1K1UnlockParams {
  path: 'k1'
  privateKey: PrivateKey
  sourceSatoshis?: number
  lockingScript?: Script
}

export type R1K1UnlockParams = R1K1R1UnlockParams | R1K1K1UnlockParams

interface SourceDetails {
  sourceTXID: string
  sourceSatoshis: number
  lockingScript: Script
}

const SIGHASH_ALL_FORKID = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
const CONSTRUCTOR_SLOT_EXPANSION = 20
const BAKED_SCRIPT_BYTE_LENGTH = R1_K1_TEMPLATE_BYTE_LENGTH + 2 * CONSTRUCTOR_SLOT_EXPANSION
const BAKED_R1_CODE_SEPARATOR_OFFSET = R1_K1_R1_CODE_SEPARATOR_OFFSET + CONSTRUCTOR_SLOT_EXPANSION
const BAKED_K1_SLOT_OFFSET = R1_K1_K1_SLOT_OFFSET + CONSTRUCTOR_SLOT_EXPANSION

let templateBytesPromise: Promise<Uint8Array> | undefined

export class R1K1Wallet implements ScriptTemplate {
  static readonly compiledTemplateByteLength = R1_K1_TEMPLATE_BYTE_LENGTH
  static readonly lockingScriptByteLength = BAKED_SCRIPT_BYTE_LENGTH

  async lock(r1SaltedPublicKeyHash: R1K1Bytes, k1PublicKeyHash: R1K1Bytes): Promise<LockingScript> {
    const r1Hash = normalizeBytes(r1SaltedPublicKeyHash, 'R1 salted public key hash', 20)
    const k1Hash = normalizeBytes(k1PublicKeyHash, 'K1 public key hash', 20)
    const template = await loadTemplateBytes()
    const scriptBytes = substituteConstructorSlots(template, r1Hash, k1Hash)
    return new LockingScript([], scriptBytes, undefined, false)
  }

  unlock(params: R1K1UnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  } {
    return params.path === 'r1' ? this.unlockR1(params) : this.unlockK1(params)
  }

  unlockR1(params: Omit<R1K1R1UnlockParams, 'path'> | R1K1R1UnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  } {
    const publicKey = normalizeBytes(params.publicKey, 'R1 public key', 33)
    if (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) {
      throw new Error('R1 public key must use compressed P-256 encoding')
    }
    const salt = normalizeBytes(params.salt, 'R1 salt', 32)

    const buildPreimage = async (tx: Transaction, inputIndex: number): Promise<Uint8Array> => {
      const source = resolveSourceDetails(
        tx,
        inputIndex,
        params.sourceSatoshis,
        params.lockingScript
      )
      const lockingBytes = await validateLockingScript(source.lockingScript)
      const expectedCommitment = lockingBytes.subarray(
        R1_K1_R1_SLOT_OFFSET + 1,
        R1_K1_R1_SLOT_OFFSET + 21
      )
      if (!equalBytes(Hash.hash160([...publicKey, ...salt]), expectedCommitment)) {
        throw new Error('R1 public key and salt do not match the locking script commitment')
      }
      const subscriptBytes = lockingBytes.subarray(BAKED_R1_CODE_SEPARATOR_OFFSET + 1)
      const subscript = new Script([], subscriptBytes, undefined, false)
      return formatPreimage(tx, inputIndex, source, subscript)
    }

    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        const preimage = await buildPreimage(tx, inputIndex)
        const digest = Uint8Array.from(Hash.hash256(preimage))
        const signature = normalizeP256Signature(await params.signDigest(digest))
        return new UnlockingScript()
          .writeBin(signature)
          .writeBin(publicKey)
          .writeBin(salt)
          .writeBin(Array.from(preimage))
          .writeOpCode(OP.OP_0)
      },
      estimateLength: async (tx: Transaction, inputIndex: number) => {
        const preimageLength = (await buildPreimage(tx, inputIndex)).length
        return (
          encodedPushLength(64) +
          encodedPushLength(publicKey.length) +
          encodedPushLength(salt.length) +
          encodedPushLength(preimageLength) +
          1
        )
      }
    }
  }

  unlockK1(params: Omit<R1K1K1UnlockParams, 'path'> | R1K1K1UnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<109>
  } {
    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        const source = resolveSourceDetails(
          tx,
          inputIndex,
          params.sourceSatoshis,
          params.lockingScript
        )
        const lockingBytes = await validateLockingScript(source.lockingScript)
        const publicKey = params.privateKey.toPublicKey().encode(true) as number[]
        const expectedCommitment = lockingBytes.subarray(
          BAKED_K1_SLOT_OFFSET + 1,
          BAKED_K1_SLOT_OFFSET + 21
        )
        if (!equalBytes(Hash.hash160(publicKey), expectedCommitment)) {
          throw new Error('K1 private key does not match the locking script commitment')
        }

        const preimage = formatPreimage(tx, inputIndex, source, source.lockingScript)
        // PrivateKey.sign hashes once internally, so pre-hash once to produce
        // the HASH256(preimage) digest used by OP_CHECKSIG.
        const rawSignature = params.privateKey.sign(Hash.sha256(preimage))
        const signature = new TransactionSignature(
          rawSignature.r,
          rawSignature.s,
          SIGHASH_ALL_FORKID
        ).toChecksigFormat()
        return new UnlockingScript().writeBin(signature).writeBin(publicKey).writeOpCode(OP.OP_1)
      },
      estimateLength: async () => 109
    }
  }
}

async function loadTemplateBytes(): Promise<Uint8Array> {
  templateBytesPromise ??= (async () => {
    const compressed = Uint8Array.from(Utils.toArray(R1_K1_TEMPLATE_GZIP_BASE64, 'base64'))
    const input = new Blob([compressed.buffer as ArrayBuffer]).stream()
    const decompressed = input.pipeThrough(new DecompressionStream('gzip'))
    const bytes = new Uint8Array(await new Response(decompressed).arrayBuffer())
    if (bytes.length !== R1_K1_TEMPLATE_BYTE_LENGTH) {
      throw new Error(`R1-K1 artifact length mismatch: expected ${R1_K1_TEMPLATE_BYTE_LENGTH}`)
    }
    if (Utils.toHex(Hash.sha256(bytes)) !== R1_K1_TEMPLATE_SHA256) {
      throw new Error('R1-K1 artifact checksum mismatch')
    }
    return bytes
  })()
  return await templateBytesPromise
}

function substituteConstructorSlots(
  template: Uint8Array,
  r1Hash: number[],
  k1Hash: number[]
): Uint8Array {
  if (template[R1_K1_R1_SLOT_OFFSET] !== OP.OP_0 || template[R1_K1_K1_SLOT_OFFSET] !== OP.OP_0) {
    throw new Error('R1-K1 artifact constructor slots are invalid')
  }
  const output = new Uint8Array(BAKED_SCRIPT_BYTE_LENGTH)
  let sourceOffset = 0
  let outputOffset = 0
  for (const [slotOffset, value] of [
    [R1_K1_R1_SLOT_OFFSET, r1Hash],
    [R1_K1_K1_SLOT_OFFSET, k1Hash]
  ] as const) {
    output.set(template.subarray(sourceOffset, slotOffset), outputOffset)
    outputOffset += slotOffset - sourceOffset
    output[outputOffset++] = 20
    output.set(value, outputOffset)
    outputOffset += value.length
    sourceOffset = slotOffset + 1
  }
  output.set(template.subarray(sourceOffset), outputOffset)
  return output
}

function resolveSourceDetails(
  tx: Transaction,
  inputIndex: number,
  sourceSatoshis?: number,
  lockingScript?: Script
): SourceDetails {
  const input = tx.inputs[inputIndex]
  if (input == null) throw new Error(`Transaction input ${inputIndex} does not exist`)
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (sourceTXID == null || sourceTXID.length === 0) {
    throw new Error('The input sourceTXID or sourceTransaction is required for signing')
  }
  const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  const resolvedSatoshis = sourceSatoshis ?? sourceOutput?.satoshis
  if (resolvedSatoshis == null) {
    throw new Error('The sourceSatoshis or input sourceTransaction is required for signing')
  }
  const resolvedScript = lockingScript ?? sourceOutput?.lockingScript
  if (resolvedScript == null) {
    throw new Error('The lockingScript or input sourceTransaction is required for signing')
  }
  return { sourceTXID, sourceSatoshis: resolvedSatoshis, lockingScript: resolvedScript }
}

function formatPreimage(
  tx: Transaction,
  inputIndex: number,
  source: SourceDetails,
  subscript: Script
): Uint8Array {
  const input = tx.inputs[inputIndex]!
  return Uint8Array.from(
    TransactionSignature.format({
      sourceTXID: source.sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: source.sourceSatoshis,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript,
      lockTime: tx.lockTime,
      scope: SIGHASH_ALL_FORKID
    })
  )
}

async function validateLockingScript(lockingScript: Script): Promise<Uint8Array> {
  const bytes = lockingScript.toUint8Array()
  if (bytes.length !== BAKED_SCRIPT_BYTE_LENGTH) {
    throw new Error(`R1-K1 locking script must be ${BAKED_SCRIPT_BYTE_LENGTH} bytes`)
  }
  const template = await loadTemplateBytes()
  if (
    bytes[R1_K1_R1_SLOT_OFFSET] !== 20 ||
    bytes[BAKED_K1_SLOT_OFFSET] !== 20 ||
    !equalBytes(
      bytes.subarray(0, R1_K1_R1_SLOT_OFFSET),
      template.subarray(0, R1_K1_R1_SLOT_OFFSET)
    ) ||
    !equalBytes(
      bytes.subarray(R1_K1_R1_SLOT_OFFSET + 21, BAKED_K1_SLOT_OFFSET),
      template.subarray(R1_K1_R1_SLOT_OFFSET + 1, R1_K1_K1_SLOT_OFFSET)
    ) ||
    !equalBytes(
      bytes.subarray(BAKED_K1_SLOT_OFFSET + 21),
      template.subarray(R1_K1_K1_SLOT_OFFSET + 1)
    )
  ) {
    throw new Error('R1-K1 locking script structure is invalid')
  }
  return bytes
}

function normalizeP256Signature(value: R1K1Bytes): number[] {
  const signature = normalizeBytes(value, 'P-256 signature')
  if (signature.length === 64) return signature
  try {
    const parsed = Signature.fromDER(signature)
    return [...parsed.r.toArray('be', 32), ...parsed.s.toArray('be', 32)]
  } catch (error) {
    throw new Error('P-256 signer must return a DER signature or raw 64-byte r || s', {
      cause: error
    })
  }
}

function normalizeBytes(value: R1K1Bytes, label: string, length?: number): number[] {
  const bytes = typeof value === 'string' ? Utils.toArray(value, 'hex') : Array.from(value)
  if (bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error(`${label} must contain only bytes`)
  }
  if (length != null && bytes.length !== length) {
    throw new Error(`${label} must be ${length} bytes`)
  }
  return bytes
}

function encodedPushLength(dataLength: number): number {
  // Direct pushes and PUSHDATA1/2/4 add 1, 2, 3, and 5 prefix bytes respectively.
  const prefixLength =
    1 + Number(dataLength > 75) + Number(dataLength > 0xff) + 2 * Number(dataLength > 0xffff)
  return prefixLength + dataLength
}

function equalBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  let difference = Number(left.length !== right.length)
  const sharedLength = Math.min(left.length, right.length)
  for (let index = 0; index < sharedLength; index++) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
