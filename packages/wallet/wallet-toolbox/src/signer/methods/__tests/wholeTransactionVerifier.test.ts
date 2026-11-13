import { Beef, Script, ScriptEvaluationError, ScriptResourceLimitError, Transaction } from '@bsv/sdk'
import type { BdkVerifierInterface } from '@bsv/sdk'
import type { WalletScriptVerifier } from '../../../sdk/WalletScriptVerifier'
import { verifyUnlockScripts, verifyUnlockScriptsBatch } from '../verifyUnlockScripts'

function fixture(invalidSecondInput = false, unresolvedInput = false): { beef: Beef; txid: string } {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: Script.fromASM('OP_DROP OP_TRUE') })
  source.addOutput({
    satoshis: 2,
    lockingScript: Script.fromASM(invalidSecondInput ? 'OP_DROP OP_FALSE' : 'OP_DROP OP_TRUE')
  })
  const tx = new Transaction()
  for (const sourceOutputIndex of [0, 1]) {
    tx.addInput({ sourceTransaction: source, sourceOutputIndex, unlockingScript: Script.fromASM('') })
  }
  if (unresolvedInput) {
    tx.addInput({ sourceTXID: '22'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('') })
  }
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { beef, txid: tx.id('hex') }
}

function evaluationError(txid: string): ScriptEvaluationError {
  return new ScriptEvaluationError({
    message: 'Backend script evaluation failed',
    txid,
    outputIndex: 0,
    context: 'LockingScript',
    programCounter: 0,
    stackState: [],
    altStackState: [],
    ifStackState: [],
    stackMem: 0,
    altStackMem: 0
  })
}

describe('whole-only wallet script verifier', () => {
  it('accepts the SDK whole-transaction contract without a per-Spend adapter', async () => {
    const { beef, txid } = fixture()
    const backend: BdkVerifierInterface = { verifyScripts: jest.fn(async () => true) }
    const verifier: WalletScriptVerifier = backend
    await expect(verifyUnlockScripts(txid, beef, verifier)).resolves.toEqual({ verifiedInputs: 2, skippedInputs: 0 })
    expect(backend.verifyScripts).toHaveBeenCalledWith({
      tx: beef.findTxid(txid)?.tx,
      blockHeight: 943816,
      consensus: true
    })
  })

  it('preserves the backend method receiver', async () => {
    const { beef, txid } = fixture()
    class Backend implements BdkVerifierInterface {
      calls = 0
      async verifyScripts(): Promise<boolean> {
        this.calls++
        return true
      }
    }
    const backend = new Backend()
    await expect(verifyUnlockScripts(txid, beef, backend)).resolves.toEqual({ verifiedInputs: 2, skippedInputs: 0 })
    expect(backend.calls).toBe(1)
  })

  it('uses one whole-only backend batch and preserves transaction counts', async () => {
    const { beef, txid } = fixture()
    const backend: BdkVerifierInterface = {
      verifyScripts: jest.fn(async () => true),
      verifyScriptsBatch: jest.fn(async () => [true, true])
    }
    await expect(verifyUnlockScriptsBatch([txid, txid], beef, backend)).resolves.toEqual([
      { verifiedInputs: 2, skippedInputs: 0 },
      { verifiedInputs: 2, skippedInputs: 0 }
    ])
    expect(backend.verifyScriptsBatch).toHaveBeenCalledWith([
      { tx: beef.findTxid(txid)?.tx, blockHeight: 943816, consensus: true },
      { tx: beef.findTxid(txid)?.tx, blockHeight: 943816, consensus: true }
    ])
    expect(backend.verifyScripts).not.toHaveBeenCalled()
  })

  it('reports the actual invalid input after a false whole-only verdict', async () => {
    const { beef, txid } = fixture(true)
    await expect(verifyUnlockScripts(txid, beef, { verifyScripts: async () => false })).rejects.toThrow(
      'inputs[1].unlockScript'
    )
  })

  it('reports the actual invalid input after a whole-only consensus script error', async () => {
    const { beef, txid } = fixture(true)
    await expect(
      verifyUnlockScripts(txid, beef, {
        verifyScripts: async () => {
          throw evaluationError(txid)
        }
      })
    ).rejects.toThrow('inputs[1].unlockScript')
  })

  it('validates scripts locally when a whole-only backend declines', async () => {
    const { beef, txid } = fixture()
    const backend: BdkVerifierInterface = { shouldVerifyScripts: () => false, verifyScripts: jest.fn(async () => true) }
    await expect(verifyUnlockScripts(txid, beef, backend)).resolves.toEqual({ verifiedInputs: 2, skippedInputs: 0 })
    expect(backend.verifyScripts).not.toHaveBeenCalled()
  })

  it('rejects an invalid input when a whole-only backend declines', async () => {
    const { beef, txid } = fixture(true)
    const backend: BdkVerifierInterface = { shouldVerifyScripts: () => false, verifyScripts: jest.fn(async () => true) }
    await expect(verifyUnlockScripts(txid, beef, backend)).rejects.toThrow('inputs[1].unlockScript')
    expect(backend.verifyScripts).not.toHaveBeenCalled()
  })

  it('retains historical local fallback for a valid script after a false verdict', async () => {
    const { beef, txid } = fixture()
    await expect(verifyUnlockScripts(txid, beef, { verifyScripts: async () => false })).resolves.toEqual({
      verifiedInputs: 2,
      skippedInputs: 0
    })
  })

  it('verifies every known source locally while preserving unresolved-source counts', async () => {
    const { beef, txid } = fixture(false, true)
    const backend: BdkVerifierInterface = { verifyScripts: jest.fn(async () => true) }
    await expect(verifyUnlockScripts(txid, beef, backend)).resolves.toEqual({ verifiedInputs: 2, skippedInputs: 1 })
    expect(backend.verifyScripts).not.toHaveBeenCalled()
  })

  it('still rejects an invalid known input alongside an unresolved source', async () => {
    const { beef, txid } = fixture(true, true)
    const backend: BdkVerifierInterface = { verifyScripts: jest.fn(async () => true) }
    await expect(verifyUnlockScripts(txid, beef, backend)).rejects.toThrow('inputs[1].unlockScript')
    expect(backend.verifyScripts).not.toHaveBeenCalled()
  })

  it('propagates backend initialization failure unchanged', async () => {
    const { beef, txid } = fixture()
    const error = new Error('backend initialization failed')
    await expect(
      verifyUnlockScripts(txid, beef, {
        verifyScripts: async () => {
          throw error
        }
      })
    ).rejects.toBe(error)
  })

  it('propagates backend resource exhaustion unchanged', async () => {
    const { beef, txid } = fixture()
    const error = new ScriptResourceLimitError('stack', 1024, 2048)
    await expect(
      verifyUnlockScripts(txid, beef, {
        verifyScripts: async () => {
          throw error
        }
      })
    ).rejects.toBe(error)
  })

  it('rejects an incomplete whole-transaction batch result', async () => {
    const { beef, txid } = fixture()
    await expect(
      verifyUnlockScriptsBatch([txid, txid], beef, {
        verifyScripts: async () => true,
        verifyScriptsBatch: async () => [true]
      })
    ).rejects.toThrow('invalid transaction batch result count')
  })
})
