import { PublicKey, Signature, TransactionSignature } from '@bsv/sdk/primitives'
import { LockingScript, OP, UnlockingScript } from '@bsv/sdk/script'
import { hash160, hash256 } from '@bsv/sdk/primitives/Hash'
import { Reader, Writer, fromBase58Check, toBase58Check, toHex } from '@bsv/sdk/primitives/utils'
import type ScriptChunk from '@bsv/sdk/script/ScriptChunk'
import type ScriptTemplate from '@bsv/sdk/script/ScriptTemplate'
import type Transaction from '@bsv/sdk/transaction/Transaction'
import type { PubKeyHex, WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { boundPreimage, resolveBoundSource, signatureScope } from './signing-context.js'
import { createMinimallyEncodedScriptChunk, decodeScriptNumChunk } from './mandala-encoding.js'

export interface MultiSigInstructions {
  keyID: string
  counterparty: string
  pubkeys: string[]
}

function concatPubkeys(pubkeys: PublicKey[]): number[] {
  return pubkeys.flatMap(p => p.toDER() as number[])
}

function requireDenseBytes(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be a dense byte array`)
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 0xff
    ) {
      throw new TypeError(`${name} must be a dense byte array`)
    }
  }
  return value as number[]
}

function requireThreshold(threshold: unknown, total: number): number {
  if (
    !Number.isSafeInteger(threshold) ||
    (threshold as number) < 1 ||
    (threshold as number) > total
  ) {
    throw new Error('threshold must be between 1 and the number of pubkeys')
  }
  return threshold as number
}

function requireTotal(total: unknown): number {
  if (!Number.isSafeInteger(total) || (total as number) < 2) {
    throw new Error('at least 2 pubkeys are required')
  }
  if ((total as number) > 10) throw new Error('total must be less than or equal to 10')
  return total as number
}

function requirePublicKey(value: unknown, name: string): PublicKey {
  if (!(value instanceof PublicKey) || !value.validate()) {
    throw new Error(`${name} must be a valid public key`)
  }
  const der = value.toDER() as number[]
  if (der.length !== 33 || (der[0] !== 0x02 && der[0] !== 0x03)) {
    throw new Error(`${name} must be a compressed public key`)
  }
  return value
}

function requirePublicKeyString(value: unknown, name: string): PubKeyHex {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a compressed public key`)
  }
  const normalized = value.toLowerCase()
  const key = PublicKey.fromString(normalized)
  if (!key.validate() || toHex(key.toDER() as number[]) !== normalized) {
    throw new Error(`${name} must be a valid compressed public key`)
  }
  return normalized as PubKeyHex
}

function requirePublicKeys(pubkeys: unknown, name = 'pubkeys'): PublicKey[] {
  if (!Array.isArray(pubkeys)) throw new TypeError(`${name} must be an array`)
  const total = requireTotal(pubkeys.length)
  const validated = Array.from({ length: total }, (_, index) =>
    requirePublicKey(pubkeys[index], `${name}[${index}]`)
  )
  const encoded = validated.map(key => toHex(key.toDER() as number[]))
  if (new Set(encoded).size !== encoded.length) throw new Error(`${name} must be distinct`)
  return validated
}

function requirePublicKeyStrings(pubkeys: unknown): PubKeyHex[] {
  if (!Array.isArray(pubkeys)) throw new TypeError('customInstructions.pubkeys must be an array')
  const total = requireTotal(pubkeys.length)
  const validated = Array.from({ length: total }, (_, index) =>
    requirePublicKeyString(pubkeys[index], `customInstructions.pubkeys[${index}]`)
  )
  if (new Set(validated).size !== validated.length) {
    throw new Error('customInstructions.pubkeys must be distinct')
  }
  return validated
}

function requireKeyID(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 800) {
    throw new Error('customInstructions.keyID must be a 1-800 character string')
  }
  return value
}

function requireCounterparty(value: unknown): PubKeyHex {
  return requirePublicKeyString(value, 'customInstructions.counterparty')
}

function requireCanonicalNumberChunk(
  chunk: ScriptChunk | undefined,
  expected: number,
  name: string
): void {
  if (chunk == null || decodeScriptNumChunk(chunk) !== expected) {
    throw new Error(`Invalid P2MSKH locking script: ${name} is incorrect`)
  }
  const canonical = createMinimallyEncodedScriptChunk([expected])
  if (
    chunk.op !== canonical.op ||
    (chunk.data === undefined) !== (canonical.data === undefined) ||
    canonical.data?.some((byte, index) => byte !== chunk.data?.[index]) === true
  ) {
    throw new Error(`Invalid P2MSKH locking script: ${name} is not minimally encoded`)
  }
}

function requireOpcode(chunks: ScriptChunk[], index: number, opcode: number, name: string): void {
  if (chunks[index]?.op !== opcode || chunks[index]?.data !== undefined) {
    throw new Error(`Invalid P2MSKH locking script: expected ${name}`)
  }
}

interface P2MSKHLockDetails {
  hash: number[]
  threshold: number
  total: number
}

function parseLockingScript(script: LockingScript): P2MSKHLockDetails {
  if (!(script instanceof LockingScript)) {
    throw new TypeError('P2MSKH locking script must be a LockingScript')
  }
  const chunks = script.chunks
  if (chunks.length < 10) throw new Error('Invalid P2MSKH locking script: script is too short')
  const totalChunk = chunks.at(-2)
  const total = decodeScriptNumChunk(totalChunk ?? { op: -1 })
  requireTotal(total)
  requireCanonicalNumberChunk(totalChunk, total, 'total')
  if (chunks.length !== 2 * total + 6) {
    throw new Error('Invalid P2MSKH locking script: unexpected script length')
  }

  requireOpcode(chunks, 0, OP.OP_DUP, 'OP_DUP')
  requireOpcode(chunks, 1, OP.OP_HASH160, 'OP_HASH160')
  const hash = requireDenseBytes(chunks[2]?.data, 'P2MSKH public-key hash')
  if (chunks[2]?.op !== 20 || hash.length !== 20) {
    throw new Error('Invalid P2MSKH locking script: public-key hash must be a 20-byte push')
  }
  requireOpcode(chunks, 3, OP.OP_EQUALVERIFY, 'OP_EQUALVERIFY')
  const threshold = decodeScriptNumChunk(chunks[4] ?? { op: -1 })
  requireThreshold(threshold, total)
  requireCanonicalNumberChunk(chunks[4], threshold, 'threshold')
  requireOpcode(chunks, 5, OP.OP_SWAP, 'OP_SWAP')
  let cursor = 6
  for (let index = 0; index < total - 1; index++) {
    requireCanonicalNumberChunk(chunks[cursor], 33, `split width ${index}`)
    requireOpcode(chunks, cursor + 1, OP.OP_SPLIT, 'OP_SPLIT')
    cursor += 2
  }
  requireCanonicalNumberChunk(chunks[cursor], total, 'total')
  requireOpcode(chunks, cursor + 1, OP.OP_CHECKMULTISIG, 'OP_CHECKMULTISIG')
  return { hash, threshold, total }
}

function requireInstructions(value: unknown): {
  keyID: string
  counterparty: PubKeyHex
  pubkeys: PubKeyHex[]
  parsedPubkeys: PublicKey[]
} {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('customInstructions must be an object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const name of ['keyID', 'counterparty', 'pubkeys']) {
    if (descriptors[name] == null || !('value' in descriptors[name])) {
      throw new TypeError(`customInstructions.${name} must be a data property`)
    }
  }
  const keyID = requireKeyID(descriptors.keyID.value)
  const counterparty = requireCounterparty(descriptors.counterparty.value)
  const pubkeys = requirePublicKeyStrings(descriptors.pubkeys.value)
  return {
    keyID,
    counterparty,
    pubkeys,
    parsedPubkeys: pubkeys.map(pubkey => PublicKey.fromString(pubkey))
  }
}

function byteArraysEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function validateWorkingUnlockingScript(
  script: UnlockingScript,
  expectedPubkeys: number[],
  threshold: number
): number {
  if (!(script instanceof UnlockingScript)) {
    throw new TypeError('workingUnlockingScript must be an UnlockingScript')
  }
  const chunks = script.chunks
  if (chunks.length < 2 || chunks[0].op !== OP.OP_0 || chunks[0].data !== undefined) {
    throw new Error('Invalid P2MSKH working unlocking script: expected leading OP_0')
  }
  const pubkeyChunk = chunks.at(-1)
  const pubkeyBytes = requireDenseBytes(pubkeyChunk?.data, 'working unlocking script pubkeys')
  const canonicalPubkeyPush = createMinimallyEncodedScriptChunk(pubkeyBytes)
  if (
    pubkeyChunk?.op !== canonicalPubkeyPush.op ||
    !byteArraysEqual(pubkeyBytes, expectedPubkeys)
  ) {
    throw new Error(
      'Invalid P2MSKH working unlocking script: public keys do not match instructions'
    )
  }
  const signatureCount = chunks.length - 2
  if (signatureCount >= threshold) {
    throw new Error('P2MSKH working unlocking script already has the required signatures')
  }
  for (let index = 1; index <= signatureCount; index++) {
    const signatureChunk = chunks[index]
    const signature = requireDenseBytes(signatureChunk.data, `working signature ${index - 1}`)
    const canonical = createMinimallyEncodedScriptChunk(signature)
    if (signature.length === 0 || signatureChunk.op !== canonical.op) {
      throw new Error('Invalid P2MSKH working unlocking script: signature is not canonical')
    }
    TransactionSignature.fromChecksigFormat(signature)
  }
  return signatureCount
}

/**
 * Pay-to-multisignature-key-hash template.
 *
 * Unlocking validates the complete source contract and proves that the ordered
 * instruction keys match its HASH160 commitment before asking a wallet to
 * sign. Callers gathering signatures must preserve that same ordered key list.
 */
export class P2MSKH implements ScriptTemplate {
  static address(pubkeys: PublicKey[], threshold: number): string {
    const validatedPubkeys = requirePublicKeys(pubkeys)
    requireThreshold(threshold, validatedPubkeys.length)
    const concat = concatPubkeys(validatedPubkeys)
    const hash = hash160(concat)
    const writer = new Writer()
    writer.write(hash)
    writer.writeVarIntNum(threshold)
    writer.writeVarIntNum(validatedPubkeys.length)
    const data = writer.toArray()
    return toBase58Check(data, [0x98])
  }

  static async addressBRC29(
    wallet: WalletInterface,
    counterparties: string[],
    keyID: string,
    threshold: number
  ): Promise<{ pubkeys: string[]; address: string }> {
    if (!Array.isArray(counterparties)) throw new TypeError('counterparties must be an array')
    requireThreshold(threshold, counterparties.length)
    const total = requireTotal(counterparties.length)
    if (typeof keyID !== 'string' || keyID.length < 1 || keyID.length > 800) {
      throw new Error('keyID must be a 1-800 character string')
    }
    const validatedCounterparties = Array.from({ length: total }, (_, index) =>
      requirePublicKeyString(counterparties[index], `counterparties[${index}]`)
    )
    if (new Set(validatedCounterparties).size !== validatedCounterparties.length) {
      throw new Error('counterparties must be distinct')
    }
    const pubkeys = await Promise.all(
      validatedCounterparties.map(async counterparty => {
        const { publicKey } = await wallet.getPublicKey({
          protocolID: [1, 'multi sig brc29'],
          keyID,
          counterparty
        })
        return PublicKey.fromString(publicKey)
      })
    )
    return { pubkeys: pubkeys.map(p => p.toString()), address: this.address(pubkeys, threshold) }
  }

  static thresholdAndTotalFromAddress(address: string): {
    hash: number[]
    threshold: number
    total: number
  } {
    if (typeof address !== 'string') throw new TypeError('address must be a string')
    const h = fromBase58Check(address)
    if (!Array.isArray(h.prefix) || h.prefix.length !== 1 || h.prefix[0] !== 0x98) {
      throw new Error('only P2MSH is supported, set your prefix byte to 0x98')
    }
    const data = requireDenseBytes(h.data, 'P2MSKH address payload')
    const reader = new Reader(data)
    const hash = reader.read(20)
    const threshold = reader.readVarIntNumStrict(false)
    const total = reader.readVarIntNumStrict(false)
    requireTotal(total)
    requireThreshold(threshold, total)
    if (!reader.eof()) throw new Error('P2MSKH address contains trailing data')
    return { hash, threshold, total }
  }

  lock(address?: string, pubkeys?: PublicKey[], threshold: number = 1): LockingScript {
    let hash: number[]
    let total: number = pubkeys?.length || 0
    if (address !== undefined) {
      const result = P2MSKH.thresholdAndTotalFromAddress(address)
      hash = result.hash
      total = result.total
      threshold = result.threshold
    } else {
      const validatedPubkeys = requirePublicKeys(pubkeys)
      total = validatedPubkeys.length
      requireThreshold(threshold, total)
      const concat = concatPubkeys(validatedPubkeys)
      hash = hash160(concat)
    }
    requireTotal(total)
    requireThreshold(threshold, total)

    const script = new LockingScript()
    script
      .writeOpCode(OP.OP_DUP)
      .writeOpCode(OP.OP_HASH160)
      .writeBin(hash)
      .writeOpCode(OP.OP_EQUALVERIFY)
      .writeNumber(threshold)
      .writeOpCode(OP.OP_SWAP)
    for (let i = 0; i < total - 1; i++) {
      script.writeNumber(33).writeOpCode(OP.OP_SPLIT)
    }
    script.writeNumber(total)
    script.writeOpCode(OP.OP_CHECKMULTISIG)

    return script
  }

  unlock(
    wallet: WalletInterface,
    customInstructions: MultiSigInstructions,
    workingUnlockingScript?: UnlockingScript,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false,
    sourceSatoshis?: number,
    lockingScript?: LockingScript
  ): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
  } {
    const instructions = requireInstructions(customInstructions)
    const instructionPubkeys = concatPubkeys(instructions.parsedPubkeys)
    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        const resolvedScope = signatureScope(tx, inputIndex, signOutputs, anyoneCanPay)
        const source = resolveBoundSource(tx, inputIndex, sourceSatoshis, lockingScript)
        const lockDetails = parseLockingScript(source.lockingScript as LockingScript)
        if (lockDetails.total !== instructions.pubkeys.length) {
          throw new Error('P2MSKH public-key count does not match the source locking script')
        }
        const committedHash = hash160(instructionPubkeys)
        if (!byteArraysEqual(committedHash, lockDetails.hash)) {
          throw new Error('P2MSKH public keys are not committed by the source locking script')
        }

        const { publicKey } = await wallet.getPublicKey({
          protocolID: [1, 'multi sig brc29'],
          counterparty: instructions.counterparty,
          keyID: instructions.keyID,
          forSelf: true
        })
        const signingPublicKey = requirePublicKeyString(publicKey, 'wallet signing public key')
        if (!instructions.pubkeys.includes(signingPublicKey)) {
          throw new Error('Wallet signing public key is not committed by the source locking script')
        }

        if (workingUnlockingScript == null) {
          workingUnlockingScript = new UnlockingScript()
            .writeOpCode(OP.OP_0)
            .writeBin(instructionPubkeys) as UnlockingScript
        }
        validateWorkingUnlockingScript(
          workingUnlockingScript,
          instructionPubkeys,
          lockDetails.threshold
        )
        const preimage = boundPreimage(tx, inputIndex, source, resolvedScope)

        const hashToDirectlySign = hash256(preimage)

        const { signature } = await wallet.createSignature({
          hashToDirectlySign,
          protocolID: [1, 'multi sig brc29'],
          counterparty: instructions.counterparty,
          keyID: instructions.keyID
        })

        const s = Signature.fromDER(signature)
        const sig = new TransactionSignature(s.r, s.s, resolvedScope)
        const sigForScript = sig.toChecksigFormat()

        workingUnlockingScript.writeBin(sigForScript)
        const chunkforSig = workingUnlockingScript.chunks.pop() as ScriptChunk
        // add it to the array before the pubkeys, pushing the other content to the right
        workingUnlockingScript.chunks.splice(-1, 0, chunkforSig)
        return workingUnlockingScript
      },

      estimateLength: async (tx: Transaction, inputIndex: number) => {
        const staticLength = 8
        const input = tx.inputs[inputIndex]
        const sourceLockingScript =
          lockingScript ?? input?.sourceTransaction?.outputs[input.sourceOutputIndex]?.lockingScript
        if (sourceLockingScript == null) {
          return await Promise.resolve(1000) // guess
        }
        const details = parseLockingScript(sourceLockingScript as LockingScript)
        return await Promise.resolve(staticLength + details.threshold * 74 + details.total * 34)
      }
    }
  }
}
