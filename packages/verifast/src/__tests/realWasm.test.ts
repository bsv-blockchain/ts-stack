import BdkVerifier, { BdkErrorDomain } from '../BdkVerifier.js'
import { buildCorpus, spendsForTransaction } from '../../bench/corpus.js'

describe('bundled BDK WASM in Node', () => {
  it('loads without a caller-supplied factory and returns structured results', async () => {
    const verifier = new BdkVerifier()
    const corpus = await buildCorpus()
    const valid = corpus.find(({ name }) => name === 'p2pkh-1in-valid')
    const invalid = corpus.find(({ name }) => name === 'p2pkh-corrupt-signature')
    if (valid === undefined || invalid === undefined) throw new Error('required corpus vectors are missing')

    await expect(verifier.verifyScriptsDetailed({
      tx: valid.tx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toEqual({ domain: BdkErrorDomain.OK, code: 0 })

    const invalidResult = await verifier.verifyScriptsDetailed({
      tx: invalid.tx,
      blockHeight: 943816,
      consensus: true
    })
    expect(invalidResult.domain).toBe(BdkErrorDomain.SCRIPT)
    expect(invalidResult.code).not.toBe(0)
  })

  it('validates SDK Spend objects singly and through one packed WASM batch', async () => {
    const verifier = new BdkVerifier()
    const corpus = await buildCorpus()
    const selected = corpus.filter(({ name }) =>
      name === 'p2pkh-5in-valid' || name === 'p2pkh-5in-one-corrupt-signature'
    )
    const spends = selected.flatMap(({ tx }) => spendsForTransaction(tx))
    const expected = spends.map(spend => {
      try {
        return spend.validate()
      } catch {
        return false
      }
    })

    await expect(verifier.verifySpend(spends[0])).resolves.toBe(true)
    await expect(verifier.verifySpendsBatch(spends.map(spend => ({ spend })))).resolves.toEqual(expected)
    expect(expected.filter(valid => !valid)).toHaveLength(1)
  })

  it.each([
    ['ttn', 4],
    ['teratestnet', 4],
    ['terratestnet', 4],
    ['tstn', 5]
  ] as const)('validates through the real %s network path (BDK ID %i)', async (network, _networkId) => {
    const verifier = new BdkVerifier({ network })
    const valid = (await buildCorpus()).find(({ name }) => name === 'p2pkh-1in-valid')
    if (valid === undefined) throw new Error('required corpus vector is missing')
    await expect(verifier.verifyScripts({
      tx: valid.tx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toBe(true)
  })
})
