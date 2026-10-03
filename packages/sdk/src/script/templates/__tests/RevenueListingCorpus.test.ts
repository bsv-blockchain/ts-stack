import { corpus, transaction } from './RevenueListing.fixture.js'
import Spend from '../../Spend.js'

// These independent frozen rejection vectors qualify the current SDK interpreter.
// Construction tests separately execute every accepted route from rebuilt bytes.
test.each(corpus.traces.filter(item => item.expected === 'reject'))(
  'Script agrees with frozen rejection: $name',
  trace => {
    const tx = transaction(trace.txid)
    const outcomes = trace.sources.map((binding, index) => {
      const previous = transaction(binding.txid),
        source = previous.outputs[binding.index]
      const input = tx.inputs[index]
      expect(input.sourceTXID).toBe(binding.txid)
      expect(input.sourceOutputIndex).toBe(binding.index)
      try {
        return new Spend({
          sourceTXID: binding.txid,
          sourceOutputIndex: binding.index,
          sourceSatoshis: source.satoshis!,
          lockingScript: source.lockingScript,
          transactionVersion: tx.version,
          otherInputs: tx.inputs.filter((_, other) => other !== index),
          outputs: tx.outputs,
          inputIndex: index,
          unlockingScript: input.unlockingScript!,
          inputSequence: input.sequence!,
          lockTime: tx.lockTime,
          memoryLimit: 128 * 1024 * 1024
        }).validate()
      } catch {
        return false
      }
    })
    expect(outcomes.every(Boolean)).toBe(false)
  },
  30000
)
