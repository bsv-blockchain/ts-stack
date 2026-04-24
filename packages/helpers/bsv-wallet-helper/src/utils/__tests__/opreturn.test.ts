import { LockingScript, Utils, OP } from '@bsv/sdk';
import { addOpReturnData } from '../opreturn';

const toHex = (str: string) => Utils.toHex(Utils.toArray(str));

describe('addOpReturnData', () => {
  let baseLockingScript: LockingScript;

  beforeEach(() => {
    // Create a simple P2PKH-like script for testing
    baseLockingScript = new LockingScript([
      { op: OP.OP_DUP },
      { op: OP.OP_HASH160 },
      { op: 20, data: new Array(20).fill(0) },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    ]);
  });

  describe('UTF-8 string support', () => {
    it('should auto-convert plain text strings to hex', () => {
      const result = addOpReturnData(baseLockingScript, ['Hello, World!']);

      const asm = result.toASM();
      const expectedHex = toHex('Hello, World!');
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(expectedHex);
    });

    it('should handle multiple plain text strings', () => {
      const result = addOpReturnData(baseLockingScript, ['field1', 'field2', 'field3']);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex('field1'));
      expect(asm).toContain(toHex('field2'));
      expect(asm).toContain(toHex('field3'));
    });

    it('should work with MAP protocol using plain text', () => {
      const result = addOpReturnData(baseLockingScript, [
        '1SAT_P2PKH',
        'SET',
        'app',
        'myapp',
        'type',
        'data'
      ]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex('1SAT_P2PKH'));
      expect(asm).toContain(toHex('SET'));
      expect(asm).toContain(toHex('app'));
      expect(asm).toContain(toHex('myapp'));
    });
  });

  describe('Hex string support', () => {
    it('should detect and preserve hex strings without double conversion', () => {
      const hexString = 'deadbeef';
      const result = addOpReturnData(baseLockingScript, [hexString]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(hexString);
      // Should NOT contain double-encoded version
      expect(asm).not.toContain(toHex(hexString));
    });

    it('should work with raw hex data (like a hash)', () => {
      const hash = 'a'.repeat(64); // 32-byte hash in hex
      const result = addOpReturnData(baseLockingScript, [hash]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(hash);
    });

    it('should normalize uppercase hex to lowercase', () => {
      const lowerHex = 'abcdef123456';
      const upperHex = 'ABCDEF123456';

      const result1 = addOpReturnData(baseLockingScript, [lowerHex]);
      const result2 = addOpReturnData(baseLockingScript, [upperHex]);

      expect(result1.toASM()).toContain('OP_RETURN');
      expect(result1.toASM()).toContain(lowerHex);
      expect(result2.toASM()).toContain('OP_RETURN');
      // Uppercase hex should be normalized to lowercase
      expect(result2.toASM()).toContain(upperHex.toLowerCase());
    });

    it('should reject odd-length hex strings and treat as UTF-8', () => {
      // Odd-length strings are not valid hex, should be treated as UTF-8
      const oddHex = 'abc'; // 3 chars, not valid hex
      const result = addOpReturnData(baseLockingScript, [oddHex]);

      const asm = result.toASM();
      // Should be converted as UTF-8 text
      expect(asm).toContain(toHex('abc'));
    });
  });

  describe('Byte array support', () => {
    it('should convert byte arrays to hex', () => {
      const bytes = [0x01, 0x02, 0x03, 0xFF];
      const result = addOpReturnData(baseLockingScript, [bytes]);

      const asm = result.toASM();
      const expectedHex = Utils.toHex(bytes);
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(expectedHex);
    });

    it('should handle multiple byte arrays', () => {
      const bytes1 = [0xDE, 0xAD];
      const bytes2 = [0xBE, 0xEF];

      const result = addOpReturnData(baseLockingScript, [bytes1, bytes2]);

      const asm = result.toASM();
      expect(asm).toContain(Utils.toHex(bytes1));
      expect(asm).toContain(Utils.toHex(bytes2));
    });
  });

  describe('JSON string support', () => {
    it('should handle JSON stringified objects', () => {
      const metadata = { name: 'Alice', age: 30, active: true };
      const jsonString = JSON.stringify(metadata);

      const result = addOpReturnData(baseLockingScript, [jsonString]);

      const asm = result.toASM();
      const expectedHex = toHex(jsonString);
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(expectedHex);
    });

    it('should handle complex nested JSON', () => {
      const complexData = {
        user: { name: 'Bob', id: 123 },
        items: ['a', 'b', 'c'],
        metadata: { timestamp: 1234567890 }
      };
      const jsonString = JSON.stringify(complexData);

      const result = addOpReturnData(baseLockingScript, [jsonString]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex(jsonString));
    });

    it('should handle JSON with a prefix identifier', () => {
      const appData = { action: 'transfer', amount: 100 };
      const result = addOpReturnData(baseLockingScript, [
        'MY_APP',
        JSON.stringify(appData)
      ]);

      const asm = result.toASM();
      expect(asm).toContain(toHex('MY_APP'));
      expect(asm).toContain(toHex(JSON.stringify(appData)));
    });
  });

  describe('Mixed type support', () => {
    it('should handle mix of plain text, hex, and byte arrays', () => {
      const result = addOpReturnData(baseLockingScript, [
        'Hello',              // Plain text
        'deadbeef',           // Hex string
        [0x01, 0x02, 0x03]    // Byte array
      ]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex('Hello'));
      expect(asm).toContain('deadbeef'); // Preserved as hex
      expect(asm).toContain(Utils.toHex([0x01, 0x02, 0x03]));
    });
  });

  describe('Edge cases', () => {
    it('should handle empty strings', () => {
      const result = addOpReturnData(baseLockingScript, ['']);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
    });

    it('should preserve the original locking script', () => {
      const originalAsm = baseLockingScript.toASM();
      const result = addOpReturnData(baseLockingScript, ['test']);

      const resultAsm = result.toASM();
      expect(resultAsm).toContain(originalAsm);
      expect(resultAsm).toContain('OP_RETURN');
    });

    it('should handle special characters in text', () => {
      const specialText = '!@#$%^&*()_+-=[]{}|;:,.<>?';
      const result = addOpReturnData(baseLockingScript, [specialText]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex(specialText));
    });

    it('should handle unicode characters', () => {
      const unicode = '你好世界 🌍';
      const result = addOpReturnData(baseLockingScript, [unicode]);

      const asm = result.toASM();
      expect(asm).toContain('OP_RETURN');
      expect(asm).toContain(toHex(unicode));
    });
  });

  describe('Runtime validation errors', () => {
    it('should throw error when script is invalid', () => {
      expect(() => addOpReturnData(null as any, ['test'])).toThrow(
        'Invalid script parameter: must be a LockingScript instance'
      );

      expect(() => addOpReturnData({} as any, ['test'])).toThrow(
        'Invalid script parameter: must be a LockingScript instance'
      );

      expect(() => addOpReturnData('not a script' as any, ['test'])).toThrow(
        'Invalid script parameter: must be a LockingScript instance'
      );
    });

    it('should throw error when script already contains OP_RETURN', () => {
      // First call should succeed
      const scriptWithOpReturn = addOpReturnData(baseLockingScript, ['first', 'data']);

      // Second call on the same script should fail
      expect(() => addOpReturnData(scriptWithOpReturn, ['second', 'data'])).toThrow(
        'Script already contains OP_RETURN. Cannot add multiple OP_RETURN statements to the same script.'
      );
    });

    it('should throw error when fields is not an array', () => {
      expect(() => addOpReturnData(baseLockingScript, 'not an array' as any)).toThrow(
        'Invalid fields parameter: must be an array of strings or number arrays'
      );

      expect(() => addOpReturnData(baseLockingScript, { field: 'value' } as any)).toThrow(
        'Invalid fields parameter: must be an array of strings or number arrays'
      );

      expect(() => addOpReturnData(baseLockingScript, 123 as any)).toThrow(
        'Invalid fields parameter: must be an array of strings or number arrays'
      );
    });

    it('should throw error when fields array is empty', () => {
      expect(() => addOpReturnData(baseLockingScript, [])).toThrow(
        'At least one data field is required for OP_RETURN'
      );
    });

    it('should throw error when field has invalid type', () => {
      expect(() => addOpReturnData(baseLockingScript, [123] as any)).toThrow(
        'Invalid field at index 0: must be a string or number array, got number'
      );

      expect(() => addOpReturnData(baseLockingScript, [{ key: 'value' }] as any)).toThrow(
        'Invalid field at index 0: must be a string or number array, got object'
      );

      expect(() => addOpReturnData(baseLockingScript, [true] as any)).toThrow(
        'Invalid field at index 0: must be a string or number array, got boolean'
      );
    });

    it('should throw error when field in middle of array is invalid', () => {
      expect(() => addOpReturnData(baseLockingScript, ['valid', 123, 'also valid'] as any)).toThrow(
        'Invalid field at index 1: must be a string or number array, got number'
      );
    });

    it('should throw error when number array contains non-numbers', () => {
      expect(() => addOpReturnData(baseLockingScript, [[0x01, 'not a number', 0x03]] as any)).toThrow(
        'Invalid field at index 0: array contains non-number'
      );
    });

    it('should validate large arrays efficiently with sampling', () => {
      // Create a large array with a non-number in the middle
      const largeArray = new Array(10000).fill(0xFF);
      largeArray[5000] = 'not a number' as any;

      // Should still catch the error through sampling
      expect(() => addOpReturnData(baseLockingScript, [largeArray])).toThrow(
        'Invalid field at index 0: array contains non-number'
      );
    });
  });
});
