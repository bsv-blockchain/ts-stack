import { LockingScript, Utils } from '@bsv/sdk'

/**
 * Checks if a string is a valid hexadecimal string.
 *
 * @param str - The string to check
 * @returns True if the string is valid hex, false otherwise
 */
const isHex = (str: string): boolean => {
  if (str.length === 0) return true // Empty string is valid hex
  if (str.length % 2 !== 0) return false // Hex strings must have even length
  return /^[0-9a-fA-F]+$/.test(str)
}

/**
 * Converts a field to hex format.
 *
 * @param field - Either a UTF-8 string, hex string, or byte array
 * @returns Hex-encoded string (lowercase)
 */
const toHexField = (field: string | number[]): string => {
  if (Array.isArray(field)) {
    // Convert byte array to hex
    return Utils.toHex(field)
  }

  // Check if it's already a hex string
  if (isHex(field)) {
    // Normalize to lowercase for SDK compatibility
    return field.toLowerCase()
  }

  // Convert UTF-8 string to hex
  return Utils.toHex(Utils.toArray(field))
}

/**
 * Appends OP_RETURN data fields to a locking script for adding metadata.
 *
 * @param script - The base locking script to append OP_RETURN data to
 * @param fields - Array of data fields. Each field can be:
 *                 - UTF-8 string (auto-converted to hex)
 *                 - Hex string (detected and preserved)
 *                 - Byte array (converted to hex)
 * @returns A new locking script with the OP_RETURN data appended
 * @throws Error if no fields are provided
 *
 * @see README.md for usage examples
 * @see __tests__/opreturn.test.ts for additional examples
 */
export const addOpReturnData = (
  script: LockingScript,
  fields: Array<string | number[]>
): LockingScript => {
  // Validate script parameter
  if (!script || typeof script.toASM !== 'function') {
    throw new Error('Invalid script parameter: must be a LockingScript instance')
  }

  // Check if script already contains OP_RETURN
  const scriptAsm = script.toASM()
  if (scriptAsm.includes('OP_RETURN')) {
    throw new Error('Script already contains OP_RETURN. Cannot add multiple OP_RETURN statements to the same script.')
  }

  // Validate fields parameter
  if (!Array.isArray(fields)) {
    throw new Error('Invalid fields parameter: must be an array of strings or number arrays')
  }

  if (fields.length === 0) {
    throw new Error('At least one data field is required for OP_RETURN')
  }

  // Validate each field type
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const isString = typeof field === 'string'

    if (!isString) {
      if (!Array.isArray(field)) {
        throw new Error(
          `Invalid field at index ${i}: must be a string or number array, got ${typeof field}`
        )
      }

      // For number arrays, validate only first 100 elements
      const sampleSize = Math.min(field.length, 100)
      for (let j = 0; j < sampleSize; j++) {
        const idx = Math.floor((j / sampleSize) * field.length)
        if (typeof field[idx] !== 'number') {
          throw new Error(
            `Invalid field at index ${i}: array contains non-number at position ${idx}`
          )
        }
      }
    }
  }

  // Convert all fields to hex
  const hexFields = fields.map(toHexField)

  // Build the ASM string with OP_RETURN followed by all data fields
  const baseAsm = script.toASM()
  const dataFieldsAsm = hexFields.join(' ')
  const fullAsm = `${baseAsm} OP_RETURN ${dataFieldsAsm}`

  return LockingScript.fromASM(fullAsm)
}
