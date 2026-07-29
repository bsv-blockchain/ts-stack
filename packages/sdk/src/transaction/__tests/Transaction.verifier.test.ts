import Transaction from '../Transaction'
import Script from '../../script/Script'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import MerklePath from '../MerklePath'
import type BdkVerifierInterface from '../BdkVerifierInterface'
import Spend from '../../script/Spend'

// Build a tx whose single P2PKH input is genuinely valid under the pure-JS interpreter.
async function buildValidTx(): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  await source.sign()
  source.merklePath = new MerklePath(1000, [
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('Transaction.verify with a pluggable verifier', () => {
  it('routes to the verifier and attributes its false result to the transaction', async () => {
    const tx = await buildValidTx()
    let called = 0
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => {
        called++
        return false
      }
    }
    // Pure-JS would return true; verifier says false -> proves bypass + routing.
    await expect(tx.verify('scripts only', undefined, undefined, verifier)).rejects.toThrow(
      `Script verification failed for transaction ${tx.id('hex')}`
    )
    expect(called).toBe(1)
  })

  it('returns true when the verifier approves', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = { verifyScripts: async () => true }
    const result = await tx.verify('scripts only', undefined, undefined, verifier)
    expect(result).toBe(true)
  })

  it('preserves the JavaScript path when an adaptive verifier declines before execution', async () => {
    const tx = await buildValidTx()
    const verifyScripts = jest.fn(async () => false)
    const shouldVerifyScripts = jest.fn(() => false)

    await expect(
      tx.verify('scripts only', undefined, undefined, {
        shouldVerifyScripts,
        verifyScripts
      })
    ).resolves.toBe(true)

    expect(shouldVerifyScripts).toHaveBeenCalledTimes(1)
    expect(shouldVerifyScripts).toHaveBeenCalledWith({
      tx,
      blockHeight: 943816,
      consensus: true
    })
    expect(verifyScripts).not.toHaveBeenCalled()
  })

  it('keeps a selected adaptive verifier authoritative', async () => {
    const tx = await buildValidTx()
    const failure = new Error('selected backend failed')
    const verifier: BdkVerifierInterface = {
      shouldVerifyScripts: () => true,
      verifyScripts: async () => {
        throw failure
      }
    }

    await expect(tx.verify('scripts only', undefined, undefined, verifier)).rejects.toBe(failure)
  })

  it('bypasses a backend that cannot enforce an explicit memory limit', async () => {
    const tx = await buildValidTx()
    const verifyScripts = jest.fn(async () => false)

    await expect(
      tx.verify('scripts only', undefined, 1024, {
        verifyScripts
      })
    ).resolves.toBe(true)
    expect(verifyScripts).not.toHaveBeenCalled()

    const capableVerifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: jest.fn(async () => true)
    }
    await expect(tx.verify('scripts only', undefined, 1024, capableVerifier)).resolves.toBe(true)
    expect(capableVerifier.verifyScripts).toHaveBeenCalledWith({
      tx,
      blockHeight: 943816,
      consensus: true,
      memoryLimit: 1024
    })
  })

  it('does not hash an already-linked transaction graph for scripts-only verification', async () => {
    const tx = await buildValidTx()
    const sourceTransaction = tx.inputs[0].sourceTransaction as Transaction
    tx.inputs[0].sourceTXID = sourceTransaction.id('hex')
    const txId = jest.spyOn(tx, 'id')
    const sourceId = jest.spyOn(sourceTransaction, 'id')

    await expect(
      tx.verify('scripts only', undefined, undefined, {
        verifyScripts: async () => true
      })
    ).resolves.toBe(true)

    expect(txId).not.toHaveBeenCalled()
    expect(sourceId).not.toHaveBeenCalled()
  })

  it('propagates a verifier throw (strict, no fallback)', async () => {
    const tx = await buildValidTx()
    const verifier: BdkVerifierInterface = {
      verifyScripts: async () => {
        throw new Error('wasm unavailable')
      }
    }
    await expect(tx.verify('scripts only', undefined, undefined, verifier)).rejects.toThrow(
      'wasm unavailable'
    )
  })

  it('passes the post-Chronicle fallback blockHeight (943816) to the verifier', async () => {
    const tx = await buildValidTx() // unmined tx -> no merkle proof -> fallback height
    let seenHeight = -1
    const verifier: BdkVerifierInterface = {
      verifyScripts: async ({ blockHeight }) => {
        seenHeight = blockHeight
        return true
      }
    }
    await tx.verify('scripts only', undefined, undefined, verifier)
    expect(seenHeight).toBe(943816)
  })

  it('collects an unmined dependency graph into one ordered backend batch', async () => {
    const middle = await buildValidTx()
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: middle,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    tip.addOutput({
      satoshis: 1,
      lockingScript: Script.fromASM('OP_TRUE')
    })

    const verifyScripts = jest.fn(async () => {
      throw new Error('the graph should use the batch entry point')
    })
    const verifyScriptsBatch = jest.fn(async params => params.map(() => true))

    await expect(
      tip.verify('scripts only', undefined, undefined, {
        verifyScripts,
        verifyScriptsBatch
      })
    ).resolves.toBe(true)

    expect(verifyScripts).not.toHaveBeenCalled()
    expect(verifyScriptsBatch).toHaveBeenCalledTimes(1)
    expect(verifyScriptsBatch.mock.calls[0][0].map(({ tx }) => tx)).toEqual([tip, middle])
  })

  it('rejects a malformed graph-batch result instead of masking transactions', async () => {
    const tx = await buildValidTx()
    await expect(
      tx.verify('scripts only', undefined, undefined, {
        verifyScripts: async () => true,
        verifyScriptsBatch: async () => []
      })
    ).rejects.toThrow('invalid batch result count')
  })

  it('attributes a failed graph-batch verdict to the offending transaction', async () => {
    const middle = await buildValidTx()
    const tip = new Transaction()
    tip.addInput({
      sourceTransaction: middle,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    tip.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })

    await expect(
      tip.verify('scripts only', undefined, undefined, {
        verifyScripts: async () => true,
        verifyScriptsBatch: async () => [true, false]
      })
    ).rejects.toThrow(`Script verification failed for transaction ${middle.id('hex')}`)
  })

  it('retains verification errors for missing source transactions and scripts', async () => {
    const missingSource = new Transaction()
    missingSource.addInput({
      sourceTXID: '11'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    missingSource.addOutput({
      satoshis: 1,
      lockingScript: Script.fromASM('OP_TRUE')
    })
    await expect(missingSource.verify('scripts only')).rejects.toThrow(
      'missing an associated source transaction'
    )

    const source = new Transaction()
    source.addOutput({
      satoshis: 2,
      lockingScript: Script.fromASM('OP_TRUE')
    })
    const missingScript = new Transaction()
    missingScript.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0
    })
    missingScript.addOutput({
      satoshis: 1,
      lockingScript: Script.fromASM('OP_TRUE')
    })
    await expect(missingScript.verify('scripts only')).rejects.toThrow(
      'unlockingScript is undefined'
    )
  })

  it('retains invalid-script and value-conservation results', async () => {
    const invalidScriptSpend = await buildValidTx()
    const validateJavaScript = jest
      .spyOn(Spend.prototype, 'validateJavaScript')
      .mockReturnValueOnce(false)
    try {
      await expect(invalidScriptSpend.verify('scripts only')).resolves.toBe(false)
    } finally {
      validateJavaScript.mockRestore()
    }

    const excessiveOutput = await buildValidTx()
    excessiveOutput.outputs[0].satoshis = 3
    await expect(
      excessiveOutput.verify('scripts only', undefined, undefined, {
        verifyScripts: async () => true
      })
    ).resolves.toBe(false)
  })

  it('retains undefined-output and insufficient-fee failures', async () => {
    const undefinedOutput = await buildValidTx()
    delete undefinedOutput.outputs[0].satoshis
    await expect(
      undefinedOutput.verify('scripts only', undefined, undefined, {
        verifyScripts: async () => true
      })
    ).rejects.toThrow('Every output must have a defined amount during transaction verification')

    const insufficientFee = await buildValidTx()
    await expect(
      insufficientFee.verify('scripts only', { computeFee: async () => 2 }, undefined, {
        verifyScripts: async () => true
      })
    ).rejects.toThrow('has an insufficient fee and has not been mined')
  })

  it('retains the explicit undefined-transaction fee guard', async () => {
    const tx = await buildValidTx()
    await expect(
      (tx as any).verifyTransactionFee(undefined, { computeFee: async () => 1 }, () => tx.id('hex'))
    ).rejects.toThrow('Transaction is undefined')
  })
})
