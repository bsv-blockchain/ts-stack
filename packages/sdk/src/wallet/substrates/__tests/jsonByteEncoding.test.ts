import { walletJsonReplacer, walletJsonReviver } from '../utils/jsonByteEncoding'

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

describe('walletJsonReviver', () => {
  const mangled = (bytes: number[]): Record<string, number> =>
    JSON.parse(JSON.stringify(new Uint8Array(bytes)))
  const parse = <T>(value: T): T => JSON.parse(JSON.stringify(value), walletJsonReviver)

  it('repairs a numeric-keyed tx object into number[]', () => {
    const result = { txid: 'abc', tx: mangled([1, 1, 1, 1, 128, 7]) }
    expect(parse(result).tx).toEqual([1, 1, 1, 1, 128, 7])
  })

  it('repairs nested byte fields (signableTransaction.tx)', () => {
    const result = { signableTransaction: { reference: 'r', tx: mangled([9, 8, 7]) } }
    expect(parse(result).signableTransaction.tx).toEqual([9, 8, 7])
  })

  it('repairs tx fields inside arrays of results', () => {
    const result = {
      actions: [
        { txid: 'a', tx: mangled([5, 5]) },
        { txid: 'b', tx: [6] }
      ]
    }
    const parsed = parse(result)
    expect(parsed.actions[0].tx).toEqual([5, 5])
    expect(parsed.actions[1].tx).toEqual([6])
  })

  it('does not rewrite unrelated numeric-keyed fields', () => {
    const result = {
      signature: mangled([48, 68]),
      BEEF: mangled([2, 0, 190, 239]),
      ciphertext: mangled([1])
    }
    expect(parse(result)).toEqual(result)
  })

  it('leaves healthy number[] byte fields untouched', () => {
    const tx = [1, 1, 1, 1, 42]
    const result = { txid: 'abc', tx }
    expect(parse(result).tx).toEqual(tx)
  })

  it('never rewrites structured objects, even under byte field names', () => {
    const oddTx = { version: 1, hex: '00' }
    const result = { tx: oddTx, signableTransaction: { reference: 'r' } }
    expect(parse(result).tx).toEqual(oddTx)
  })

  it('ignores non-contiguous or non-numeric numeric-keyed objects', () => {
    const sparse = { 0: 1, 2: 3 }
    const stringy = { 0: 'a', 1: 'b' }
    const result = { tx: sparse, nested: { tx: stringy } }
    const parsed = parse(result)
    expect(parsed.tx).toEqual(sparse)
    expect(parsed.nested.tx).toEqual(stringy)
  })

  it('passes through primitives and null safely', () => {
    expect(walletJsonReviver('', null)).toBeNull()
    expect(walletJsonReviver('', undefined)).toBeUndefined()
    expect(walletJsonReviver('', 'x')).toBe('x')
    expect(walletJsonReviver('', 7)).toBe(7)
  })
})
