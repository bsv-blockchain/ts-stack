import { PublicKey, Signature, TransactionSignature } from '@bsv/sdk/primitives'
import { LockingScript, OP, UnlockingScript } from '@bsv/sdk/script'
import { hash256 } from '@bsv/sdk/primitives/Hash'
import { toArray, toHex } from '@bsv/sdk/primitives/utils'
import type ScriptChunk from '@bsv/sdk/script/ScriptChunk'
import type ScriptTemplate from '@bsv/sdk/script/ScriptTemplate'
import type ScriptTemplateUnlock from '@bsv/sdk/script/ScriptTemplateUnlock'
import type Transaction from '@bsv/sdk/transaction/Transaction'
import type {
  PubKeyHex,
  SecurityLevel,
  WalletCounterparty,
  WalletInterface
} from '@bsv/sdk/wallet/Wallet.interfaces'
import { createMinimallyEncodedScriptChunk, decodeScriptNumChunk } from './mandala-encoding.js'
import { boundPreimage, resolveBoundSource, signatureScope } from './signing-context.js'

const MAX_LOCKING_KEYS = 120

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

function requireCanonicalPush(chunk: ScriptChunk | undefined, name: string): number[] {
  if (chunk == null) throw new Error(`Invalid MultiPushDrop script: missing ${name}`)
  let data: number[]
  if (chunk.op === OP.OP_0) data = []
  else if (chunk.op === OP.OP_1NEGATE) data = [0x81]
  else if (chunk.op >= OP.OP_1 && chunk.op <= OP.OP_16) data = [chunk.op - OP.OP_1 + 1]
  else if (chunk.data != null) data = requireDenseBytes(chunk.data, name)
  else throw new Error(`Invalid MultiPushDrop script: ${name} is not a data push`)

  const canonical = createMinimallyEncodedScriptChunk(data)
  if (
    canonical.op !== chunk.op ||
    (canonical.data === undefined) !== (chunk.data === undefined) ||
    canonical.data?.some((byte, index) => byte !== chunk.data?.[index]) === true
  ) {
    throw new Error(`Invalid MultiPushDrop script: ${name} is not minimally encoded`)
  }
  return data
}

function requireCompressedPublicKey(value: unknown, name: string): PubKeyHex {
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

function requireProtocolID(value: unknown): [SecurityLevel, string] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    value[0] < 0 ||
    value[0] > 2 ||
    typeof value[1] !== 'string' ||
    value[1].length < 5 ||
    value[1].length > 400
  ) {
    throw new Error(
      'protocolID must contain a security level from 0 to 2 and a 5-400 character name'
    )
  }
  return value as [SecurityLevel, string]
}

function requireKeyID(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 800) {
    throw new Error('keyID must be a 1-800 character string')
  }
  return value
}

function requireCounterparty(value: unknown, name: string): WalletCounterparty {
  if (value === 'self' || value === 'anyone') return value
  return requireCompressedPublicKey(value, name)
}

function expectOpcode(chunks: ScriptChunk[], cursor: number, opcode: number, name: string): number {
  const chunk = chunks[cursor]
  if (chunk == null || chunk.op !== opcode || chunk.data !== undefined) {
    throw new Error(`Invalid MultiPushDrop script: expected ${name}`)
  }
  return cursor + 1
}

/**
 * Represents the decoded structure of a MultiPushDrop locking script.
 */
export interface MultiPushDropDecoded {
  lockingPublicKeys: PubKeyHex[]
  fields: number[][]
}

/**
 * MultiPushDrop Script Template
 *
 * This template creates locking scripts that allow spending by any one of multiple
 * specified public keys (1-of-N). It also pushes arbitrary data fields onto the stack,
 * which are dropped after the signature check.
 *
 * When using this among adversarial or non-trusted groups, the MASSIVE caveat is that
 * there is no constraint enforcing that any group members are kept in the loop. Any group
 * member can trivially destroy the token. For more practical non-trusted arrangements,
 * techniques like OP_PUSH_TX should be used instead.
 *
 * There's also a known bug in this implementation where it won't work with over around 120
 * keys but involving more than a few people than just a few into a FULLY TRUST BASED exchange
 * is never a good idea. Use a more robust, application-specific mechanism.
 */
export class MultiPushDrop implements ScriptTemplate {
  wallet: WalletInterface
  originator?: string

  /**
   * Decodes a MultiPushDrop locking script back into its data fields and the list of locking public keys.
   * @param script The MultiPushDrop locking script to decode.
   * @returns {MultiPushDropDecoded} An object containing the locking public keys and data fields.
   * @throws {Error} If the script structure is not a valid MultiPushDrop script.
   */
  static decode(script: LockingScript): MultiPushDropDecoded {
    if (!(script instanceof LockingScript)) {
      throw new TypeError('MultiPushDrop script must be a LockingScript')
    }
    const chunks = script.chunks
    let cursor = 0

    const lockingPublicKeys: PubKeyHex[] = []
    while (chunks[cursor]?.data?.length === 33) {
      if (lockingPublicKeys.length >= MAX_LOCKING_KEYS) {
        throw new Error(`MultiPushDrop supports at most ${MAX_LOCKING_KEYS} locking keys`)
      }
      const keyData = requireCanonicalPush(chunks[cursor], `public key chunk ${cursor}`)
      lockingPublicKeys.push(
        requireCompressedPublicKey(toHex(keyData), `public key chunk ${cursor}`)
      )
      cursor++
    }
    if (lockingPublicKeys.length === 0) {
      throw new Error('Invalid MultiPushDrop script: at least one locking key is required')
    }
    if (new Set(lockingPublicKeys).size !== lockingPublicKeys.length) {
      throw new Error('Invalid MultiPushDrop script: locking keys must be distinct')
    }

    const keyCountChunk = chunks[cursor]
    const encodedKeyCount = decodeScriptNumChunk(keyCountChunk ?? { op: -1 })
    requireCanonicalPush(keyCountChunk, 'locking key count')
    if (encodedKeyCount !== lockingPublicKeys.length) {
      throw new Error('Invalid MultiPushDrop script: locking key count does not match key pushes')
    }
    cursor++
    cursor = expectOpcode(chunks, cursor, OP.OP_PICK, 'OP_PICK')
    cursor = expectOpcode(chunks, cursor, OP.OP_PICK, 'OP_PICK')
    cursor = expectOpcode(chunks, cursor, OP.OP_DEPTH, 'OP_DEPTH')
    cursor = expectOpcode(chunks, cursor, OP.OP_1SUB, 'OP_1SUB')
    cursor = expectOpcode(chunks, cursor, OP.OP_PICK, 'OP_PICK')
    cursor = expectOpcode(chunks, cursor, OP.OP_SWAP, 'OP_SWAP')
    cursor = expectOpcode(chunks, cursor, OP.OP_CHECKSIGVERIFY, 'OP_CHECKSIGVERIFY')

    const fields: number[][] = []
    while (chunks[cursor]?.op !== OP.OP_DROP && chunks[cursor]?.op !== OP.OP_2DROP) {
      if (cursor >= chunks.length) {
        throw new Error('Invalid MultiPushDrop script: missing cleanup and final OP_TRUE')
      }
      fields.push(requireCanonicalPush(chunks[cursor], `field ${fields.length}`))
      cursor++
    }

    let itemsToDrop = fields.length + lockingPublicKeys.length + 2
    while (itemsToDrop > 1) {
      cursor = expectOpcode(chunks, cursor, OP.OP_2DROP, 'OP_2DROP')
      itemsToDrop -= 2
    }
    if (itemsToDrop === 1) {
      cursor = expectOpcode(chunks, cursor, OP.OP_DROP, 'OP_DROP')
    }
    cursor = expectOpcode(chunks, cursor, OP.OP_TRUE, 'final OP_TRUE')
    if (cursor !== chunks.length) {
      throw new Error('Invalid MultiPushDrop script: trailing script operations are not allowed')
    }

    return {
      lockingPublicKeys,
      fields
    }
  }

  /**
   * Constructs a new instance of the MultiPushDrop class.
   *
   * @param {WalletInterface} wallet - The wallet interface used for deriving keys and signing.
   * @param {string} [originator] - The originator domain for wallet requests.
   */
  constructor(wallet: WalletInterface, originator?: string) {
    this.wallet = wallet
    this.originator = originator
  }

  /**
   * Creates a MultiPushDrop locking script.
   *
   * @param {number[][]} fields - The arbitrary data fields to include in the script.
   * @param {[SecurityLevel, string]} protocolID - The protocol ID used for key derivation.
   * @param {string} keyID - The key ID used for key derivation.
   * @param {WalletCounterparty[]} counterparties - An array of counterparties ('self' or PubKeyHex) whose derived keys can unlock the script. Must contain at least one.
   * @returns {Promise<LockingScript>} The generated MultiPushDrop locking script.
   * @throws {Error} If counterparties array is empty.
   */
  async lock(
    fields: number[][],
    protocolID: [SecurityLevel, string],
    keyID: string,
    counterparties: WalletCounterparty[]
  ): Promise<LockingScript> {
    if (!Array.isArray(fields)) throw new TypeError('fields must be an array of byte arrays')
    fields.forEach((field, index) => requireDenseBytes(field, `fields[${index}]`))
    requireProtocolID(protocolID)
    requireKeyID(keyID)
    if (!Array.isArray(counterparties) || counterparties.length === 0) {
      throw new Error('MultiPushDrop requires at least one counterparty.')
    }
    if (counterparties.length > MAX_LOCKING_KEYS) {
      throw new Error(`MultiPushDrop supports at most ${MAX_LOCKING_KEYS} counterparties`)
    }

    const publicKeys: string[] = []
    for (let index = 0; index < counterparties.length; index++) {
      const counterparty = requireCounterparty(counterparties[index], `counterparties[${index}]`)
      const { publicKey } = await this.wallet.getPublicKey(
        {
          protocolID,
          keyID,
          counterparty
        },
        this.originator
      )
      publicKeys.push(requireCompressedPublicKey(publicKey, `derived public key ${index}`))
    }
    if (new Set(publicKeys).size !== publicKeys.length) {
      throw new Error('MultiPushDrop locking keys must be distinct')
    }

    const nPublicKeys = publicKeys.length
    const lockPart: Array<{ op: number; data?: number[] }> = []

    // Push Public Keys
    for (const publicKeyHex of publicKeys) {
      lockPart.push({
        op: publicKeyHex.length / 2, // Length of compressed pubkey is 33 bytes (66 hex)
        data: toArray(publicKeyHex, 'hex')
      })
    }

    lockPart.push(
      // Pick the value on the stack that's right before the locking script.
      // This should be the index of the key to use in the unlock.
      createMinimallyEncodedScriptChunk([nPublicKeys]),
      { op: OP.OP_PICK },
      // Now use the index to get the actual key.
      { op: OP.OP_PICK },
      // Pull the signature from the bottom of the stack, regardless of key count.
      { op: OP.OP_DEPTH },
      { op: OP.OP_1SUB },
      { op: OP.OP_PICK },
      // Put signature and key in CHECKSIGVERIFY order.
      { op: OP.OP_SWAP },
      { op: OP.OP_CHECKSIGVERIFY }
    )

    // Construct PushDrop Part for fields
    const pushDropPart: Array<{ op: number; data?: number[] }> = []
    for (const field of fields) {
      pushDropPart.push(createMinimallyEncodedScriptChunk(field))
    }

    // Add Drop Opcodes
    // We need to drop N keys, the number N itself, and M fields after verification succeeds.
    // We also copied the signature itself so we need to drop that.
    // Then we push a single true.
    let itemsToDrop = fields.length + nPublicKeys + 2
    while (itemsToDrop > 1) {
      pushDropPart.push({ op: OP.OP_2DROP })
      itemsToDrop -= 2
    }
    if (itemsToDrop === 1) {
      pushDropPart.push({ op: OP.OP_DROP })
    }

    // Combine parts and return
    return new LockingScript([...lockPart, ...pushDropPart, { op: OP.OP_TRUE }])
  }

  /**
   * Creates an unlocking script template for spending a MultiPushDrop output.
   *
   * @param {[SecurityLevel, string]} protocolID - The protocol ID used for key derivation.
   * @param {string} keyID - The key ID used for key derivation.
   * @param {WalletCounterparty} creator - The identity key of the person who made the locking script. Could come from one of the fields or be passed off chain.
   * @param {'all' | 'none' | 'single'} [signOutputs='all'] - Specifies which transaction outputs to sign.
   * @param {boolean} [anyoneCanPay=false] - Specifies if the SIGHASH_ANYONECANPAY flag should be used.
   * @returns {ScriptTemplateUnlock} An object containing `sign` and `estimateLength` functions.
   * @throws {Error} If we are not found in the list of keys, or if required signing info (sourceTXID, satoshis, lockingScript) is missing.
   */
  unlock(
    protocolID: [SecurityLevel, string],
    keyID: string,
    creator: WalletCounterparty,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    requireProtocolID(protocolID)
    requireKeyID(keyID)
    const validatedCreator = requireCounterparty(creator, 'creator')
    return {
      sign: async (tx: Transaction, inputIndex: number): Promise<UnlockingScript> => {
        const resolvedScope = signatureScope(tx, inputIndex, signOutputs, anyoneCanPay)
        // Prepare for signing
        const source = resolveBoundSource(tx, inputIndex)
        const decoded = MultiPushDrop.decode(source.lockingScript as LockingScript)

        // Find the index of the unlocker's public key
        let unlockerIndex = -1
        const { publicKey: unlockerPubKeyHex } = await this.wallet.getPublicKey(
          {
            protocolID,
            keyID,
            counterparty: validatedCreator,
            forSelf: true
          },
          this.originator
        )
        for (let i = 0; i < decoded.lockingPublicKeys.length; i++) {
          if (decoded.lockingPublicKeys[i] === unlockerPubKeyHex) {
            unlockerIndex = i
            break
          }
        }
        if (unlockerIndex === -1) {
          throw new Error(
            `Unlocker key derived for counterparty (creator) "${validatedCreator}" not found in the list of locking keys.`
          )
        }
        unlockerIndex = decoded.lockingPublicKeys.length - 1 - unlockerIndex

        // Calculate Preimage
        const preimage = boundPreimage(tx, inputIndex, source, resolvedScope)

        // Create Signature
        const preimageHash = hash256(preimage)
        const { signature: bareSignature } = await this.wallet.createSignature(
          {
            hashToDirectlySign: preimageHash,
            protocolID,
            keyID,
            counterparty: validatedCreator
          },
          this.originator
        )
        const signature = Signature.fromDER([...bareSignature])
        const txSignature = new TransactionSignature(signature.r, signature.s, resolvedScope)
        const sigForScript = txSignature.toChecksigFormat()

        // Create Unlocking Script Chunks: <Signature> <Index>
        const unlockingChunks: Array<{ op: number; data?: number[] }> = []
        unlockingChunks.push(
          { op: sigForScript.length, data: sigForScript },
          createMinimallyEncodedScriptChunk([unlockerIndex])
        )
        return new UnlockingScript(unlockingChunks)
      },
      // Estimate length: Signature (~71-73 bytes) + Index push (1 byte for 0-15, potentially more)
      estimateLength: async (): Promise<number> => {
        // 73-byte checksig-format signature plus its push opcode, and a
        // minimally encoded key index up to 119 plus its push opcode.
        return 76
      }
    }
  }
}
