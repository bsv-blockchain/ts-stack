import { brc38Utf8Chunks } from './Brc38Utf8Chunks'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

async function encode(text: string, width: number, maximumBytes = 1000000): Promise<Uint8Array> {
  const input = new Uint8Array(2 * text.length),
    working = new Brc38WorkingAllocation(1048576)
  for (let i = 0; i < text.length; i++) {
    input[2 * i] = text.charCodeAt(i) & 255
    input[2 * i + 1] = text.charCodeAt(i) >>> 8
  }
  const pieces: Uint8Array[] = []
  try {
    for await (const piece of brc38Utf8Chunks(
      (async function* () {
        for (let offset = 0; offset < input.length; offset += width) yield input.subarray(offset, offset + width)
      })(),
      maximumBytes,
      working
    ))
      pieces.push(piece)
    const output = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
    let offset = 0
    for (const piece of pieces) {
      output.set(piece, offset)
      offset += piece.length
    }
    return output
  } finally {
    input.fill(0)
    pieces.forEach(piece => piece.fill(0))
    expect(working.used).toBe(0)
  }
}

describe('bounded native UTF-8 preparation', () => {
  test.each([1, 2, 3, 7, 65536])('preserves original encoder bytes across %i-byte boundaries', async width => {
    const text = '\ufeffAé水😀\ud800x\udfff' + 'a'.repeat(65535) + '😀終'
    expect(await encode(text, width)).toEqual(new TextEncoder().encode(text))
  })
  test('charges the converted length and drains an over-budget conversion', async () => {
    await expect(encode('水', 1, 2)).rejects.toThrow('original byte ceiling')
    expect(await encode('', 1, 0)).toEqual(new Uint8Array())
  })
  test('rejects a truncated code unit and releases the original owner', async () => {
    const working = new Brc38WorkingAllocation(1048576)
    await expect(
      (async () => {
        for await (const piece of brc38Utf8Chunks(
          (async function* () {
            yield Uint8Array.of(65)
          })(),
          8,
          working
        ))
          piece.fill(0)
      })()
    ).rejects.toThrow('inside a code unit')
    expect(working.used).toBe(0)
  })
})
