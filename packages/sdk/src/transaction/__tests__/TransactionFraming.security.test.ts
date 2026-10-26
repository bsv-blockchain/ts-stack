import { Script } from '../../script/index.js'
import { Beef } from '../Beef.js'
import Transaction from '../Transaction.js'

describe('strict transaction framing', () => {
  const transaction = new Transaction(
    1,
    [],
    [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
    0
  )
  const bytes = transaction.toUint8Array()

  it('accepts an exact canonical transaction in binary and hexadecimal form', () => {
    expect(Transaction.fromBinary(bytes).id('hex')).toBe(transaction.id('hex'))
    expect(Transaction.fromBinaryView(bytes).id('hex')).toBe(transaction.id('hex'))
    expect(Transaction.fromHex(transaction.toHex()).id('hex')).toBe(transaction.id('hex'))
  })

  it('rejects every truncated prefix instead of manufacturing zero fields', () => {
    for (let length = 0; length < bytes.length; length++) {
      expect(() => Transaction.fromBinary(bytes.slice(0, length))).toThrow()
      expect(() => Transaction.fromBinaryView(bytes.slice(0, length))).toThrow()
      expect(() => Transaction.parseScriptOffsets(bytes.slice(0, length))).toThrow()
    }
    expect(() => Transaction.fromHex('00')).toThrow()
  })

  it('rejects trailing bytes and non-canonical CompactSize counts', () => {
    expect(() => Transaction.fromBinaryView(Uint8Array.from([...bytes, 0]))).toThrow(
      'trailing data'
    )
    expect(() => Transaction.fromBinary([...bytes, 0])).toThrow('trailing data')
    expect(() => Transaction.parseScriptOffsets([...bytes, 0])).toThrow('trailing data')
    expect(() => Transaction.fromHex('01000000fdfc00')).toThrow('non-canonical varInt')
    expect(() => Transaction.fromHex('01000000feffff0000')).toThrow('non-canonical varInt')
    expect(() => Transaction.fromHex('01000000ff0000000000002000')).toThrow(
      'number too large to retain precision'
    )
  })

  it('requires exact framing for EF and security-boundary BEEF parsing', () => {
    const ef = transaction.toEF()
    expect(Transaction.fromEF(ef).id('hex')).toBe(transaction.id('hex'))
    expect(() => Transaction.fromEF([...ef, 0])).toThrow('trailing data')

    const beefBytes = transaction.toBEEFBytes()
    expect(Beef.fromBinaryStrict(beefBytes).txs).toHaveLength(1)
    expect(() => Beef.fromBinaryStrict([...beefBytes, 0])).toThrow('trailing data')
    expect(() => Transaction.fromBEEF([...beefBytes, 0])).toThrow('trailing data')

    // The historical low-level prefix parser remains available for stream
    // consumers; trust-boundary callers are migrated to fromBinaryStrict.
    expect(Beef.fromBinary([...beefBytes, 0]).txs).toHaveLength(1)
  })

  it('bounds EF source-output allocations before creating the sparse source transaction', () => {
    const source = new Transaction(
      1,
      [],
      [{ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') }],
      0
    )
    const spending = new Transaction()
    spending.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    const ef = spending.toEF()
    const sourceOutputIndexOffset = 4 + 6 + 1 + 32
    ef.splice(sourceOutputIndexOffset, 4, 0xff, 0xff, 0xff, 0xff)

    expect(() => Transaction.fromEF(ef)).toThrow('source output index exceeds the allocation limit')
  })
})
