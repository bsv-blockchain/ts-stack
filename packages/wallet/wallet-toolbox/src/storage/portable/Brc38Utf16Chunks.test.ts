import { brc38Utf16Chunks } from './Brc38Utf16Chunks'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

// Authored UNRUN. Native Buffer is an independent encoding oracle for this
// pure converter; these cases do not qualify browser source/storage ownership.
async function encode(text: string, inputWidth: number, maximum?: number) {
  const input = new TextEncoder().encode(text),
    working = new Brc38WorkingAllocation(1048576),
    outputs: Uint8Array[] = []
  async function* source() {
    for (let offset = 0; offset < input.length; offset += inputWidth) yield input.slice(offset, offset + inputWidth)
  }
  try {
    for await (const bytes of brc38Utf16Chunks(source(), maximum ?? Buffer.byteLength(text, 'utf16le'), working)) {
      expect(bytes.length).toBeLessThanOrEqual(65536)
      expect(bytes.length % 2).toBe(0)
      outputs.push(bytes.slice())
      bytes.fill(0)
    }
    return Buffer.concat(outputs)
  } finally {
    expect(working.used).toBe(0)
  }
}
describe('bounded UTF-16 storage windows (authored UNRUN)', () => {
  test.each([
    ['empty', ''],
    ['ASCII and NUL', 'ASCII\u0000'],
    ['BMP', '雪é€'],
    ['astral', '😀雪😀'],
    ['BOM', '\ufeffpreserved'],
    ['fixed window boundary', 'x'.repeat(32767) + '😀' + 'y'.repeat(32768)]
  ])('independently matches scalar splits: %s', async (_name, text) => {
    for (const width of [1, 3, 64, 65536]) expect(await encode(text, width)).toEqual(Buffer.from(text, 'utf16le'))
  })
  test('refuses a short original output ceiling and releases its own scopes', async () => {
    await expect(encode('雪😀', 1, 4)).rejects.toThrow('original byte ceiling')
  })
  test('refuses malformed/incomplete UTF-8 before successful EOF', async () => {
    const working = new Brc38WorkingAllocation(1048576)
    async function* malformed() {
      yield Uint8Array.of(0xe2, 0x82)
    }
    const run = async () => {
      for await (const bytes of brc38Utf16Chunks(malformed(), 32, working)) bytes.fill(0)
    }
    await expect(run()).rejects.toThrow()
    expect(working.used).toBe(0)
  })
  test('a bounded producer is returned on early consumer stop', async () => {
    const working = new Brc38WorkingAllocation(1048576)
    let returned = false
    async function* source() {
      try {
        yield new TextEncoder().encode('x'.repeat(65536))
        throw new Error('Unexpected next source read')
      } finally {
        returned = true
      }
    }
    for await (const bytes of brc38Utf16Chunks(source(), 131072, working)) {
      bytes.fill(0)
      break
    }
    expect(returned).toBe(true)
    expect(working.used).toBe(0)
  })
  test('resource refusal precedes starting source work', async () => {
    const working = new Brc38WorkingAllocation(8192)
    let read = false
    async function* source() {
      read = true
      yield Uint8Array.of(65)
    }
    const run = async () => {
      for await (const bytes of brc38Utf16Chunks(source(), 2, working)) bytes.fill(0)
    }
    await expect(run()).rejects.toThrow()
    expect(read).toBe(false)
    expect(working.used).toBe(0)
  })
})
