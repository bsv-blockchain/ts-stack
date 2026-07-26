import {
  Beef,
  Script,
  ScriptResourceLimitError,
  Transaction
} from '@bsv/sdk'
import { verifyUnlockScripts } from '../completeSignedTransaction'

function verificationFixture (includeUnresolvedInput: boolean): {
  beef: Beef
  txid: string
} {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({
    satoshis: 2,
    lockingScript: Script.fromASM('OP_DROP OP_TRUE')
  })

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  if (includeUnresolvedInput) {
    tx.addInput({
      sourceTXID: '22'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })

  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { beef, txid: tx.id('hex') }
}

describe('verifyUnlockScripts', () => {
  it('verifies every resolvable input in explicit consensus context', async () => {
    const { beef, txid } = verificationFixture(true)
    const verifier = {
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true)
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).resolves.toEqual({
      verifiedInputs: 1,
      skippedInputs: 1
    })
    expect(verifier.shouldVerifySpend).toHaveBeenCalledWith(
      expect.anything(),
      { consensus: true }
    )
    expect(verifier.verifySpend).toHaveBeenCalledWith(
      expect.anything(),
      { consensus: true }
    )
  })

  it('does not misreport local resource exhaustion as an invalid script', async () => {
    const { beef, txid } = verificationFixture(false)
    const resourceError = new ScriptResourceLimitError('stack', 1024, 2048)

    await expect(verifyUnlockScripts(txid, beef, {
      verifySpend: async () => { throw resourceError }
    })).rejects.toBe(resourceError)
  })
})
