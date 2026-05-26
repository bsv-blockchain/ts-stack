import { LockingScript } from '@bsv/sdk';
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
export declare const addOpReturnData: (script: LockingScript, fields: Array<string | number[]>) => LockingScript;
//# sourceMappingURL=opreturn.d.ts.map