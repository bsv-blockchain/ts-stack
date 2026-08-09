import Beef from '../dist/esm/src/transaction/Beef.js'
import { runBenchmark } from './lib/benchmark-runner.js'

const transactionCount = Number.parseInt(process.env.BEEF_SORT_TXS ?? '20000', 10)

const beef = new Beef()
for (let index = 0; index < transactionCount; index++) {
  beef.mergeTxidOnly(index.toString(16).padStart(64, '0'))
}
beef.sortTxs()

await runBenchmark(`Beef.sortTxs unchanged (${transactionCount} txs)`, () => beef.sortTxs(), {
  minSampleMs: 100,
  samples: 7
})
