import SatoshisPerKilobyte from '../SatoshisPerKilobyte'
import Transaction from '../../Transaction'
import Script from '../../../script/Script'

/**
 * Tests for SatoshisPerKilobyte fee model.
 *
 * SatoshisPerKilobyte.computeFee() calculates transaction size from:
 *   - 4 bytes  version
 *   - varint   number of inputs
 *   - per input: 40 bytes (fixed) + varint script length + script bytes
 *   - varint   number of outputs
 *   - per output: 8 bytes (satoshis) + varint script length + script bytes
 *   - 4 bytes  lock time
 *
 * Fee = ceil(size / 1000 * value)
 *
 * The unlocking-script source can be:
 *   a) an actual UnlockingScript object (.unlockingScript present)
 *   b) a template (.unlockingScriptTemplate present with .estimateLength())
 *   c) neither → throws
 *
 * getVarIntSize thresholds:
 *   - <= 253      → 1 byte
 *   - 254..65535  → 3 bytes  (> 253)
 *   - 65536..2^32 → 5 bytes  (> 2^16)
 *   - > 2^32      → 9 bytes
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the simplest possible mock input with an already-compiled unlocking script. */
function makeScriptInput(scriptBytes: number[]): any {
  return {
    unlockingScript: Script.fromBinary(scriptBytes),
    unlockingScriptTemplate: undefined
  }
}

/** Build an input that uses an unlockingScriptTemplate instead. */
function makeTemplateInput(estimatedLength: number): any {
  return {
    unlockingScript: undefined,
    unlockingScriptTemplate: {
      estimateLength: jest.fn().mockResolvedValue(estimatedLength)
    }
  }
}

/** Build a simple output with a locking script of the given byte length. */
function makeOutput(scriptBytes: number[], satoshis = 1000): any {
  return {
    lockingScript: Script.fromBinary(scriptBytes),
    satoshis
  }
}

/** Create a minimal Transaction-like object with the given inputs and outputs. */
function makeTx(inputs: any[], outputs: any[]): Transaction {
  const tx = new Transaction()
  tx.inputs = inputs
  tx.outputs = outputs
  return tx
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SatoshisPerKilobyte', () => {
  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it.each([50, 0, 0.5])('stores an accepted value of %s', value => {
      expect(new SatoshisPerKilobyte(value).value).toBe(value)
    })
  })

  // -------------------------------------------------------------------------
  // computeFee – happy path
  // -------------------------------------------------------------------------
  describe('computeFee', () => {
    it.each([
      { rate: 0, expected: 0, scenario: 'zero rate' },
      { rate: 1, expected: 1, scenario: 'fractional fee rounded up' },
      { rate: 1000, expected: 10, scenario: 'one satoshi per byte' }
    ])('computes the empty-transaction fee for $scenario', async ({ rate, expected }) => {
      const model = new SatoshisPerKilobyte(rate)
      const tx = makeTx([], [])
      // Empty size = 4-byte version + two 1-byte counts + 4-byte lock time.
      expect(await model.computeFee(tx)).toBe(expected)
    })

    it('computes fee for one input with an unlocking script', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const scriptData = Array.from({ length: 107 }).fill(0x00) // P2PKH-ish unlock ~107 bytes
      const tx = makeTx([makeScriptInput(scriptData)], [])
      // size = 4 (ver) + 1 (input count) + [40 + 1 (script varint) + 107 (script)] + 1 (output count) + 4 (locktime)
      //      = 4 + 1 + 148 + 1 + 4 = 158 bytes
      const fee = await model.computeFee(tx)
      expect(fee).toBe(Math.ceil((158 / 1000) * 1000))
    })

    it('uses unlockingScriptTemplate.estimateLength when no script is compiled', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const templateInput = makeTemplateInput(107)
      const tx = makeTx([templateInput], [])
      const fee = await model.computeFee(tx)
      expect(templateInput.unlockingScriptTemplate.estimateLength).toHaveBeenCalledTimes(1)
      expect(fee).toBe(Math.ceil((158 / 1000) * 1000))
    })

    it('computes fee including outputs', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const lockScript = Array.from({ length: 25 }).fill(0x00) // P2PKH locking script = 25 bytes
      const tx = makeTx([], [makeOutput(lockScript)])
      // size = 4 + 1 + 1 + [8 + 1 + 25] + 4 = 44 bytes
      const fee = await model.computeFee(tx)
      expect(fee).toBe(Math.ceil((44 / 1000) * 1000))
    })

    it('computes fee for one input and one output', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const unlockScript = Array.from({ length: 107 }).fill(0x00)
      const lockScript = Array.from({ length: 25 }).fill(0x00)
      const tx = makeTx([makeScriptInput(unlockScript)], [makeOutput(lockScript)])
      // size = 4 + 1 + (40 + 1 + 107) + 1 + (8 + 1 + 25) + 4
      //      = 4 + 1 + 148 + 1 + 34 + 4 = 192 bytes
      const fee = await model.computeFee(tx)
      expect(fee).toBe(Math.ceil((192 / 1000) * 1000))
    })

    it('fee scales proportionally with sat/kb rate', async () => {
      const tx = makeTx([], [])
      const fee100 = await new SatoshisPerKilobyte(100).computeFee(tx)
      const fee200 = await new SatoshisPerKilobyte(200).computeFee(tx)
      expect(fee200).toBeGreaterThanOrEqual(fee100)
    })

    it('throws when input has neither unlockingScript nor unlockingScriptTemplate', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const badInput: any = {} // no unlockingScript, no unlockingScriptTemplate
      const tx = makeTx([badInput], [])
      await expect(model.computeFee(tx)).rejects.toThrow(
        'All inputs must have an unlocking script or an unlocking script template for sat/kb fee computation.'
      )
    })
  })

  // -------------------------------------------------------------------------
  // getVarIntSize thresholds (tested indirectly through computeFee)
  // -------------------------------------------------------------------------
  describe('getVarIntSize thresholds', () => {
    it('uses 1-byte varint for script length <= 253', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const script253 = Array.from({ length: 253 }).fill(0x00)
      const tx = makeTx([makeScriptInput(script253)], [])
      const fee = await model.computeFee(tx)
      // script len 253 ≤ 253, so varint is 1 byte
      // size = 4 + 1 + 40 + 1 + 253 + 1 + 4 = 304
      expect(fee).toBe(Math.ceil((304 / 1000) * 1000))
    })

    it('uses 3-byte varint for script length 254 (> 253)', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const script254 = Array.from({ length: 254 }).fill(0x00)
      const tx = makeTx([makeScriptInput(script254)], [])
      const fee = await model.computeFee(tx)
      // script len 254 > 253, so varint is 3 bytes
      // size = 4 + 1 + 40 + 3 + 254 + 1 + 4 = 307
      expect(fee).toBe(Math.ceil((307 / 1000) * 1000))
    })

    it('uses 5-byte varint for script length > 2^16', async () => {
      const model = new SatoshisPerKilobyte(1000)
      // The condition in getVarIntSize is `i > 2**16` (i.e. strictly greater than 65536).
      // A script of 65537 bytes is the smallest value that triggers the 5-byte varint path.
      const bigScript = Array.from({ length: 65537 }).fill(0x00)
      const tx = makeTx([makeScriptInput(bigScript)], [])
      const fee = await model.computeFee(tx)
      // varint = 5 bytes (65537 > 2^16)
      // size = 4 + 1 (input count) + 40 + 5 (script len varint) + 65537 + 1 (output count) + 4 = 65592
      expect(fee).toBe(Math.ceil((65592 / 1000) * 1000))
    })

    it('uses multiple inputs and outputs correctly', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const unlockScript = Array.from({ length: 107 }).fill(0x00)
      const lockScript = Array.from({ length: 25 }).fill(0x00)
      const inputs = [
        makeScriptInput(unlockScript),
        makeScriptInput(unlockScript),
        makeScriptInput(unlockScript)
      ]
      const outputs = [makeOutput(lockScript), makeOutput(lockScript)]
      const tx = makeTx(inputs, outputs)

      const fee = await model.computeFee(tx)
      // size = 4 + 1 + 3*(40+1+107) + 1 + 2*(8+1+25) + 4
      //      = 4 + 1 + 444 + 1 + 68 + 4 = 522
      expect(fee).toBe(Math.ceil((522 / 1000) * 1000))
    })
  })

  // -------------------------------------------------------------------------
  // Template vs. compiled script
  // -------------------------------------------------------------------------
  describe('unlockingScriptTemplate path', () => {
    it('calls estimateLength with (tx, inputIndex)', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const templateInput = makeTemplateInput(50)
      const tx = makeTx([templateInput], [])
      await model.computeFee(tx)
      expect(templateInput.unlockingScriptTemplate.estimateLength).toHaveBeenCalledWith(tx, 0)
    })

    it('correctly handles multiple template inputs, each with different estimated lengths', async () => {
      const model = new SatoshisPerKilobyte(1000)
      const input0 = makeTemplateInput(107)
      const input1 = makeTemplateInput(50)
      const tx = makeTx([input0, input1], [])
      const fee = await model.computeFee(tx)
      // size = 4 + 1 + (40+1+107) + (40+1+50) + 1 + 4 = 249
      expect(fee).toBe(Math.ceil((249 / 1000) * 1000))
      expect(input0.unlockingScriptTemplate.estimateLength).toHaveBeenCalledWith(tx, 0)
      expect(input1.unlockingScriptTemplate.estimateLength).toHaveBeenCalledWith(tx, 1)
    })
  })
})
