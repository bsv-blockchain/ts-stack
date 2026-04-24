import { LockingScript, Script, Utils } from '@bsv/sdk'
import { ORDINAL_MAP_PREFIX } from './constants'

/**
 * Script validation templates for common Bitcoin script patterns
 */
const SCRIPT_TEMPLATES = {
  p2pkh: {
    // OP_DUP OP_HASH160 [20 bytes] OP_EQUALVERIFY OP_CHECKSIG
    prefix: '76a914',
    suffix: '88ac',
    hashLength: 20
  },
  ordinalEnvelope: {
    // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 (BSV-20 standard)
    start: '0063036f726451126170706c69636174696f6e2f6273762d323000'
  },
  opReturn: {
    // OP_RETURN opcode
    opcode: '6a'
  }
}

/**
 * Validates that the input is a valid type for script validation
 *
 * @param input - The input to validate
 * @param functionName - Name of the calling function for error messages
 * @throws Error if input is invalid
 */
function validateInput (input: unknown, functionName: string): void {
  if (input === null || input === undefined) {
    throw new Error(`${functionName}: Input cannot be null or undefined`)
  }

  const inputType = typeof input

  // Check for arrays (typeof array is 'object')
  if (Array.isArray(input)) {
    throw new Error(`${functionName}: Input cannot be an array. Expected LockingScript, Script, or hex string`)
  }

  // Check for valid types
  if (inputType !== 'string' && inputType !== 'object') {
    throw new Error(`${functionName}: Input must be a LockingScript, Script, or hex string, got ${inputType}`)
  }

  // If it's an object, verify it has the required methods
  if (inputType === 'object') {
    const scriptObj = input as any
    if (typeof scriptObj.toHex !== 'function' || typeof scriptObj.toASM !== 'function') {
      throw new Error(`${functionName}: Object must be a LockingScript or Script with toHex() and toASM() methods`)
    }
  }

  // If it's a string, verify it's a valid hex string
  if (inputType === 'string') {
    const str = input as string
    if (str.length > 0 && !/^[0-9a-fA-F]*$/.test(str)) {
      throw new Error(`${functionName}: String must be a valid hexadecimal string`)
    }
    if (str.length % 2 !== 0) {
      throw new Error(`${functionName}: Hex string must have even length`)
    }
  }
}

/**
 * Converts a LockingScript or Script to hex string for validation
 *
 * @param script - The script to convert
 * @returns Hex string representation of the script
 */
function scriptToHex (script: LockingScript | Script): string {
  return script.toHex()
}

/**
 * Checks if a locking script is a standard P2PKH (Pay-to-Public-Key-Hash) script.
 *
 * P2PKH scripts follow the pattern:
 * OP_DUP OP_HASH160 <20-byte pubkey hash> OP_EQUALVERIFY OP_CHECKSIG
 *
 * @param script - The locking script to check
 * @returns True if the script is a standard P2PKH script
 *
 * @example
 * const script = await p2pkh.lock({ publicKey: '02...' });
 * if (isP2PKH(script)) {
 *   console.log('This is a P2PKH script');
 * }
 */
export function isP2PKH (script: LockingScript | Script): boolean

/**
 * Checks if a hex string represents a standard P2PKH (Pay-to-Public-Key-Hash) script.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string is a standard P2PKH script
 *
 * @example
 * const hex = '76a914abcd...88ac';
 * if (isP2PKH(hex)) {
 *   console.log('This is a P2PKH script');
 * }
 */
export function isP2PKH (hex: string): boolean

export function isP2PKH (input: LockingScript | Script | string): boolean {
  validateInput(input, 'isP2PKH')

  try {
    const hex = typeof input === 'string' ? input : scriptToHex(input)
    const { prefix, suffix, hashLength } = SCRIPT_TEMPLATES.p2pkh

    // P2PKH is exactly: prefix (4 chars) + length byte (2 chars) + hash (40 chars) + suffix (4 chars) = 50 chars
    const expectedLength = 4 + 2 + (hashLength * 2) + 4 // 50 hex chars

    if (hex.length !== expectedLength) {
      return false
    }

    // Check prefix (OP_DUP OP_HASH160)
    if (!hex.startsWith(prefix)) {
      return false
    }

    // Check length byte (should be 0x14 = 20 bytes)
    const lengthByte = hex.substring(4, 6)
    if (lengthByte !== '14') {
      return false
    }

    // Check suffix (OP_EQUALVERIFY OP_CHECKSIG)
    if (!hex.endsWith(suffix)) {
      return false
    }

    return true
  } catch (error) {
    return false
  }
}

/**
 * Checks if a locking script contains a BSV-20 Ordinal inscription envelope with P2PKH.
 *
 * BSV-20 Ordinal scripts combine an inscription envelope with a P2PKH script:
 * - Ordinal envelope: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 ...
 * - Followed by standard P2PKH
 *
 * This function validates both the BSV-20 ordinal envelope AND that it ends with a valid P2PKH pattern.
 *
 * @param script - The locking script to check
 * @returns True if the script contains both a BSV-20 ordinal inscription envelope and P2PKH
 *
 * @example
 * const script = await ordP2PKH.lock({
 *   publicKey: '02...',
 *   inscription: { dataB64: '...', contentType: 'image/png' }
 * });
 * if (isOrdinal(script)) {
 *   console.log('This is a BSV-20 Ordinal inscription with P2PKH');
 * }
 */
export function isOrdinal (script: LockingScript | Script): boolean

/**
 * Checks if a hex string represents a BSV-20 Ordinal inscription envelope with P2PKH.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains both a BSV-20 ordinal inscription envelope and P2PKH
 *
 * @example
 * const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000...76a914...88ac';
 * if (isOrdinal(hex)) {
 *   console.log('This is a BSV-20 Ordinal inscription with P2PKH');
 * }
 */
export function isOrdinal (hex: string): boolean

export function isOrdinal (input: LockingScript | Script | string): boolean {
  validateInput(input, 'isOrdinal')

  try {
    const hex = typeof input === 'string' ? input : scriptToHex(input)

    // Must contain ordinal envelope
    if (!hasOrd(hex)) {
      return false
    }

    // Must end with P2PKH pattern (OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG)
    // Find the P2PKH pattern: 76a914[20 bytes]88ac
    const p2pkhPattern = /76a914[0-9a-fA-F]{40}88ac/
    const hasP2PKH = p2pkhPattern.test(hex)

    return hasP2PKH
  } catch (error) {
    return false
  }
}

/**
 * Checks if a locking script contains a BSV-20 Ordinal inscription envelope.
 *
 * This checks for the presence of the BSV-20 ordinal envelope:
 * OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 ...
 *
 * This function only checks for the envelope start pattern, without validating
 * whether it's combined with P2PKH or other script types.
 *
 * @param script - The locking script to check
 * @returns True if the script contains a BSV-20 ordinal envelope
 *
 * @example
 * const script = await ordP2PKH.lock({
 *   publicKey: '02...',
 *   inscription: { dataB64: '...', contentType: 'image/png' }
 * });
 * if (hasOrd(script)) {
 *   console.log('This script contains a BSV-20 ordinal envelope');
 * }
 */
export function hasOrd (script: LockingScript | Script): boolean

/**
 * Checks if a hex string contains a BSV-20 Ordinal inscription envelope.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains a BSV-20 ordinal envelope
 *
 * @example
 * const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000...';
 * if (hasOrd(hex)) {
 *   console.log('This script contains a BSV-20 ordinal envelope');
 * }
 */
export function hasOrd (hex: string): boolean

export function hasOrd (input: LockingScript | Script | string): boolean {
  validateInput(input, 'hasOrd')

  try {
    const hex = typeof input === 'string' ? input : scriptToHex(input)
    const { start } = SCRIPT_TEMPLATES.ordinalEnvelope

    // Check if the hex contains the ordinal envelope start pattern
    // OP_0 OP_IF 'ord' = 0063036f7264
    return hex.includes(start)
  } catch (error) {
    return false
  }
}

/**
 * Checks if a locking script contains OP_RETURN data.
 *
 * OP_RETURN is used to store arbitrary data on the blockchain.
 * This function checks for the presence of the OP_RETURN opcode (0x6a).
 *
 * @param script - The locking script to check
 * @returns True if the script contains OP_RETURN data
 *
 * @example
 * const baseScript = await p2pkh.lock({ publicKey: '02...' });
 * const scriptWithData = addOpReturnData(baseScript, ['Hello', 'World']);
 * if (hasOpReturnData(scriptWithData)) {
 *   console.log('This script contains OP_RETURN data');
 * }
 */
export function hasOpReturnData (script: LockingScript | Script): boolean

/**
 * Checks if a hex string contains OP_RETURN data.
 *
 * @param hex - The hex string to check
 * @returns True if the hex string contains OP_RETURN data
 *
 * @example
 * const hex = '76a914...88ac6a...';
 * if (hasOpReturnData(hex)) {
 *   console.log('This script contains OP_RETURN data');
 * }
 */
export function hasOpReturnData (hex: string): boolean

export function hasOpReturnData (input: LockingScript | Script | string): boolean {
  validateInput(input, 'hasOpReturnData')

  try {
    if (typeof input === 'string') {
      // For hex strings, check if OP_RETURN opcode (0x6a) exists at any opcode position
      // We need to be more sophisticated than just checking if '6a' appears anywhere

      // First try to parse as a script and check ASM
      try {
        const script = Script.fromHex(input)
        const asm = script.toASM()
        if (asm.includes('OP_RETURN')) {
          return true
        }
      } catch {
        // Parsing failed, continue to manual check
      }

      // Manual check: look for '6a' opcode in the hex string
      // We check if '6a' appears at the start or after a space-equivalent position
      // This is a heuristic check for the common case where scripts are concatenated
      if (input.startsWith('6a')) {
        return true // Starts with OP_RETURN
      }

      // Check for OP_RETURN after other opcodes
      // Common patterns: ...88ac6a... (P2PKH followed by OP_RETURN)
      // We look for specific terminating opcodes followed by '6a'
      const patterns = [
        /88ac6a/, // OP_CHECKSIG followed by OP_RETURN
        /686a/, // OP_ENDIF followed by OP_RETURN
        /ae6a/ // OP_CHECKMULTISIG followed by OP_RETURN
      ]

      return patterns.some(pattern => pattern.test(input))
    } else {
      // For Script objects, use ASM which clearly identifies OP_RETURN as an opcode
      return input.toASM().includes('OP_RETURN')
    }
  } catch (error) {
    return false
  }
}

/**
 * Type representing the different script types that can be detected
 */
export type ScriptType = 'P2PKH' | 'Ordinal' | 'OpReturn' | 'Custom'

/**
 * Determines the type of a Bitcoin script.
 *
 * Detects common script types:
 * - P2PKH: Standard Pay-to-Public-Key-Hash
 * - Ordinal: BSV-20 Ordinal inscription with P2PKH
 * - OpReturn: Script containing only OP_RETURN data (no other locking mechanism)
 * - Custom: Any other script type
 *
 * @param script - The locking script to analyze
 * @returns The detected script type
 *
 * @example
 * const type = getScriptType(lockingScript);
 * if (type === 'Ordinal') {
 *   console.log('This is a BSV-20 Ordinal');
 * }
 */
export function getScriptType (script: LockingScript | Script): ScriptType

/**
 * Determines the type of a Bitcoin script from hex string.
 *
 * @param hex - The hex string to analyze
 * @returns The detected script type
 *
 * @example
 * const type = getScriptType('76a914...88ac');
 * console.log(type); // 'P2PKH'
 */
export function getScriptType (hex: string): ScriptType

export function getScriptType (input: LockingScript | Script | string): ScriptType {
  validateInput(input, 'getScriptType')

  try {
    // Check in order of specificity (most specific first)

    // 1. Check for Ordinal (BSV-20 + P2PKH)
    if (typeof input === 'string' ? isOrdinal(input) : isOrdinal(input)) {
      return 'Ordinal'
    }

    // 2. Check for pure P2PKH
    if (typeof input === 'string' ? isP2PKH(input) : isP2PKH(input)) {
      return 'P2PKH'
    }

    // 3. Check for OP_RETURN only scripts (no other locking mechanism)
    // We consider it "OpReturn" type if it has OP_RETURN but isn't P2PKH or Ordinal
    if (typeof input === 'string' ? hasOpReturnData(input) : hasOpReturnData(input)) {
      // If it has OP_RETURN and we've already ruled out P2PKH and Ordinal,
      // it's likely an OP_RETURN-only script
      const hex = typeof input === 'string' ? input : scriptToHex(input)

      // Check if it starts with OP_RETURN (pure OP_RETURN script)
      if (hex.startsWith('6a')) {
        return 'OpReturn'
      }
    }

    // 4. Everything else is custom
    return 'Custom'
  } catch (error) {
    return 'Custom'
  }
}

/**
 * Inscription data extracted from an ordinal script
 */
export interface InscriptionData {
  dataB64: string // Base64 encoded inscription data
  contentType: string // MIME type
}

/**
 * Extracts inscription data from a BSV-20 Ordinal script.
 *
 * Parses the ordinal envelope to extract the content type and data.
 * The BSV-20 envelope format is:
 * OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0 <contentType> OP_0 <data> OP_ENDIF
 *
 * @param script - The ordinal locking script
 * @returns Inscription data object or null if not found/invalid
 *
 * @example
 * const inscription = extractInscriptionData(ordinalScript);
 * if (inscription) {
 *   console.log(`Type: ${inscription.contentType}`);
 *   const data = Buffer.from(inscription.dataB64, 'base64');
 * }
 */
export function extractInscriptionData (script: LockingScript | Script): InscriptionData | null

/**
 * Extracts inscription data from a BSV-20 Ordinal script hex string.
 *
 * @param hex - The hex string to parse
 * @returns Inscription data object or null if not found/invalid
 *
 * @example
 * const inscription = extractInscriptionData(scriptHex);
 * if (inscription) {
 *   const imageData = Buffer.from(inscription.dataB64, 'base64');
 * }
 */
export function extractInscriptionData (hex: string): InscriptionData | null

export function extractInscriptionData (input: LockingScript | Script | string): InscriptionData | null {
  validateInput(input, 'extractInscriptionData')

  // Convert to Script object for chunk parsing
  const script = typeof input === 'string' ? Script.fromHex(input) : input
  const chunks = script.chunks

  // Check if this has an ordinal envelope
  if (typeof input === 'string' ? !hasOrd(input) : !hasOrd(input)) {
    return null // No ordinal envelope, not an error
  }

  // BSV-20 envelope structure (with content type):
  // 0: OP_0
  // 1: OP_IF (0x63)
  // 2: 'ord' (3 bytes)
  // 3: OP_1
  // 4: 'application/bsv-20' (18 bytes)
  // 5: OP_0
  // 6: contentType (variable length)
  // 7: OP_0
  // 8: data (variable length)
  // 9: OP_ENDIF (0x68)
  //
  // BSV-20 envelope structure (without content type):
  // 0: OP_0
  // 1: OP_IF (0x63)
  // 2: 'ord' (3 bytes)
  // 3: OP_1
  // 4: 'application/bsv-20' (18 bytes)
  // 5: OP_0
  // 6: data (variable length)
  // 7: OP_ENDIF (0x68)

  // Find OP_ENDIF to determine where the envelope ends
  const endifIndex = chunks.findIndex(chunk => chunk.op === 0x68) // OP_ENDIF
  if (endifIndex === -1) {
    throw new Error('extractInscriptionData: Malformed ordinal script - missing OP_ENDIF')
  }

  let contentType: string
  let dataB64: string

  if (endifIndex === 9) {
    // Full format with content type (OP_ENDIF at position 9)
    const contentTypeChunk = chunks[6]
    if (!contentTypeChunk || (contentTypeChunk.data == null) || contentTypeChunk.data.length === 0) {
      throw new Error('extractInscriptionData: Missing content type data at chunk 6')
    }

    try {
      contentType = Utils.toUTF8(contentTypeChunk.data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`extractInscriptionData: Invalid UTF-8 in content type: ${message}`)
    }

    // Extract data (chunk 8)
    const dataChunk = chunks[8]
    if (!dataChunk || (dataChunk.data == null) || dataChunk.data.length === 0) {
      throw new Error('extractInscriptionData: Missing inscription data at chunk 8')
    }
    dataB64 = Buffer.from(dataChunk.data).toString('base64')
  } else if (endifIndex === 7) {
    // Short format without content type (OP_ENDIF at position 7)
    const dataChunk = chunks[6]
    if (!dataChunk || (dataChunk.data == null) || dataChunk.data.length === 0) {
      throw new Error('extractInscriptionData: Missing inscription data at chunk 6')
    }
    contentType = 'application/octet-stream' // Default when not specified
    dataB64 = Buffer.from(dataChunk.data).toString('base64')
  } else {
    throw new Error(`extractInscriptionData: Unexpected OP_ENDIF position at index ${endifIndex}. Expected 7 (without content type) or 9 (with content type)`)
  }

  return {
    dataB64,
    contentType
  }
}

/**
 * MAP metadata object with required app and type fields
 */
export interface MAP {
  app: string
  type: string
  [key: string]: string
}

/**
 * Extracts MAP (Magic Attribute Protocol) metadata from a script.
 *
 * MAP metadata is stored in OP_RETURN fields with the format:
 * OP_RETURN <MAP_PREFIX> 'SET' <key1> <value1> <key2> <value2> ...
 *
 * @param script - The locking script containing MAP data
 * @returns MAP metadata object or null if not found/invalid
 *
 * @example
 * const metadata = extractMapMetadata(ordinalScript);
 * if (metadata) {
 *   console.log(`App: ${metadata.app}, Type: ${metadata.type}`);
 *   console.log(`Author: ${metadata.author}`);
 * }
 */
export function extractMapMetadata (script: LockingScript | Script): MAP | null

/**
 * Extracts MAP metadata from a script hex string.
 *
 * @param hex - The hex string to parse
 * @returns MAP metadata object or null if not found/invalid
 *
 * @example
 * const metadata = extractMapMetadata(scriptHex);
 * if (metadata?.app === 'my-app') {
 *   // Process app-specific metadata
 * }
 */
export function extractMapMetadata (hex: string): MAP | null

export function extractMapMetadata (input: LockingScript | Script | string): MAP | null {
  validateInput(input, 'extractMapMetadata')

  // Must have OP_RETURN data
  if (typeof input === 'string' ? !hasOpReturnData(input) : !hasOpReturnData(input)) {
    return null
  }

  const script = typeof input === 'string' ? Script.fromHex(input) : input
  const chunks = script.chunks

  // Find OP_RETURN chunk
  const opReturnIndex = chunks.findIndex(chunk => chunk.op === 0x6a)
  if (opReturnIndex === -1) {
    return null
  }

  // Next chunk should be MAP prefix
  const prefixChunk = chunks[opReturnIndex + 1]
  if (!prefixChunk || (prefixChunk.data == null) || prefixChunk.data.length === 0) {
    return null
  }

  let prefix: string
  try {
    prefix = Utils.toUTF8(prefixChunk.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`extractMapMetadata: Invalid UTF-8 in MAP prefix: ${message}`)
  }

  if (prefix !== ORDINAL_MAP_PREFIX) {
    return null
  }

  // Next chunk should be 'SET' command
  const cmdChunk = chunks[opReturnIndex + 2]
  if (!cmdChunk || (cmdChunk.data == null) || cmdChunk.data.length === 0) {
    return null
  }

  let cmd: string
  try {
    cmd = Utils.toUTF8(cmdChunk.data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`extractMapMetadata: Invalid UTF-8 in command: ${message}`)
  }

  if (cmd !== 'SET') {
    return null
  }

  // Parse key-value pairs
  const metadata: any = {}
  let currentIndex = opReturnIndex + 3

  while (currentIndex < chunks.length - 1) {
    const keyChunk = chunks[currentIndex]
    const valueChunk = chunks[currentIndex + 1]

    if (((keyChunk?.data) == null) || ((valueChunk?.data) == null)) {
      break
    }

    try {
      const key = Utils.toUTF8(keyChunk.data)
      const value = Utils.toUTF8(valueChunk.data)
      metadata[key] = value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`extractMapMetadata: Invalid UTF-8 in metadata key-value pair: ${message}`)
    }

    currentIndex += 2
  }

  // Validate required fields
  if (!metadata.app || !metadata.type) {
    return null
  }

  return metadata as MAP
}

/**
 * Extracts OP_RETURN data fields from a script.
 *
 * Parses the script to find OP_RETURN and returns all subsequent data fields
 * as an array of base64-encoded strings. This supports arbitrary binary data
 * including images, videos, and other file types.
 *
 * @param script - The locking script containing OP_RETURN data
 * @returns Array of base64-encoded data fields, or null if no OP_RETURN found
 *
 * @example
 * const data = extractOpReturnData(script);
 * if (data) {
 *   // Decode text
 *   const text = Buffer.from(data[0], 'base64').toString('utf8');
 *   console.log('First field:', text);
 *
 *   // Decode binary data (e.g., image)
 *   const imageData = Buffer.from(data[1], 'base64');
 *   fs.writeFileSync('image.png', imageData);
 * }
 */
export function extractOpReturnData (script: LockingScript | Script): string[] | null

/**
 * Extracts OP_RETURN data fields from a script hex string.
 *
 * @param hex - The hex string to parse
 * @returns Array of base64-encoded data fields, or null if no OP_RETURN found
 *
 * @example
 * const data = extractOpReturnData('76a914...88ac6a0548656c6c6f');
 * if (data) {
 *   const text = Buffer.from(data[0], 'base64').toString('utf8');
 *   console.log('Decoded:', text);
 * }
 */
export function extractOpReturnData (hex: string): string[] | null

export function extractOpReturnData (input: LockingScript | Script | string): string[] | null {
  validateInput(input, 'extractOpReturnData')

  if (typeof input === 'string' ? !hasOpReturnData(input) : !hasOpReturnData(input)) {
    return null
  }

  const script = typeof input === 'string' ? Script.fromHex(input) : input
  const chunks = script.chunks

  // Find OP_RETURN chunk (opcode 0x6a = 106)
  const opReturnIndex = chunks.findIndex(chunk => chunk.op === 0x6a)
  if (opReturnIndex === -1) {
    return null
  }

  // Extract all data chunks after OP_RETURN
  const dataFields: string[] = []
  for (let i = opReturnIndex + 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    if ((chunk.data != null) && chunk.data.length > 0) {
      // Convert byte array to base64 string
      dataFields.push(Utils.toBase64(chunk.data))
    }
  }

  return dataFields.length > 0 ? dataFields : null
}
