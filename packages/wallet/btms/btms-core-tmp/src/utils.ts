/**
 * Utility functions for BTMS
 */

import { HexString, TXIDHexString, OutpointString } from '@bsv/sdk'
import { BTMSToken } from './BTMSToken.js'
import { DEFAULT_TOKEN_SATOSHIS, ISSUE_MARKER } from './constants.js'

/**
 * Parsed custom instructions containing key derivation info
 */
export interface ParsedCustomInstructions {
  /** The keyID string (derivationPrefix + ' ' + derivationSuffix) */
  keyID: string
  /** The sender's identity key (counterparty for unlocking) */
  senderIdentityKey?: string
}

/**
 * Extract keyID and senderIdentityKey from customInstructions stored with a UTXO.
 * 
 * @param customInstructions - The customInstructions JSON string
 * @param txid - Transaction ID (for error messages)
 * @param outputIndex - Output index (for error messages)
 * @returns Parsed instructions containing keyID and optional senderIdentityKey
 * @throws Error if customInstructions are missing or invalid
 */
export function parseCustomInstructions(
  customInstructions: string | undefined,
  txid: string,
  outputIndex: number
): ParsedCustomInstructions {
  if (!customInstructions) {
    throw new Error(`Missing customInstructions for UTXO ${txid}.${outputIndex}`)
  }
  try {
    const instructions = JSON.parse(customInstructions)
    if (instructions.derivationPrefix && instructions.derivationSuffix) {
      return {
        keyID: `${instructions.derivationPrefix} ${instructions.derivationSuffix}`,
        senderIdentityKey: instructions.senderIdentityKey
      }
    } else {
      throw new Error('Missing derivation info in customInstructions')
    }
  } catch (error) {
    throw new Error(`Invalid customInstructions for UTXO ${txid}.${outputIndex}: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}

/**
 * Decode and extract token amount from an output locking script.
 * Handles ISSUE_MARKER conversion to canonical assetId.
 * 
 * @param output - Output with locking script, satoshis, and index
 * @param txid - Transaction ID for computing asset ID from ISSUE_MARKER
 * @param assetId - Expected asset ID to match against
 * @returns Token amount if valid and matches assetId, null otherwise
 */
export function decodeOutputAmount(
  output: { lockingScript?: HexString; satoshis: number; outputIndex: number },
  txid: TXIDHexString,
  assetId: string
): number | null {
  if (!output.lockingScript || output.satoshis !== DEFAULT_TOKEN_SATOSHIS) return null
  const decoded = BTMSToken.decode(output.lockingScript)
  if (!decoded.valid) return null

  let outputAssetId = decoded.assetId
  if (decoded.assetId === ISSUE_MARKER) {
    outputAssetId = BTMSToken.computeAssetId(txid, output.outputIndex)
  }

  if (outputAssetId !== assetId) return null
  return decoded.amount
}

/**
 * Decode and extract token amount from an input source locking script.
 * Handles ISSUE_MARKER conversion using source outpoint.
 * 
 * @param input - Input with source locking script and outpoint
 * @param assetId - Expected asset ID to match against
 * @returns Token amount if valid and matches assetId, null otherwise
 */
export function decodeInputAmount(
  input: { sourceLockingScript?: HexString; sourceOutpoint: OutpointString },
  assetId: string
): number | null {
  if (!input.sourceLockingScript) return null
  const decoded = BTMSToken.decode(input.sourceLockingScript)
  if (!decoded.valid) return null

  let inputAssetId = decoded.assetId
  if (decoded.assetId === ISSUE_MARKER) {
    const [sourceTxid, sourceIndex] = input.sourceOutpoint.split('.')
    inputAssetId = BTMSToken.computeAssetId(sourceTxid as TXIDHexString, Number(sourceIndex))
  }

  if (inputAssetId !== assetId) return null
  return decoded.amount
}
