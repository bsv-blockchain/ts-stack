import { LockingScript, Script } from '@bsv/sdk';
/** Accepted input types for script validation functions. */
type ScriptInput = LockingScript | Script | string;
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
export declare function isP2PKH(script: LockingScript | Script): boolean;
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
export declare function isP2PKH(hex: string): boolean;
export declare function isP2PKH(input: ScriptInput): boolean;
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
export declare function isOrdinal(script: LockingScript | Script): boolean;
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
export declare function isOrdinal(hex: string): boolean;
export declare function isOrdinal(input: ScriptInput): boolean;
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
export declare function hasOrd(script: LockingScript | Script): boolean;
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
export declare function hasOrd(hex: string): boolean;
export declare function hasOrd(input: ScriptInput): boolean;
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
export declare function hasOpReturnData(script: LockingScript | Script): boolean;
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
export declare function hasOpReturnData(hex: string): boolean;
export declare function hasOpReturnData(input: ScriptInput): boolean;
/**
 * Type representing the different script types that can be detected
 */
export type ScriptType = 'P2PKH' | 'Ordinal' | 'OpReturn' | 'Custom';
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
export declare function getScriptType(script: LockingScript | Script): ScriptType;
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
export declare function getScriptType(hex: string): ScriptType;
/**
 * Inscription data extracted from an ordinal script
 */
export interface InscriptionData {
    dataB64: string;
    contentType: string;
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
export declare function extractInscriptionData(script: LockingScript | Script): InscriptionData | null;
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
export declare function extractInscriptionData(hex: string): InscriptionData | null;
/**
 * MAP metadata object with required app and type fields
 */
export interface MAP {
    app: string;
    type: string;
    [key: string]: string;
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
export declare function extractMapMetadata(script: LockingScript | Script): MAP | null;
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
export declare function extractMapMetadata(hex: string): MAP | null;
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
export declare function extractOpReturnData(script: LockingScript | Script): string[] | null;
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
export declare function extractOpReturnData(hex: string): string[] | null;
export {};
//# sourceMappingURL=scriptValidation.d.ts.map