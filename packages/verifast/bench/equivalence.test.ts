import BdkVerifier from '../src/BdkVerifier.js'
import { buildCorpus, spendsForTransaction } from './corpus.js'

describe('JS Spend vs real BDK WASM equivalence', () => {
  it('agrees on every deterministic positive and negative vector', async () => {
    const verifier = new BdkVerifier({ mode: 'always' })
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

  it('agrees with every individual SDK Spend verdict in the corpus', async () => {
    const verifier = new BdkVerifier({ mode: 'always' })
    const corpus = await buildCorpus()

    for (const { name, tx } of corpus) {
      const spends = spendsForTransaction(tx)
      const jsVerdicts = spends.map(spend => {
        try {
          return spend.validate()
        } catch {
          return false
        }
      })
      const bdkVerdicts = await verifier.verifySpendsBatch(spends.map(spend => ({ spend })))
      expect({ name, bdkVerdicts }).toEqual({ name, bdkVerdicts: jsVerdicts })
    }
  })
})
