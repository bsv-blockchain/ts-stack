import { createHash } from 'node:crypto'
import { Transaction } from '@bsv/sdk'
import { inspectBrc38RawTransactionStream } from './Brc38RawTransactionStream'

function u32(value: number): Buffer {
  const result = Buffer.alloc(4)
  result.writeUInt32LE(value)
  return result
}
function compact(value: number): Buffer {
  if (value < 253) return Buffer.from([value])
  if (value <= 65535) {
    const result = Buffer.alloc(3)
    result[0] = 253
    result.writeUInt16LE(value, 1)
    return result
  }
  return Buffer.concat([Buffer.from([254]), u32(value)])
}
function raw(script = Buffer.from([0x4c]), amount = 1n): Buffer {
  const satoshis = Buffer.alloc(8)
  satoshis.writeBigUInt64LE(amount)
  // Independent byte writer; the SDK supplies the independent parser/TXID
  // oracle, including its lazy opaque script semantics and safe amount bound.
  return Buffer.concat([
    u32(2),
    Buffer.from([1]),
    Buffer.alloc(32),
    u32(0),
    Buffer.from([0]),
    u32(0xffffffff),
    Buffer.from([1]),
    satoshis,
    compact(script.byteLength),
    script,
    u32(3)
  ])
}
async function* chunks(value: Uint8Array, width: number) {
  for (let offset = 0; offset < value.byteLength; offset += width) yield value.slice(offset, offset + width)
}
function policy(value: Uint8Array) {
  return {
    bytes: value.byteLength,
    sha256: createHash('sha256').update(value).digest('hex'),
    maximumBytes: 1048576,
    maximumChunks: 10000,
    expiresAt: Date.now() + 10000
  }
}
test.each([1, 2, 7, 64, 65536])('raw framing and TXID match the independent SDK through width%i', async width => {
  const value = raw(),
    sdk = Transaction.fromBinary(value)
  const actual = await inspectBrc38RawTransactionStream(chunks(value, width), policy(value))
  expect(actual).toMatchObject({
    version: sdk.version,
    lockTime: sdk.lockTime,
    inputs: sdk.inputs.length,
    outputs: sdk.outputs.length,
    txid: sdk.id('hex'),
    bytes: value.byteLength
  })
})
test.each([252, 253, 65535, 65536, 131073])(
  'large opaque script%i uses bounded extents and preserves SDK framing',
  async size => {
    const value = raw(Buffer.alloc(size, 76)),
      sdk = Transaction.fromBinary(value)
    const result = await inspectBrc38RawTransactionStream(chunks(value, 65536), policy(value))
    expect(result.txid).toBe(sdk.id('hex'))
    expect(result.outputs).toBe(1)
  }
)
test('empty transaction and maximum safe output amount retain the SDK accepted boundaries', async () => {
  for (const value of [Buffer.concat([u32(0), Buffer.from([0, 0]), u32(0)]), raw(Buffer.alloc(0), 9007199254740991n)]) {
    expect((await inspectBrc38RawTransactionStream(chunks(value, 7), policy(value))).txid).toBe(
      Transaction.fromBinary(value).id('hex')
    )
  }
})
test.each([
  Buffer.concat([u32(1), Buffer.from([253, 1, 0]), Buffer.alloc(50)]),
  raw().subarray(0, raw().byteLength - 1),
  Buffer.concat([raw(), Buffer.from([0])]),
  raw(Buffer.alloc(0), 9007199254740992n),
  Buffer.concat([u32(1), Buffer.from([254]), u32(0xffffffff), Buffer.alloc(10)])
])(
  'malformed CompactSize/count/amount/truncation/trailing bytes preserve independent SDK refusal (%#)',
  async value => {
    expect(() => Transaction.fromBinary(value)).toThrow()
    await expect(inspectBrc38RawTransactionStream(chunks(value, 7), policy(value))).rejects.toThrow()
  }
)
test('wrong digest, excess source extent and chunk policy cannot produce a content summary', async () => {
  const value = raw()
  await expect(
    inspectBrc38RawTransactionStream(chunks(value, 7), { ...policy(value), sha256: '0'.repeat(64) })
  ).rejects.toThrow()
  await expect(
    inspectBrc38RawTransactionStream(chunks(value, 7), { ...policy(value), maximumChunks: 1 })
  ).rejects.toThrow('chunk policy')
  await expect(
    inspectBrc38RawTransactionStream(chunks(value, 65536), { ...policy(value), bytes: value.byteLength - 1 })
  ).rejects.toThrow()
})
test('cancellation waits for pending source I/O and preserves independent iterator cleanup failure', async () => {
  const value = raw(),
    controller = new AbortController(),
    reason = new Error('synthetic raw cancellation'),
    cleanup = new Error('synthetic source drain refusal')
  let release!: (value: IteratorResult<Uint8Array>) => void,
    requested = false,
    returned = false
  const pending = new Promise<IteratorResult<Uint8Array>>(resolve => {
    release = resolve
  })
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        requested = true
        return pending
      },
      return: async () => {
        returned = true
        throw cleanup
      }
    })
  }
  const operation = inspectBrc38RawTransactionStream(source, { ...policy(value), signal: controller.signal })
  let settled = false
  void operation.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(requested).toBe(true)
  controller.abort(reason)
  await Promise.resolve()
  expect(settled).toBe(false)
  release({ done: false, value })
  const error = await operation.then(
    () => undefined,
    failure => failure
  )
  expect(error).toBeInstanceOf(AggregateError)
  expect(error.errors).toEqual([reason, cleanup])
  expect(returned).toBe(true)
})
