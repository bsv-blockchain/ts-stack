import { walletJsonReplacer, normalizeJsonMangledBytes } from '../utils/jsonByteEncoding'

describe('walletJsonReplacer', () => {
  it('serializes Uint8Array values as JSON arrays', () => {
    const args = { inputBEEF: new Uint8Array([1, 1, 1, 1, 42]), description: 'x' }
    expect(JSON.parse(JSON.stringify(args, walletJsonReplacer))).toEqual({
      inputBEEF: [1, 1, 1, 1, 42],
      description: 'x'
    })
  })

  it('leaves non-binary values unchanged', () => {
    const args = { outputs: [{ satoshis: 1, lockingScript: '00' }], lockTime: 0 }
    expect(JSON.parse(JSON.stringify(args, walletJsonReplacer))).toEqual(args)
  })
})

describe('normalizeJsonMangledBytes', () => {
  const mangled = (bytes: number[]): Record<string, number> =>
    JSON.parse(JSON.stringify(new Uint8Array(bytes)))

  it('repairs a numeric-keyed tx object into number[]', () => {
    const result = { txid: 'abc', tx: mangled([1, 1, 1, 1, 128, 7]) }
    expect(normalizeJsonMangledBytes(result).tx).toEqual([1, 1, 1, 1, 128, 7])
  })

  it('repairs nested byte fields (signableTransaction.tx)', () => {
    const result = { signableTransaction: { reference: 'r', tx: mangled([9, 8, 7]) } }
    expect(normalizeJsonMangledBytes(result).signableTransaction.tx).toEqual([9, 8, 7])
  })

  it('repairs byte fields inside arrays of results', () => {
    const result = { actions: [{ txid: 'a', rawTx: mangled([5, 5]) }, { txid: 'b', rawTx: [6] }] }
    normalizeJsonMangledBytes(result)
    expect(result.actions[0].rawTx).toEqual([5, 5])
    expect(result.actions[1].rawTx).toEqual([6])
  })

  it('repairs signature, BEEF, ciphertext, plaintext and hmac fields', () => {
    const result = {
      signature: mangled([48, 68]),
      BEEF: mangled([2, 0, 190, 239]),
      ciphertext: mangled([1]),
      plaintext: mangled([2]),
      hmac: mangled([3])
    }
    normalizeJsonMangledBytes(result)
    expect(result).toEqual({
      signature: [48, 68],
      BEEF: [2, 0, 190, 239],
      ciphertext: [1],
      plaintext: [2],
      hmac: [3]
    })
  })

  it('leaves healthy number[] byte fields untouched (same reference)', () => {
    const tx = [1, 1, 1, 1, 42]
    const result = { txid: 'abc', tx }
    expect(normalizeJsonMangledBytes(result).tx).toBe(tx)
  })

  it('never rewrites structured objects, even under byte field names', () => {
    const oddTx = { version: 1, hex: '00' }
    const result = { tx: oddTx, signableTransaction: { reference: 'r' } }
    expect(normalizeJsonMangledBytes(result).tx).toBe(oddTx)
  })

  it('ignores non-contiguous or non-numeric numeric-keyed objects', () => {
    const sparse = { 0: 1, 2: 3 }
    const stringy = { 0: 'a', 1: 'b' }
    const result = { tx: sparse, signature: stringy }
    normalizeJsonMangledBytes(result)
    expect(result.tx).toBe(sparse)
    expect(result.signature).toBe(stringy)
  })

  it('passes through primitives and null safely', () => {
    expect(normalizeJsonMangledBytes(null)).toBeNull()
    expect(normalizeJsonMangledBytes(undefined)).toBeUndefined()
    expect(normalizeJsonMangledBytes('x')).toBe('x')
    expect(normalizeJsonMangledBytes(7)).toBe(7)
  })
})
