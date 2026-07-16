import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus } from './corpus.js'

describe('JS Spend vs real BDK WASM equivalence', () => {
  it('agrees on every deterministic positive and negative vector', async () => {
    const verifier = new BdkVerifier()
    const corpus = await buildCorpus()

    for (const { name, tx, expected } of corpus) {
      let jsResult = false
      try {
        jsResult = await tx.verify('scripts only')
      } catch {
        // The SDK's Spend path throws ScriptEvaluationError for invalid scripts;
        // BDK reports the same verdict through its structured error domain.
      }
      const bdkResult = await tx.verify('scripts only', undefined, undefined, verifier)
      expect({ name, jsResult, bdkResult }).toEqual({
        name,
        jsResult: expected,
        bdkResult: expected
      })
    }
  })
})
