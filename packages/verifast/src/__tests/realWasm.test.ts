import BdkVerifier, { BdkErrorDomain } from '../BdkVerifier.js'
import { buildCorpus } from '../../bench/corpus.js'

describe('bundled BDK WASM in Node', () => {
  it('loads without a caller-supplied factory and returns structured results', async () => {
    const verifier = new BdkVerifier()
    const corpus = await buildCorpus()
    const valid = corpus.find(({ name }) => name === 'p2pkh-1in-valid')!
    const invalid = corpus.find(({ name }) => name === 'p2pkh-corrupt-signature')!

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
})
