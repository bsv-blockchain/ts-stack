import { LockingScript, OP, PublicKey, Utils } from '@bsv/sdk';
import {
  isP2PKH,
  isOrdinal,
  hasOrd,
  hasOpReturnData,
  extractOpReturnData,
  extractMapMetadata,
  extractInscriptionData,
  getScriptType,
  type ScriptType,
  type InscriptionData,
  type MAP
} from '../scriptValidation';
import P2PKH from '../../script-templates/p2pkh';
import OrdP2PKH from '../../script-templates/ordinal';
import { addOpReturnData } from '../opreturn';
import { ORDINAL_MAP_PREFIX } from '../constants';

describe('Script Validation Functions', () => {
  describe('isP2PKH', () => {
    describe('with LockingScript input', () => {
      it('should return true for a standard P2PKH script', () => {
        // Create a standard P2PKH script
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(isP2PKH(script)).toBe(true);
      });

      it('should return false for a script that is not P2PKH', () => {
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 }
        ]);

        expect(isP2PKH(script)).toBe(false);
      });

      it('should return false for a script with wrong hash length', () => {
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 19, data: new Array(19).fill(0xAB) }, // Wrong length
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(isP2PKH(script)).toBe(false);
      });

      it('should return false for a script with wrong opcodes', () => {
        const script = new LockingScript([
          { op: OP.OP_HASH160 }, // Missing OP_DUP
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(isP2PKH(script)).toBe(false);
      });
    });

    describe('with hex string input', () => {
      it('should return true for a valid P2PKH hex string', () => {
        // Standard P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
        const hex = '76a914' + 'ab'.repeat(20) + '88ac';
        expect(isP2PKH(hex)).toBe(true);
      });

      it('should return false for invalid P2PKH hex string', () => {
        const hex = '76a914' + 'ab'.repeat(19) + '88ac'; // 19 bytes instead of 20
        expect(isP2PKH(hex)).toBe(false);
      });

      it('should return false for hex string with wrong prefix', () => {
        const hex = '76a9' + 'ab'.repeat(20) + '88ac'; // Wrong prefix
        expect(isP2PKH(hex)).toBe(false);
      });

      it('should return false for hex string with wrong suffix', () => {
        const hex = '76a914' + 'ab'.repeat(20) + '88'; // Wrong suffix
        expect(isP2PKH(hex)).toBe(false);
      });

      it('should return false for empty hex string', () => {
        expect(isP2PKH('')).toBe(false);
      });
    });
  });

  describe('isOrdinal', () => {
    describe('with LockingScript input', () => {
      it('should return true for an Ordinal inscription with P2PKH', () => {
        // Create a BSV-20 ordinal envelope followed by P2PKH
        // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
        const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
        const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
        const fullHex = ordinalHex + '68656c6c6f' + '68' + p2pkhHex; // + data + OP_ENDIF + P2PKH

        const script = LockingScript.fromHex(fullHex);
        expect(isOrdinal(script)).toBe(true);
      });

      it('should return false for P2PKH without ordinal envelope', () => {
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(isOrdinal(script)).toBe(false);
      });

      it('should return false for ordinal envelope without P2PKH', () => {
        // BSV-20 envelope + data + OP_ENDIF, but no P2PKH
        const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000' + '68656c6c6f' + '68';
        const script = LockingScript.fromHex(ordinalHex);

        expect(isOrdinal(script)).toBe(false);
      });
    });

    describe('with hex string input', () => {
      it('should return true for valid Ordinal + P2PKH hex', () => {
        // BSV-20: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
        const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
        const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
        const fullHex = ordinalHex + '68656c6c6f' + '68' + p2pkhHex; // + data + OP_ENDIF + P2PKH

        expect(isOrdinal(fullHex)).toBe(true);
      });

      it('should return false for P2PKH hex without ordinal', () => {
        const hex = '76a914' + 'ab'.repeat(20) + '88ac';
        expect(isOrdinal(hex)).toBe(false);
      });

      it('should return false for ordinal hex without P2PKH', () => {
        // BSV-20 envelope + data + OP_ENDIF, but no P2PKH
        const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000' + '68656c6c6f' + '68';
        expect(isOrdinal(hex)).toBe(false);
      });

      it('should return false for empty hex string', () => {
        expect(isOrdinal('')).toBe(false);
      });
    });
  });

  describe('hasOrd', () => {
    describe('with LockingScript input', () => {
      it('should return true for script with ordinal envelope', () => {
        // BSV-20: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
        const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
        const fullHex = ordinalHex + '68656c6c6f' + '68'; // + data + OP_ENDIF
        const script = LockingScript.fromHex(fullHex);

        expect(hasOrd(script)).toBe(true);
      });

      it('should return true for Ordinal + P2PKH script', () => {
        // BSV-20 envelope
        const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
        const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
        const fullHex = ordinalHex + '68656c6c6f' + '68' + p2pkhHex; // + data + OP_ENDIF + P2PKH
        const script = LockingScript.fromHex(fullHex);

        expect(hasOrd(script)).toBe(true);
      });

      it('should return false for P2PKH script without ordinal', () => {
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(hasOrd(script)).toBe(false);
      });

      it('should return false for arbitrary script without ordinal', () => {
        const script = new LockingScript([
          { op: OP.OP_RETURN },
          { op: 5, data: [0x48, 0x65, 0x6c, 0x6c, 0x6f] }
        ]);

        expect(hasOrd(script)).toBe(false);
      });
    });

    describe('with hex string input', () => {
      it('should return true for hex with ordinal envelope', () => {
        // BSV-20: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
        const hex = '0063036f726451126170706c69636174696f6e2f6273762d323000' + '68656c6c6f' + '68';
        expect(hasOrd(hex)).toBe(true);
      });

      it('should return false for P2PKH hex without ordinal', () => {
        const hex = '76a914' + 'ab'.repeat(20) + '88ac';
        expect(hasOrd(hex)).toBe(false);
      });

      it('should return false for empty hex string', () => {
        expect(hasOrd('')).toBe(false);
      });

      it('should return false for hex without ordinal pattern', () => {
        const hex = 'deadbeef1234567890';
        expect(hasOrd(hex)).toBe(false);
      });
    });
  });

  describe('hasOpReturnData', () => {
    describe('with LockingScript input', () => {
      it('should return true for script with OP_RETURN', () => {
        const baseScript = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        const scriptWithOpReturn = addOpReturnData(baseScript, ['Hello', 'World']);
        expect(hasOpReturnData(scriptWithOpReturn)).toBe(true);
      });

      it('should return false for P2PKH script without OP_RETURN', () => {
        const script = new LockingScript([
          { op: OP.OP_DUP },
          { op: OP.OP_HASH160 },
          { op: 20, data: new Array(20).fill(0xAB) },
          { op: OP.OP_EQUALVERIFY },
          { op: OP.OP_CHECKSIG }
        ]);

        expect(hasOpReturnData(script)).toBe(false);
      });

      it('should return true for script with only OP_RETURN', () => {
        const script = new LockingScript([
          { op: OP.OP_RETURN },
          { op: 5, data: [0x48, 0x65, 0x6c, 0x6c, 0x6f] }
        ]);

        expect(hasOpReturnData(script)).toBe(true);
      });

      it('should return false for empty script', () => {
        const script = new LockingScript([]);
        expect(hasOpReturnData(script)).toBe(false);
      });
    });

    describe('with hex string input', () => {
      it('should return true for hex with OP_RETURN (0x6a)', () => {
        const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
        const opReturnHex = '6a' + '05' + '48656c6c6f'; // OP_RETURN "Hello"
        const hex = p2pkhHex + opReturnHex;

        expect(hasOpReturnData(hex)).toBe(true);
      });

      it('should return false for P2PKH hex without OP_RETURN', () => {
        const hex = '76a914' + 'ab'.repeat(20) + '88ac';
        expect(hasOpReturnData(hex)).toBe(false);
      });

      it('should return true for hex starting with OP_RETURN', () => {
        const hex = '6a' + '05' + '48656c6c6f';
        expect(hasOpReturnData(hex)).toBe(true);
      });

      it('should return false for empty hex string', () => {
        expect(hasOpReturnData('')).toBe(false);
      });

      it('should return false for hex without OP_RETURN', () => {
        const hex = 'deadbeef1234567890';
        expect(hasOpReturnData(hex)).toBe(false);
      });
    });
  });

  describe('Combined scenarios', () => {
    it('should correctly identify P2PKH in a complex script', () => {
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      expect(isP2PKH(baseScript)).toBe(true);
      expect(hasOrd(baseScript)).toBe(false);
      expect(isOrdinal(baseScript)).toBe(false);
      expect(hasOpReturnData(baseScript)).toBe(false);
    });

    it('should correctly identify P2PKH with OP_RETURN', () => {
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      const scriptWithOpReturn = addOpReturnData(baseScript, ['test']);

      expect(isP2PKH(scriptWithOpReturn)).toBe(false); // Not a pure P2PKH anymore
      expect(hasOpReturnData(scriptWithOpReturn)).toBe(true);
      expect(hasOrd(scriptWithOpReturn)).toBe(false);
      expect(isOrdinal(scriptWithOpReturn)).toBe(false);
    });

    it('should correctly identify Ordinal + P2PKH', () => {
      // BSV-20: OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
      const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
      const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
      const fullHex = ordinalHex + '68656c6c6f' + '68' + p2pkhHex; // + data + OP_ENDIF + P2PKH
      const script = LockingScript.fromHex(fullHex);

      expect(isP2PKH(script)).toBe(false); // Not a pure P2PKH
      expect(hasOrd(script)).toBe(true);
      expect(isOrdinal(script)).toBe(true); // Has both ordinal and P2PKH
      expect(hasOpReturnData(script)).toBe(false);
    });

    it('should handle malformed scripts gracefully', () => {
      // Valid hex strings that don't match the expected patterns should return false (not throw)
      const malformedHex = 'deadbeef'; // Valid hex but not a valid script pattern
      expect(isP2PKH(malformedHex)).toBe(false);
      expect(isOrdinal(malformedHex)).toBe(false);
      expect(hasOrd(malformedHex)).toBe(false);
      expect(hasOpReturnData(malformedHex)).toBe(false);

      // Empty string should not throw
      expect(isP2PKH('')).toBe(false);
      expect(isOrdinal('')).toBe(false);
      expect(hasOrd('')).toBe(false);
      expect(hasOpReturnData('')).toBe(false);
    });
  });

  describe('Runtime validation errors', () => {
    describe('isP2PKH', () => {
      it('should throw error for null input', () => {
        expect(() => isP2PKH(null as any)).toThrow('isP2PKH: Input cannot be null or undefined');
      });

      it('should throw error for undefined input', () => {
        expect(() => isP2PKH(undefined as any)).toThrow('isP2PKH: Input cannot be null or undefined');
      });

      it('should throw error for array input', () => {
        expect(() => isP2PKH([1, 2, 3] as any)).toThrow('isP2PKH: Input cannot be an array');
      });

      it('should throw error for number input', () => {
        expect(() => isP2PKH(123 as any)).toThrow('isP2PKH: Input must be a LockingScript, Script, or hex string, got number');
      });

      it('should throw error for boolean input', () => {
        expect(() => isP2PKH(true as any)).toThrow('isP2PKH: Input must be a LockingScript, Script, or hex string, got boolean');
      });

      it('should throw error for plain object without required methods', () => {
        expect(() => isP2PKH({ foo: 'bar' } as any)).toThrow('isP2PKH: Object must be a LockingScript or Script with toHex() and toASM() methods');
      });

      it('should throw error for invalid hex string (odd length)', () => {
        expect(() => isP2PKH('abc' as any)).toThrow('isP2PKH: Hex string must have even length');
      });

      it('should throw error for non-hex characters', () => {
        expect(() => isP2PKH('gghhii' as any)).toThrow('isP2PKH: String must be a valid hexadecimal string');
      });
    });

    describe('isOrdinal', () => {
      it('should throw error for null input', () => {
        expect(() => isOrdinal(null as any)).toThrow('isOrdinal: Input cannot be null or undefined');
      });

      it('should throw error for array input', () => {
        expect(() => isOrdinal([1, 2, 3] as any)).toThrow('isOrdinal: Input cannot be an array');
      });

      it('should throw error for number input', () => {
        expect(() => isOrdinal(456 as any)).toThrow('isOrdinal: Input must be a LockingScript, Script, or hex string, got number');
      });
    });

    describe('hasOrd', () => {
      it('should throw error for null input', () => {
        expect(() => hasOrd(null as any)).toThrow('hasOrd: Input cannot be null or undefined');
      });

      it('should throw error for array input', () => {
        expect(() => hasOrd(['a', 'b'] as any)).toThrow('hasOrd: Input cannot be an array');
      });

      it('should throw error for object input', () => {
        expect(() => hasOrd({ key: 'value' } as any)).toThrow('hasOrd: Object must be a LockingScript or Script with toHex() and toASM() methods');
      });
    });

    describe('hasOpReturnData', () => {
      it('should throw error for null input', () => {
        expect(() => hasOpReturnData(null as any)).toThrow('hasOpReturnData: Input cannot be null or undefined');
      });

      it('should throw error for undefined input', () => {
        expect(() => hasOpReturnData(undefined as any)).toThrow('hasOpReturnData: Input cannot be null or undefined');
      });

      it('should throw error for array input', () => {
        expect(() => hasOpReturnData([0x6a] as any)).toThrow('hasOpReturnData: Input cannot be an array');
      });

      it('should throw error for number input', () => {
        expect(() => hasOpReturnData(0x6a as any)).toThrow('hasOpReturnData: Input must be a LockingScript, Script, or hex string, got number');
      });
    });
  });

  describe('getScriptType', () => {
    it('should return P2PKH for standard P2PKH script', () => {
      const script = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      expect(getScriptType(script)).toBe('P2PKH');
    });

    it('should return Ordinal for BSV-20 Ordinal + P2PKH script', () => {
      const ordinalHex = '0063036f726451126170706c69636174696f6e2f6273762d323000';
      const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';
      const fullHex = ordinalHex + '68656c6c6f' + '68' + p2pkhHex;

      expect(getScriptType(fullHex)).toBe('Ordinal');
    });

    it('should return OpReturn for pure OP_RETURN script', () => {
      const script = new LockingScript([
        { op: OP.OP_RETURN },
        { op: 5, data: [0x48, 0x65, 0x6c, 0x6c, 0x6f] }
      ]);

      expect(getScriptType(script)).toBe('OpReturn');
    });

    it('should return Custom for unrecognized script types', () => {
      const customHex = 'deadbeef12345678';
      expect(getScriptType(customHex)).toBe('Custom');
    });

    it('should throw error for invalid input', () => {
      expect(() => getScriptType(null as any)).toThrow('getScriptType: Input cannot be null or undefined');
    });
  });

  describe('extractOpReturnData', () => {
    it('should extract OP_RETURN data fields as base64', () => {
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      const scriptWithData = addOpReturnData(baseScript, ['Hello', 'World']);
      const extracted = extractOpReturnData(scriptWithData);

      expect(extracted).not.toBeNull();
      expect(extracted!.length).toBe(2);
      // Decode base64 to UTF-8
      expect(Buffer.from(extracted![0], 'base64').toString('utf8')).toBe('Hello');
      expect(Buffer.from(extracted![1], 'base64').toString('utf8')).toBe('World');
    });

    it('should return null for script without OP_RETURN', () => {
      const script = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      expect(extractOpReturnData(script)).toBeNull();
    });

    it('should extract binary data correctly', () => {
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      // Add binary data (simulating image bytes)
      const binaryData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]); // JPEG header
      const scriptWithData = addOpReturnData(baseScript, [Array.from(binaryData)]);
      const extracted = extractOpReturnData(scriptWithData);

      expect(extracted).not.toBeNull();
      // Decode base64 back to binary
      const decoded = Buffer.from(extracted![0], 'base64');
      expect(Array.from(decoded)).toEqual(Array.from(binaryData));
    });

    it('should throw error for invalid input', () => {
      expect(() => extractOpReturnData(null as any)).toThrow('extractOpReturnData: Input cannot be null or undefined');
    });
  });

  describe('extractMapMetadata', () => {
    it('should extract MAP metadata from ordinal script', () => {
      // Create script with MAP metadata
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      // Build MAP OP_RETURN data
      const mapPrefix = Utils.toArray(ORDINAL_MAP_PREFIX);
      const setCmd = Utils.toArray('SET');
      const appKey = Utils.toArray('app');
      const appValue = Utils.toArray('my-app');
      const typeKey = Utils.toArray('type');
      const typeValue = Utils.toArray('data');

      const scriptWithMap = new LockingScript([
        ...baseScript.chunks,
        { op: OP.OP_RETURN },
        { op: mapPrefix.length, data: mapPrefix },
        { op: setCmd.length, data: setCmd },
        { op: appKey.length, data: appKey },
        { op: appValue.length, data: appValue },
        { op: typeKey.length, data: typeKey },
        { op: typeValue.length, data: typeValue }
      ]);

      const metadata = extractMapMetadata(scriptWithMap);

      expect(metadata).not.toBeNull();
      expect(metadata!.app).toBe('my-app');
      expect(metadata!.type).toBe('data');
    });

    it('should return null for script without MAP data', () => {
      const baseScript = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      const scriptWithData = addOpReturnData(baseScript, ['Hello', 'World']);

      expect(extractMapMetadata(scriptWithData)).toBeNull();
    });

    it('should return null for script without OP_RETURN', () => {
      const script = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      expect(extractMapMetadata(script)).toBeNull();
    });

    it('should throw error for invalid input', () => {
      expect(() => extractMapMetadata(null as any)).toThrow('extractMapMetadata: Input cannot be null or undefined');
    });
  });

  describe('extractInscriptionData', () => {
    it('should extract inscription data from ordinal script', () => {
      // BSV-20 envelope with inscription data
      const ordinalPrefix = '0063036f726451126170706c69636174696f6e2f6273762d323000'; // OP_0 OP_IF 'ord' OP_1 'application/bsv-20' OP_0
      const contentType = Utils.toArray('text/plain');
      const data = Utils.toArray('Hello World');
      const p2pkhHex = '76a914' + 'ab'.repeat(20) + '88ac';

      const fullScript = new LockingScript([
        { op: 0x00 }, // OP_0
        { op: 0x63 }, // OP_IF
        { op: 3, data: Utils.toArray('ord') },
        { op: 0x51 }, // OP_1
        { op: 18, data: Utils.toArray('application/bsv-20') },
        { op: 0x00 }, // OP_0
        { op: contentType.length, data: contentType },
        { op: 0x00 }, // OP_0
        { op: data.length, data: data },
        { op: 0x68 }, // OP_ENDIF
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      const inscription = extractInscriptionData(fullScript);

      expect(inscription).not.toBeNull();
      expect(inscription!.contentType).toBe('text/plain');

      const extractedData = Buffer.from(inscription!.dataB64, 'base64').toString('utf8');
      expect(extractedData).toBe('Hello World');
    });

    it('should return null for non-ordinal script', () => {
      const script = new LockingScript([
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      expect(extractInscriptionData(script)).toBeNull();
    });

    it('should extract inscription data without content type', () => {
      // BSV-20 envelope WITHOUT content type (shorter format)
      const data = Utils.toArray('Hello World');

      const shortScript = new LockingScript([
        { op: 0x00 }, // OP_0
        { op: 0x63 }, // OP_IF
        { op: 3, data: Utils.toArray('ord') },
        { op: 0x51 }, // OP_1
        { op: 18, data: Utils.toArray('application/bsv-20') },
        { op: 0x00 }, // OP_0
        { op: data.length, data: data }, // Data directly (no content type)
        { op: 0x68 }, // OP_ENDIF
        { op: OP.OP_DUP },
        { op: OP.OP_HASH160 },
        { op: 20, data: new Array(20).fill(0xAB) },
        { op: OP.OP_EQUALVERIFY },
        { op: OP.OP_CHECKSIG }
      ]);

      const inscription = extractInscriptionData(shortScript);

      expect(inscription).not.toBeNull();
      expect(inscription!.contentType).toBe('application/octet-stream'); // Default

      const extractedData = Buffer.from(inscription!.dataB64, 'base64').toString('utf8');
      expect(extractedData).toBe('Hello World');
    });

    it('should throw error for malformed ordinal script missing OP_ENDIF', () => {
      // Not enough chunks - missing OP_ENDIF
      const malformed = new LockingScript([
        { op: 0x00 }, // OP_0
        { op: 0x63 }, // OP_IF
        { op: 3, data: Utils.toArray('ord') },
        { op: 0x51 }, // OP_1
        { op: 18, data: Utils.toArray('application/bsv-20') },
        { op: 0x00 }, // OP_0
        // Missing contentType, data, and OP_ENDIF
      ]);

      expect(() => extractInscriptionData(malformed)).toThrow('extractInscriptionData: Malformed ordinal script - missing OP_ENDIF');
    });

    it('should throw error for unexpected OP_ENDIF position', () => {
      // OP_ENDIF in wrong position
      const malformed = new LockingScript([
        { op: 0x00 }, // OP_0
        { op: 0x63 }, // OP_IF
        { op: 3, data: Utils.toArray('ord') },
        { op: 0x51 }, // OP_1
        { op: 18, data: Utils.toArray('application/bsv-20') },
        { op: 0x00 }, // OP_0
        { op: 0x68 }, // OP_ENDIF at position 6 (wrong!)
      ]);

      expect(() => extractInscriptionData(malformed)).toThrow('extractInscriptionData: Unexpected OP_ENDIF position at index 6');
    });

    it('should throw error for invalid input', () => {
      expect(() => extractInscriptionData(null as any)).toThrow('extractInscriptionData: Input cannot be null or undefined');
    });
  });
});
