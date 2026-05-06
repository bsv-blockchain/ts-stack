import { LockingScript, ScriptTemplate, Transaction, UnlockingScript, Hash, OP, Utils, WalletInterface, Script, TransactionSignature, Signature, PublicKey, WalletProtocol } from '@bsv/sdk'

import { calculatePreimage } from '../utils/createPreimage'
import {
  P2PKHLockParams,
  P2PKHLockWithPubkeyhash,
  P2PKHLockWithAddress,
  P2PKHLockWithPublicKey,
  P2PKHLockWithWallet,
  P2PKHUnlockParams
} from './types'

/**
 * Validates wallet derivation parameters at runtime
 */
function validateWalletDerivationParams (params: any, paramName: string = 'parameters'): void {
  if (!params || typeof params !== 'object') {
    throw new Error(`Invalid ${paramName}: must be an object with protocolID and keyID`)
  }
  if (!params.protocolID) {
    throw new Error(`Invalid ${paramName}: protocolID is required`)
  }
  if (!Array.isArray(params.protocolID) || params.protocolID.length !== 2) {
    throw new Error(`Invalid ${paramName}: protocolID must be an array of [number, string]`)
  }
  if (typeof params.protocolID[0] !== 'number' || typeof params.protocolID[1] !== 'string') {
    throw new Error(`Invalid ${paramName}: protocolID must be [number, string]`)
  }
  if (params.keyID === undefined || params.keyID === null) {
    throw new Error(`Invalid ${paramName}: keyID is required`)
  }
  if (typeof params.keyID !== 'string') {
    throw new Error(`Invalid ${paramName}: keyID must be a string`)
  }
  // counterparty is optional, defaults to 'self'
  if (params.counterparty !== undefined && typeof params.counterparty !== 'string') {
    throw new Error(`Invalid ${paramName}: counterparty must be a string (or omit for default "self")`)
  }
}

/**
 * P2PKH (Pay To Public Key Hash) class implementing ScriptTemplate.
 *
 * This class provides methods to create Pay To Public Key Hash locking and unlocking scripts
 * using a BRC-100 compatible wallet interface instead of direct private key access.
 */
export default class P2PKH implements ScriptTemplate {
  wallet?: WalletInterface

  /**
     * Creates a new P2PKH instance.
     *
     * @param wallet - Optional BRC-100 compatible wallet interface
     */
  constructor (wallet?: WalletInterface) {
    this.wallet = wallet
  }

  /**
     * Creates a P2PKH locking script from a public key hash.
     *
     * @param params - Object containing pubkeyhash (20-byte array)
     * @returns A P2PKH locking script locked to the given public key hash
     */
  lock (params: P2PKHLockWithPubkeyhash): Promise<LockingScript>
  lock (params: P2PKHLockWithAddress): Promise<LockingScript>
  /**
     * Creates a P2PKH locking script from a public key string.
     *
     * @param params - Object containing publicKey (hex string)
     * @returns A P2PKH locking script locked to the given public key
     */
  lock (params: P2PKHLockWithPublicKey): Promise<LockingScript>
  /**
     * Creates a P2PKH locking script using the instance's BRC-100 wallet to derive the public key.
     *
     * @param params - Object containing walletParams (protocolID, keyID, counterparty)
     * @returns A P2PKH locking script locked to the wallet's public key
     */
  lock (params: P2PKHLockWithWallet): Promise<LockingScript>
  async lock (params: P2PKHLockParams): Promise<LockingScript> {
    // Validate params exists before using 'in' operator
    if (!params || typeof params !== 'object') {
      throw new Error('One of pubkeyhash, publicKey, or walletParams is required')
    }

    let data: number[] | undefined

    // Process based on which parameter was provided
    if ('pubkeyhash' in params) {
      // Use byte array as hash directly
      data = params.pubkeyhash
    } else if ('address' in params) {
      // Extract pubkeyhash from base58check address
      const pkh = Utils.fromBase58Check(params.address).data as number[]
      data = pkh
    } else if ('publicKey' in params) {
      // Use public key string directly
      const pubKeyToHash = PublicKey.fromString(params.publicKey)
      data = pubKeyToHash.toHash() as number[]
    } else if ('walletParams' in params) {
      // Use wallet to derive public key - validate params
      validateWalletDerivationParams(params.walletParams, 'walletParams')

      if (this.wallet == null) {
        throw new Error('Wallet is required when using walletParams')
      }
      const { protocolID, keyID, counterparty = 'self' } = params.walletParams
      const { publicKey } = await this.wallet.getPublicKey({
        protocolID,
        keyID,
        counterparty,
        forSelf: counterparty === 'anyone'
      })
      const pubKeyToHash = PublicKey.fromString(publicKey)
      data = pubKeyToHash.toHash() as number[]
    } else {
      throw new Error('One of pubkeyhash, publicKey, or walletParams is required')
    }

    // Final validation
    if (!data || data.length !== 20) {
      throw new Error('Failed to generate valid public key hash (must be 20 bytes)')
    }

    // Build the standard P2PKH locking script
    return new LockingScript([
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: data.length, data },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ])
  }

  /**
     * Creates a function that generates a P2PKH unlocking script using the instance's BRC-100 wallet.
     *
     * The returned object contains:
     * 1. `sign` - An async function that, when invoked with a transaction and an input index,
     *    produces an unlocking script suitable for a P2PKH locked output by using the wallet
     *    to create a signature following the BRC-29 pattern.
     * 2. `estimateLength` - A function that returns the estimated length of the unlocking script (108 bytes).
     *
     * @param params - Named parameters object
     * @param params.protocolID - Protocol identifier for key derivation (default: [2, "p2pkh"])
     * @param params.keyID - Specific key identifier within the protocol (default: '0')
     * @param params.counterparty - The counterparty for which the key is being used (default: 'self')
     * @param params.signOutputs - The signature scope for outputs: 'all', 'none', or 'single' (default: 'all')
     * @param params.anyoneCanPay - Flag indicating if the signature allows for other inputs to be added later (default: false)
     * @param params.sourceSatoshis - Optional. The amount in satoshis being unlocked. Otherwise input.sourceTransaction is required.
     * @param params.lockingScript - Optional. The locking script being unlocked. Otherwise input.sourceTransaction is required.
     * @returns An object containing the `sign` and `estimateLength` functions
     */
  unlock (params?: P2PKHUnlockParams): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<108>
  } {
    if (this.wallet == null) {
      throw new Error('Wallet is required for unlocking')
    }

    // Apply defaults
    const protocolID = params?.protocolID ?? [2, 'p2pkh'] as WalletProtocol
    const keyID = params?.keyID ?? '0'
    const counterparty = params?.counterparty ?? 'self'
    const signOutputs = params?.signOutputs ?? 'all'
    const anyoneCanPay = params?.anyoneCanPay ?? false
    const sourceSatoshis = params?.sourceSatoshis
    const lockingScript = params?.lockingScript

    // Validate parameters
    if (!Array.isArray(protocolID) || protocolID.length !== 2) {
      throw new Error('protocolID must be an array of [number, string]')
    }
    if (typeof keyID !== 'string') {
      throw new Error('keyID must be a string')
    }
    if (counterparty !== undefined && typeof counterparty !== 'string') {
      throw new Error('counterparty must be a string (or omit for default "self")')
    }
    if (!['all', 'none', 'single'].includes(signOutputs)) {
      throw new Error('signOutputs must be "all", "none", or "single"')
    }
    if (typeof anyoneCanPay !== 'boolean') {
      throw new Error('anyoneCanPay must be a boolean')
    }

    const wallet = this.wallet

    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        // Calculate the transaction preimage according to Bitcoin's signature algorithm
        const { preimage, signatureScope } = calculatePreimage(tx, inputIndex, signOutputs, anyoneCanPay, sourceSatoshis, lockingScript)

        // Use the BRC-29 wallet pattern to create a signature over the double-SHA256 hash of the preimage
        const { signature } = await wallet.createSignature({
          hashToDirectlySign: Hash.hash256(preimage),
          protocolID,
          keyID,
          counterparty
        })

        // Retrieve the public key from the wallet for the same key used to sign
        const { publicKey } = await wallet.getPublicKey({
          protocolID,
          keyID,
          counterparty,
          forSelf: true
        })

        // Convert the DER-encoded signature to a TransactionSignature with the proper signature scope
        const rawSignature = Signature.fromDER(signature, 'hex')
        const sig = new TransactionSignature(
          rawSignature.r,
          rawSignature.s,
          signatureScope
        )

        // Format the signature and public key for the unlocking script
        const sigForScript = sig.toChecksigFormat()
        const pubkeyForScript = PublicKey.fromString(publicKey).encode(true) as number[]

        // Build the P2PKH unlocking script: <signature> <publicKey>
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkeyForScript.length, data: pubkeyForScript }
        ])
      },
      estimateLength: async () => {
        // public key (1+33) + signature (1+73)
        // Note: We add 1 to each element's length because of the associated OP_PUSH
        return 108
      }
    }
  }
}
