import { normalizeWalletJsonTx, walletJsonReplacer } from '../utils/jsonByteEncoding'

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

describe('normalizeWalletJsonTx', () => {
  const mangled = (bytes: number[]): Record<string, number> =>
    JSON.parse(JSON.stringify(new Uint8Array(bytes)))

  it('repairs a numeric-keyed tx object into number[]', () => {
    const result = { txid: 'abc', tx: mangled([1, 1, 1, 1, 128, 7]) }
    expect(normalizeWalletJsonTx(result).tx).toEqual([1, 1, 1, 1, 128, 7])
  })

  it('does not rewrite unrelated numeric-keyed fields', () => {
    const result = {
      signature: mangled([48, 68]),
      BEEF: mangled([2, 0, 190, 239]),
      ciphertext: mangled([1])
    }
    expect(normalizeWalletJsonTx(result)).toEqual(result)
  })

  it('leaves healthy number[] byte fields untouched', () => {
    const tx = [1, 1, 1, 1, 42]
    const result = { txid: 'abc', tx }
    expect(normalizeWalletJsonTx(result).tx).toBe(tx)
  })

  it('never rewrites structured objects, even under byte field names', () => {
    const oddTx = { version: 1, hex: '00' }
    const result = { tx: oddTx }
    expect(normalizeWalletJsonTx(result).tx).toBe(oddTx)
  })

  it('ignores non-contiguous or non-numeric numeric-keyed objects', () => {
    const sparse = { 0: 1, 2: 3 }
    const stringy = { 0: 'a', 1: 'b' }
    expect(normalizeWalletJsonTx({ tx: sparse }).tx).toBe(sparse)
    expect(normalizeWalletJsonTx({ tx: stringy }).tx).toBe(stringy)
  })

  it('passes through primitives and null safely', () => {
    expect(normalizeWalletJsonTx(null)).toBeNull()
    expect(normalizeWalletJsonTx(undefined)).toBeUndefined()
    expect(normalizeWalletJsonTx('x')).toBe('x')
    expect(normalizeWalletJsonTx(7)).toBe(7)
  })
})
