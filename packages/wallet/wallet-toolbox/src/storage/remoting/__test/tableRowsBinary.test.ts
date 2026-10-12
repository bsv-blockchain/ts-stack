import { tableRowsBinary } from '../syncChunkBinary'
import { parseJsonRpc, stringifyJsonRpc } from '../BinaryJson'

describe('schema-defined row bytes', () => {
  test('copies large declared byte fields without mutating rows or tagging unrelated numbers', () => {
    const bytes = Array.from({ length: 128 }, (_, i) => i)
    const row = { rawTx: bytes, inputBEEF: bytes, extraNumbers: bytes }
    const result = tableRowsBinary('provenTxReqs', [row])
    const wire = JSON.parse(stringifyJsonRpc(result, true))
    expect(wire[0].rawTx.$bsvBinary).toBe('base64')
    expect(wire[0].inputBEEF.$bsvBinary).toBe('base64')
    expect(wire[0].extraNumbers).toEqual(bytes)
    expect(Array.from(parseJsonRpc(JSON.stringify(wire), true)[0].rawTx)).toEqual(bytes)
    expect(row.rawTx).toBe(bytes)
    expect(result[0]).not.toBe(row)
  })

  test.each([undefined, new Uint8Array(128), [1, 2], Array(128).fill(-1), Array(128).fill(256), Array(128).fill(1.5)])(
    'preserves absent, typed, small or invalid declared bytes: %p',
    value => {
      const row = { lockingScript: value }
      expect(tableRowsBinary('outputs', [row])[0].lockingScript).toBe(value)
      expect(row.lockingScript).toBe(value)
    }
  )
})
