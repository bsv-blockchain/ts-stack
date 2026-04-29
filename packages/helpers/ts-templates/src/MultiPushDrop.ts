import {
  ScriptTemplate,
  LockingScript,
  UnlockingScript,
  OP,
  ScriptTemplateUnlock,
  Utils,
  Hash,
  TransactionSignature,
  Signature,
  WalletInterface, SecurityLevel, WalletCounterparty,
  Transaction,
  PubKeyHex
} from '@bsv/sdk'

// Helper to ensure a value is not null or undefined
function verifyTruthy<T> (v: T | undefined | null, err?: string): T {
  if (v === null || v === undefined) throw new Error(err || 'Value must not be null or undefined')
  return v
}

// Helper to create minimally encoded script chunks (same as in PushDrop)
const createMinimallyEncodedScriptChunk = (
  data: number[]
): { op: number, data?: number[] } => {
  if (data.length === 0) return { op: 0 } // OP_0
  if (data.length === 1 && data[0] === 0) return { op: 0 } // OP_0
  if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] } // OP_1 to OP_16
  if (data.length === 1 && data[0] === 0x81) return { op: 0x4f } // OP_1NEGATE
  if (data.length <= 75) return { op: data.length, data }
  if (data.length <= 255) return { op: 0x4c, data } // OP_PUSHDATA1
  if (data.length <= 65535) return { op: 0x4d, data } // OP_PUSHDATA2
  return { op: 0x4e, data } // OP_PUSHDATA4
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
  static decode (script: LockingScript): MultiPushDropDecoded {
    const chunks = script.chunks
    let cursor = 0

    // Decode keys until they stop being 33 bytes long
    const lockingPublicKeys: PubKeyHex[] = []
    while (chunks[cursor].data?.length === 33) {
      const keyChunk = verifyTruthy(chunks[cursor], `Missing public key chunk ${cursor}`)
      const keyData = verifyTruthy(keyChunk.data, `Public key chunk ${cursor} has no data`)
      lockingPublicKeys.push(Utils.toHex(keyData))
      cursor++
    }

    // Skip the nPublicKeys chunk and opcodes.
    // This amounts to 8 items to skip.
    cursor += 8

    // Decode Data Fields
    const fields: number[][] = []
    for (let i = cursor; i < chunks.length; i++) {
      const nextOpcode = chunks[i + 1]?.op
      const chunkData = chunks[i].data ?? [] // Use OP code for OP_0-OP_16 etc. if data is null

      let currentField: number[] = []
      if (chunkData.length > 0) {
        currentField = chunkData
      } else if (chunks[i].op >= OP.OP_1 && chunks[i].op <= OP.OP_16) {
        currentField = [chunks[i].op - OP.OP_1 + 1]
      } else if (chunks[i].op === OP.OP_0) {
        currentField = [] // Represent OP_0 as empty array
      } else if (chunks[i].op === OP.OP_1NEGATE) {
        currentField = [0x81]
      } else if (chunks[i].op === OP.OP_DROP || chunks[i].op === OP.OP_2DROP) {
        // Stop before the drops
        break
      } else {
        // Assume it's a data push even if data is empty for some reason
        currentField = chunkData
      }
      fields.push(currentField)
      // If the next opcode is a DROP, we've found the last field
      if (nextOpcode === OP.OP_DROP || nextOpcode === OP.OP_2DROP) {
        break
      }
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
  constructor (wallet: WalletInterface, originator?: string) {
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
  async lock (
    fields: number[][],
    protocolID: [SecurityLevel, string],
    keyID: string,
    counterparties: WalletCounterparty[]
  ): Promise<LockingScript> {
    if (!Array.isArray(counterparties) || counterparties.length === 0) {
      throw new Error('MultiPushDrop requires at least one counterparty.')
    }

    const publicKeys: string[] = []
    for (const counterparty of counterparties) {
      const { publicKey } = await this.wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty
      }, this.originator)
      publicKeys.push(publicKey)
    }

    const nPublicKeys = publicKeys.length
    const lockPart: Array<{ op: number, data?: number[] }> = []

    // Push Public Keys
    for (const publicKeyHex of publicKeys) {
      lockPart.push({
        op: publicKeyHex.length / 2, // Length of compressed pubkey is 33 bytes (66 hex)
        data: Utils.toArray(publicKeyHex, 'hex')
      })
    }

    // Pick the value on the stack that's right before the locking script.
    // This should be the index of the key to use in the unlock.
    lockPart.push(createMinimallyEncodedScriptChunk([nPublicKeys]))
    lockPart.push({ op: OP.OP_PICK })

    // Now we use the index to get the actual key.
    lockPart.push({ op: OP.OP_PICK })

    // We pull the signature from the bottom of the stack, no matter the number of keys.
    lockPart.push({ op: OP.OP_DEPTH })
    lockPart.push({ op: OP.OP_1SUB })
    lockPart.push({ op: OP.OP_PICK })

    // We swap the signature and public key so they're in the correct order, then CHECKSIGVERIFY
    lockPart.push({ op: OP.OP_SWAP })
    lockPart.push({ op: OP.OP_CHECKSIGVERIFY })

    // Construct PushDrop Part for fields
    const pushDropPart: Array<{ op: number, data?: number[] }> = []
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
    return new LockingScript([
      ...lockPart,
      ...pushDropPart,
      { op: OP.OP_TRUE }
    ])
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
  unlock (
    protocolID: [SecurityLevel, string],
    keyID: string,
    creator: WalletCounterparty,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false
  ): ScriptTemplateUnlock {
    return {
      sign: async (
        tx: Transaction,
        inputIndex: number
      ): Promise<UnlockingScript> => {
        // Prepare for signing
        let signatureScope = TransactionSignature.SIGHASH_FORKID
        if (signOutputs === 'all') signatureScope |= TransactionSignature.SIGHASH_ALL
        else if (signOutputs === 'none') signatureScope |= TransactionSignature.SIGHASH_NONE
        else if (signOutputs === 'single') signatureScope |= TransactionSignature.SIGHASH_SINGLE
        if (anyoneCanPay) signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY
        const input = tx.inputs[inputIndex]
        const currentSourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex')
        const currentSourceSatoshis = input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis
        const currentLockingScript = input.sourceTransaction?.outputs[input.sourceOutputIndex]?.lockingScript
        if (typeof currentSourceTXID !== 'string') throw new Error('Input sourceTXID or sourceTransaction required for signing.')
        if (currentSourceSatoshis === undefined) throw new Error('Input sourceSatoshis or sourceTransaction required for signing.')
        if (currentLockingScript == null) throw new Error('Input lockingScript or sourceTransaction required for signing.')
        const otherInputs = tx.inputs.filter((_, index) => index !== inputIndex)
        const decoded = MultiPushDrop.decode(currentLockingScript)

        // Find the index of the unlocker's public key
        let unlockerIndex = -1
        const { publicKey: unlockerPubKeyHex } = await this.wallet.getPublicKey({
          protocolID,
          keyID,
          counterparty: creator,
          forSelf: true
        }, this.originator)
        for (let i = 0; i < decoded.lockingPublicKeys.length; i++) {
          if (decoded.lockingPublicKeys[i] === unlockerPubKeyHex) {
            unlockerIndex = i
            break
          }
        }
        if (unlockerIndex === -1) {
          throw new Error(`Unlocker key derived for counterparty (creator) "${creator}" not found in the list of locking keys.`)
        }
        unlockerIndex = decoded.lockingPublicKeys.length - 1 - unlockerIndex

        // Calculate Preimage
        const preimage = TransactionSignature.format({
          sourceTXID: currentSourceTXID,
          sourceOutputIndex: verifyTruthy(input.sourceOutputIndex),
          sourceSatoshis: currentSourceSatoshis,
          transactionVersion: tx.version,
          otherInputs,
          inputIndex,
          outputs: tx.outputs,
          inputSequence: input.sequence ?? 0xffffffff,
          subscript: currentLockingScript,
          lockTime: tx.lockTime,
          scope: signatureScope
        })

        // Create Signature
        const preimageHash = Hash.hash256(preimage)
        const { signature: bareSignature } = await this.wallet.createSignature({
          hashToDirectlySign: preimageHash,
          protocolID,
          keyID,
          counterparty: creator
        }, this.originator)
        const signature = Signature.fromDER([...bareSignature])
        const txSignature = new TransactionSignature(signature.r, signature.s, signatureScope)
        const sigForScript = txSignature.toChecksigFormat()

        // Create Unlocking Script Chunks: <Signature> <Index>
        const unlockingChunks: Array<{ op: number, data?: number[] }> = []
        unlockingChunks.push({ op: sigForScript.length, data: sigForScript })
        unlockingChunks.push(createMinimallyEncodedScriptChunk([unlockerIndex]))
        return new UnlockingScript(unlockingChunks)
      },
      // Estimate length: Signature (~71-73 bytes) + Index push (1 byte for 0-15, potentially more)
      estimateLength: async (): Promise<number> => {
        // A conservative estimate, usually 73 + 1 = 74
        // Could potentially be larger if index > 15, but that's rare.
        return 74
      }
    }
  }
}
