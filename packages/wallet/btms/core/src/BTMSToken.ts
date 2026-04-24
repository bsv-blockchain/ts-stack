/**
 * BTMSToken - Token Encoding and Decoding
 * 
 * This module handles the encoding and decoding of BTMS tokens using PushDrop.
 * It implements the exact 3-field schema expected by BTMSTopicManager:
 * 
 * Field 0: assetId (or "ISSUE" for new tokens)
 * Field 1: amount (as UTF-8 string)
 * Field 2: metadata (optional JSON string)
 */

import {
  LockingScript,
  PushDrop,
  Utils,
  WalletInterface,
  WalletClient,
  WalletProtocol,
  WalletCounterparty
} from '@bsv/sdk'

import type { BTMSTokenDecodeResult, DecodedBTMSToken } from './types.js'
import { BTMS_PROTOCOL_ID, ISSUE_MARKER, MIN_TOKEN_AMOUNT, MAX_TOKEN_AMOUNT } from './constants.js'

/**
 * BTMSToken handles encoding and decoding of BTMS PushDrop tokens.
 * 
 * The token format follows the BTMSTopicManager protocol exactly:
 * - Field 0: assetId or "ISSUE"
 * - Field 1: amount (positive integer as string)
 * - Field 2: metadata (optional JSON)
 * 
 * @example
 * ```typescript
 * const token = new BTMSToken(wallet)
 * 
 * // Create an issuance token
 * const lockScript = await token.createIssuance(1000, { name: 'MyToken' })
 * 
 * // Create a transfer token
 * const transferScript = await token.createTransfer('abc123.0', 500, metadata, recipient)
 * 
 * // Decode a token
 * const decoded = BTMSToken.decode(lockingScriptHex)
 * ```
 */
export class BTMSToken {
  private wallet: WalletInterface
  private protocolID: WalletProtocol
  private originator?: string

  constructor(
    wallet?: WalletInterface,
    protocolID: WalletProtocol = BTMS_PROTOCOL_ID,
    originator?: string
  ) {
    this.wallet = wallet ?? new WalletClient()
    this.protocolID = protocolID
    this.originator = originator
  }

  /**
   * Create a token issuance locking script.
   * 
   * Issuance tokens use "ISSUE" as field[0]. The canonical assetId
   * becomes `{txid}.{outputIndex}` after the transaction is mined.
   * 
   * @param amount - Number of tokens to issue (positive integer)
   * @param keyID - Key ID for derivation
   * @param metadata - Optional metadata object (will be JSON stringified)
   * @param counterparty - Who can spend this token (default: 'self')
   * @returns The locking script for the issuance output
   */
  async createIssuance(
    amount: number,
    keyID: string,
    metadata?: Record<string, unknown>,
    counterparty: WalletCounterparty = 'self'
  ): Promise<LockingScript> {
    this.validateAmount(amount)

    const fields = this.buildFields(ISSUE_MARKER, amount, metadata)
    const pushdrop = new PushDrop(this.wallet, this.originator)

    return pushdrop.lock(
      fields,
      this.protocolID,
      keyID,
      counterparty,
      false
    )
  }

  /**
   * Create a token transfer locking script.
   * 
   * Transfer tokens reference an existing assetId in field[0].
   * The metadata must match the original issuance metadata for the
   * TopicManager to accept the output.
   * 
   * @param assetId - The canonical asset ID (txid.outputIndex format)
   * @param amount - Number of tokens to transfer (positive integer)
   * @param metadata - Metadata (must match original issuance)
   * @param counterparty - Recipient's identity key or 'self'
   * @param keyID - key ID for derivation
   * @param includeSignature - Whether to include PushDrop signature (default false, since signAction handles signing)
   * @returns The locking script for the transfer output
   */
  async createTransfer(
    assetId: string,
    amount: number,
    keyID: string,
    counterparty: WalletCounterparty = 'self',
    metadata?: string,
    includeSignature = false
  ): Promise<LockingScript> {
    this.validateAmount(amount)
    this.validateAssetId(assetId)

    // For transfers, metadata is passed as-is (already stringified from original)
    const fields = this.buildFieldsRaw(assetId, amount, metadata)
    const pushdrop = new PushDrop(this.wallet, this.originator)

    return pushdrop.lock(
      fields,
      this.protocolID,
      keyID,
      counterparty,
      false,
      includeSignature
    )
  }

  /**
   * Create an unlocking script template for spending a BTMS token.
   * 
   * @param counterparty - The counterparty used when the token was created
   * @param keyID - Key ID for derivation from customInstructions
   * @returns An unlocker that can sign transactions
   */
  createUnlocker(counterparty: WalletCounterparty = 'self', keyID: string) {
    return new PushDrop(this.wallet, this.originator).unlock(
      this.protocolID,
      keyID,
      counterparty
    )
  }

  /**
   * Decode a BTMS token from a locking script.
   * 
   * This is a static method that can be used without a wallet instance.
   * 
   * @param lockingScript - The locking script (hex string or LockingScript)
   * @returns Decoded token data or invalid result
   */
  static decode(lockingScript: string | LockingScript): BTMSTokenDecodeResult {
    try {
      const script = typeof lockingScript === 'string'
        ? LockingScript.fromHex(lockingScript)
        : lockingScript

      const decoded = PushDrop.decode(script)
      const fields = decoded.fields

      // BTMS tokens have 2-4 fields:
      // - Without signature: 2 fields (assetId, amount) or 3 fields (assetId, amount, metadata)
      // - With signature: 3 fields (assetId, amount, signature) or 4 fields (assetId, amount, metadata, signature)
      if (fields.length < 2 || fields.length > 4) {
        return {
          valid: false,
          error: `Invalid field count: expected 2-4, got ${fields.length}`
        }
      }

      // Decode fields
      const assetId = Utils.toUTF8(fields[0])
      const amountStr = Utils.toUTF8(fields[1])

      // Try to get metadata from field 2 if it looks like JSON
      let metadata: string | undefined
      if (fields.length >= 3) {
        const potentialMetadata = Utils.toUTF8(fields[2])
        // Only treat as metadata if it starts with { (JSON object)
        if (potentialMetadata.startsWith('{')) {
          metadata = potentialMetadata
        }
      }

      // Validate amount
      const amount = Number(amountStr)
      if (!Number.isFinite(amount) || amount < MIN_TOKEN_AMOUNT || !Number.isInteger(amount)) {
        return {
          valid: false,
          error: `Invalid amount: ${amountStr}`
        }
      }

      // Validate assetId format (either "ISSUE" or txid.outputIndex format)
      if (assetId !== ISSUE_MARKER && !BTMSToken.isValidAssetId(assetId)) {
        return {
          valid: false,
          error: `Invalid assetId format: ${assetId}`
        }
      }

      // Validate metadata is valid JSON if present
      if (metadata) {
        try {
          JSON.parse(metadata)
        } catch {
          return {
            valid: false,
            error: 'Metadata is not valid JSON'
          }
        }
      }

      return {
        valid: true,
        assetId,
        amount,
        metadata,
        lockingPublicKey: decoded.lockingPublicKey.toString()
      }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : 'Failed to decode token'
      }
    }
  }

  /**
   * Check if a string is a valid asset ID format (txid.outputIndex)
   */
  static isValidAssetId(assetId: string): boolean {
    if (assetId === ISSUE_MARKER) return false

    const parts = assetId.split('.')
    if (parts.length !== 2) return false

    const [txid, outputIndexStr] = parts

    // txid should be 64 hex characters
    if (!/^[a-fA-F0-9]{64}$/.test(txid)) return false

    // outputIndex should be a non-negative integer
    const outputIndex = Number(outputIndexStr)
    if (!Number.isInteger(outputIndex) || outputIndex < 0) return false

    return true
  }

  /**
   * Check if a decoded token is an issuance
   */
  static isIssuance(decoded: DecodedBTMSToken): boolean {
    return decoded.assetId === ISSUE_MARKER
  }

  /**
   * Compute the canonical asset ID from a transaction ID and output index.
   * This is used after an issuance transaction is mined.
   */
  static computeAssetId(txid: string, outputIndex: number): string {
    return `${txid}.${outputIndex}`
  }

  // ---------------------------------------------------------------------------
  // Private Methods
  // ---------------------------------------------------------------------------

  private validateAmount(amount: number): void {
    if (!Number.isFinite(amount)) {
      throw new Error('Amount must be a finite number')
    }
    if (!Number.isInteger(amount)) {
      throw new Error('Amount must be an integer')
    }
    if (amount < MIN_TOKEN_AMOUNT) {
      throw new Error(`Amount must be at least ${MIN_TOKEN_AMOUNT}`)
    }
    if (amount > MAX_TOKEN_AMOUNT) {
      throw new Error(`Amount must not exceed ${MAX_TOKEN_AMOUNT}`)
    }
  }

  private validateAssetId(assetId: string): void {
    if (!BTMSToken.isValidAssetId(assetId)) {
      throw new Error(`Invalid assetId format: ${assetId}. Expected txid.outputIndex format.`)
    }
  }

  private buildFields(
    assetId: string,
    amount: number,
    metadata?: Record<string, unknown>
  ): number[][] {
    const fields: number[][] = [
      Utils.toArray(assetId, 'utf8'),
      Utils.toArray(String(amount), 'utf8')
    ]

    if (metadata && Object.keys(metadata).length > 0) {
      fields.push(Utils.toArray(JSON.stringify(metadata), 'utf8'))
    }

    return fields
  }

  private buildFieldsRaw(
    assetId: string,
    amount: number,
    metadata?: string
  ): number[][] {
    const fields: number[][] = [
      Utils.toArray(assetId, 'utf8'),
      Utils.toArray(String(amount), 'utf8')
    ]

    if (metadata) {
      fields.push(Utils.toArray(metadata, 'utf8'))
    }

    return fields
  }
}
