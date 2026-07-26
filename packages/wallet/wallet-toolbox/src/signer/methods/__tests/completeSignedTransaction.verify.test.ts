import {
  Beef,
  Script,
  ScriptResourceLimitError,
  Transaction
} from '@bsv/sdk'
import {
  verifyUnlockScripts
} from '../completeSignedTransaction'
import { verifyUnlockScriptsBatch } from '../verifyUnlockScripts'

function verificationFixture (
  includeUnresolvedInput: boolean,
  resolvedInputs = 1
): {
  beef: Beef
  txid: string
} {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let index = 0; index < resolvedInputs; index++) {
    source.addOutput({
      satoshis: 2,
      lockingScript: Script.fromASM('OP_DROP OP_TRUE')
    })
  }

  const tx = new Transaction()
  for (let index = 0; index < resolvedInputs; index++) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: index,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
  }
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

  it('does not misreport verifier integration failures as invalid scripts', async () => {
    const { beef, txid } = verificationFixture(false)
    const failure = new Error('backend initialization failed')

    await expect(verifyUnlockScripts(txid, beef, {
      verifySpend: async () => { throw failure }
    })).rejects.toBe(failure)
  })

  it('uses one backend batch for all selected inputs and transactions', async () => {
    const { beef, txid } = verificationFixture(false, 2)
    const verifySpendsBatch = jest.fn(async () => [true, true, true, true])
    const verifier = {
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScriptsBatch(
      [txid, txid],
      beef,
      verifier
    )).resolves.toEqual([
      { verifiedInputs: 2, skippedInputs: 0 },
      { verifiedInputs: 2, skippedInputs: 0 }
    ])
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
    expect(verifySpendsBatch.mock.calls[0][0]).toHaveLength(4)
    expect(verifySpendsBatch.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ consensus: true })
      ])
    )
    expect(verifier.verifySpend).not.toHaveBeenCalled()
  })
})
