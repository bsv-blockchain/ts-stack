import {
  Beef,
  BigNumber,
  ECDSA,
  P2PKH,
  PrivateKey,
  PublicKey,
  Script,
  ScriptEvaluationError,
  ScriptResourceLimitError,
  Signature,
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

function scriptShapeFixture (lockingScript: Script, unlockingScript: Script): {
  beef: Beef
  txid: string
} {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript })
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  const beef = new Beef()
  beef.mergeTransaction(tx)
  return { beef, txid: tx.id('hex') }
}

function structurallyMutableBeef (source: Beef, txid: string): { beef: Beef, tx: Transaction } {
  const tx = source.findTxid(txid)?.tx
  if (tx == null) throw new Error('test transaction missing from BEEF')
  const txs = source.txs.map(item => ({ txid: item.txid, tx: item.tx }))
  return {
    beef: {
      findTxid: (candidate: string) => txs.find(item => item.txid === candidate),
      txs
    } as unknown as Beef,
    tx
  }
}

async function p2pkhVerificationFixture(resolvedInputs = 2): Promise<{
  beef: Beef
  txid: string
}> {
  const key = new PrivateKey(42)
  const p2pkh = new P2PKH()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let index = 0; index < resolvedInputs; index++) {
    source.addOutput({ satoshis: 2, lockingScript: p2pkh.lock(key.toAddress()) })
  }

  const tx = new Transaction()
  for (let index = 0; index < resolvedInputs; index++) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: index,
      unlockingScriptTemplate: p2pkh.unlock(key)
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
  await tx.sign()

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

  it('verifies a fully resolved transaction once when the backend supports it', async () => {
    const { beef, txid } = verificationFixture(false, 2)
    const verifyScripts = jest.fn(async () => true)
    const verifySpendsBatch = jest.fn(async () => [true, true])
    const verifier = {
      shouldVerifyScripts: jest.fn(() => true),
      verifyScripts,
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).resolves.toEqual({
      verifiedInputs: 2,
      skippedInputs: 0
    })
    expect(verifyScripts).toHaveBeenCalledTimes(1)
    expect(verifyScripts).toHaveBeenCalledWith(expect.objectContaining({
      tx: beef.findTxid(txid)?.tx,
      blockHeight: 943816,
      consensus: true
    }))
    expect(verifySpendsBatch).not.toHaveBeenCalled()
  })

  it('retains per-input diagnostics after a false whole-transaction verdict', async () => {
    const { beef, txid } = verificationFixture(false, 2)
    const verifySpendsBatch = jest.fn(async () => [true, false])
    const verifier = {
      verifyScripts: jest.fn(async () => false),
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).rejects.toThrow('inputs[1].unlockScript')
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
  })

  it('retains per-input diagnostics after a whole-transaction script error', async () => {
    const { beef, txid } = verificationFixture(false, 2)
    const verifySpendsBatch = jest.fn(async () => [true, false])
    const scriptError = new ScriptEvaluationError({
      message: 'OP_VERIFY failed',
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
    const verifier = {
      verifyScripts: jest.fn(async () => { throw scriptError }),
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).rejects.toThrow('inputs[1].unlockScript')
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
  })

  it('retains known-source skipping instead of selecting whole-transaction verification', async () => {
    const { beef, txid } = verificationFixture(true)
    const verifyScripts = jest.fn(async () => true)
    const verifier = {
      verifyScripts,
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true)
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).resolves.toEqual({
      verifiedInputs: 1,
      skippedInputs: 1
    })
    expect(verifyScripts).not.toHaveBeenCalled()
  })

  it('batch-verifies exact wallet P2PKH signatures without general script serialization', async () => {
    const { beef, txid } = await p2pkhVerificationFixture(2)
    const verifyDigestBatch = jest.fn(async items => items.map(item => ECDSA.verify(
      new BigNumber(Array.from(item.digest)),
      Signature.fromDER(Array.from(item.signature)),
      PublicKey.fromDER(Array.from(item.publicKey))
    )))
    const verifyScripts = jest.fn(async () => true)
    const verifySpendsBatch = jest.fn(async () => [true, true])
    const verifier = {
      isReady: () => true,
      supportsCrypto: (operation: string) => operation === 'verifyDigestBatch',
      verifyDigestBatch,
      verifyScripts,
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).resolves.toEqual({
      verifiedInputs: 2,
      skippedInputs: 0
    })
    expect(verifyDigestBatch).toHaveBeenCalledTimes(1)
    expect(verifyDigestBatch.mock.calls[0][0]).toHaveLength(2)
    expect(verifyScripts).not.toHaveBeenCalled()
    expect(verifySpendsBatch).not.toHaveBeenCalled()
  })

  it('falls through to per-input diagnostics after a false digest verdict', async () => {
    const { beef, txid } = await p2pkhVerificationFixture(2)
    const verifySpendsBatch = jest.fn(async () => [true, false])
    const verifier = {
      isReady: () => true,
      supportsCrypto: (operation: string) => operation === 'verifyDigestBatch',
      verifyDigestBatch: jest.fn(async () => [true, false]),
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true),
      verifySpendsBatch
    }

    await expect(verifyUnlockScripts(txid, beef, verifier)).rejects.toThrow('inputs[1].unlockScript')
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid digest batch result count', async () => {
    const { beef, txid } = await p2pkhVerificationFixture(2)
    const verifier = {
      isReady: () => true,
      supportsCrypto: (operation: string) => operation === 'verifyDigestBatch',
      verifyDigestBatch: jest.fn(async () => [true]),
      verifySpend: jest.fn(async () => true)
    }

    await expect(verifyUnlockScripts(txid, beef, verifier))
      .rejects.toThrow('invalid digest batch result count')
  })

  it.each([
    ['not ready', () => false, () => true],
    ['unsupported', () => true, () => false]
  ])('does not select a digest backend that is %s', async (_name, isReady, supportsCrypto) => {
    const { beef, txid } = await p2pkhVerificationFixture(1)
    const verifyDigestBatch = jest.fn(async () => [true])
    const verifySpendsBatch = jest.fn(async () => [true])

    await expect(verifyUnlockScripts(txid, beef, {
      isReady,
      supportsCrypto,
      verifyDigestBatch,
      shouldVerifySpend: () => true,
      verifySpend: async () => true,
      verifySpendsBatch
    })).resolves.toEqual({ verifiedInputs: 1, skippedInputs: 0 })
    expect(verifyDigestBatch).not.toHaveBeenCalled()
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
  })

  it('routes every non-canonical P2PKH shape through general script verification', async () => {
    const canonical = await p2pkhVerificationFixture(1)
    const canonicalTx = canonical.beef.findTxid(canonical.txid)?.tx
    const canonicalInput = canonicalTx?.inputs[0]
    const lock = Array.from(canonicalInput?.sourceTransaction?.outputs[0].lockingScript.toUint8Array() ?? [])
    const unlock = Array.from(canonicalInput?.unlockingScript?.toUint8Array() ?? [])
    expect(lock).toHaveLength(25)
    expect(unlock.length).toBeGreaterThan(40)

    const lockVariants = [
      lock.slice(0, 24),
      lock.map((byte, index) => index === 0 ? 0x75 : byte),
      lock.map((byte, index) => index === 1 ? 0xa8 : byte),
      lock.map((byte, index) => index === 2 ? 0x15 : byte),
      lock.map((byte, index) => index === 23 ? 0x89 : byte),
      lock.map((byte, index) => index === 24 ? 0xad : byte)
    ]
    const signatureLength = unlock[0]
    const publicKeyOffset = 1 + signatureLength + 1
    const malformedSignature = [9, ...Array(9).fill(0), 33, ...unlock.slice(publicKeyOffset)]
    const unlockVariants = [
      [],
      [8, ...unlock.slice(1, 9), 33, ...unlock.slice(publicKeyOffset)],
      [74, ...unlock.slice(1)],
      unlock.slice(0, -1),
      unlock.map((byte, index) => index === 1 + signatureLength ? 32 : byte),
      unlock.map((byte, index) => index === publicKeyOffset ? 0x04 : byte),
      unlock.map((byte, index) => index === unlock.length - 1 ? byte ^ 1 : byte),
      malformedSignature,
      unlock.map((byte, index) => index === signatureLength ? 0x42 : byte)
    ]
    const variants = [
      ...lockVariants.map(bytes => ({ lock: bytes, unlock })),
      ...unlockVariants.map(bytes => ({ lock, unlock: bytes }))
    ]

    for (const variant of variants) {
      const { beef, txid } = scriptShapeFixture(
        Script.fromBinary(variant.lock),
        Script.fromBinary(variant.unlock)
      )
      const verifyDigestBatch = jest.fn(async () => [true])
      const verifySpendsBatch = jest.fn(async () => [true])
      await expect(verifyUnlockScripts(txid, beef, {
        isReady: () => true,
        supportsCrypto: () => true,
        verifyDigestBatch,
        shouldVerifySpend: () => true,
        verifySpend: async () => true,
        verifySpendsBatch
      })).resolves.toEqual({ verifiedInputs: 1, skippedInputs: 0 })
      expect(verifyDigestBatch).not.toHaveBeenCalled()
      expect(verifySpendsBatch).toHaveBeenCalledTimes(1)
    }
  })

  it('validates hydrated transaction structure before using accelerated backends', async () => {
    const verifier = {
      verifyScripts: jest.fn(async () => true),
      verifySpend: jest.fn(async () => true)
    }
    await expect(verifyUnlockScripts('ff'.repeat(32), new Beef(), verifier))
      .rejects.toThrow('contained in beef')

    const missingSource = verificationFixture(false)
    const mutableMissingSource = structurallyMutableBeef(missingSource.beef, missingSource.txid)
    mutableMissingSource.tx.inputs[0].sourceTXID = undefined
    await expect(verifyUnlockScripts(missingSource.txid, mutableMissingSource.beef, verifier))
      .rejects.toThrow('inputs[0].sourceTXID')

    const missingUnlock = verificationFixture(false)
    const mutableMissingUnlock = structurallyMutableBeef(missingUnlock.beef, missingUnlock.txid)
    mutableMissingUnlock.tx.inputs[0].unlockingScript = undefined
    await expect(verifyUnlockScripts(missingUnlock.txid, mutableMissingUnlock.beef, verifier))
      .rejects.toThrow('inputs[0].unlockingScript')

    const badIndex = verificationFixture(false)
    const mutableBadIndex = structurallyMutableBeef(badIndex.beef, badIndex.txid)
    mutableBadIndex.tx.inputs[0].sourceOutputIndex = 99
    await expect(verifyUnlockScripts(badIndex.txid, mutableBadIndex.beef, verifier))
      .rejects.toThrow('reference an output')
  })

  it('supports whole-transaction batching and rejects malformed backend results', async () => {
    const { beef, txid } = verificationFixture(false)
    const verifyScriptsBatch = jest.fn(async () => [true, true])
    const verifier = {
      verifyScripts: jest.fn(async () => true),
      verifyScriptsBatch,
      verifySpend: jest.fn(async () => true)
    }
    await expect(verifyUnlockScriptsBatch([txid, txid], beef, verifier)).resolves.toEqual([
      { verifiedInputs: 1, skippedInputs: 0 },
      { verifiedInputs: 1, skippedInputs: 0 }
    ])
    expect(verifyScriptsBatch).toHaveBeenCalledTimes(1)

    verifyScriptsBatch.mockResolvedValueOnce([true])
    await expect(verifyUnlockScriptsBatch([txid, txid], beef, verifier))
      .rejects.toThrow('invalid transaction batch result count')

    const failure = new Error('whole backend unavailable')
    verifyScriptsBatch.mockRejectedValueOnce(failure)
    await expect(verifyUnlockScripts(txid, beef, verifier)).rejects.toBe(failure)
  })

  it('honors whole-transaction backend selection and empty batches', async () => {
    const { beef, txid } = verificationFixture(false)
    const verifyScripts = jest.fn(async () => true)
    const verifySpendsBatch = jest.fn(async () => [true])
    await expect(verifyUnlockScripts(txid, beef, {
      verifyScripts,
      shouldVerifyScripts: () => false,
      shouldVerifySpend: () => true,
      verifySpend: async () => true,
      verifySpendsBatch
    })).resolves.toEqual({ verifiedInputs: 1, skippedInputs: 0 })
    expect(verifyScripts).not.toHaveBeenCalled()
    expect(verifySpendsBatch).toHaveBeenCalledTimes(1)

    await expect(verifyUnlockScriptsBatch([], new Beef(), {
      isReady: () => true,
      supportsCrypto: () => true,
      verifyDigestBatch: async () => [],
      verifyScripts: async () => true,
      verifySpend: async () => true
    })).resolves.toEqual([])
  })

  it('uses consensus defaults when canonical inputs omit optional numeric fields', async () => {
    const fixture = await p2pkhVerificationFixture(1)
    const mutable = structurallyMutableBeef(fixture.beef, fixture.txid)
    const input = mutable.tx.inputs[0]
    if (input.sourceTransaction == null) throw new Error('test source transaction missing')
    input.sourceTransaction.outputs[input.sourceOutputIndex].satoshis = undefined
    input.sequence = undefined
    const verifyDigestBatch = jest.fn(async () => [true])
    const verifier = { verifySpend: async () => true, verifyDigestBatch }

    await expect(verifyUnlockScripts(fixture.txid, mutable.beef, verifier))
      .resolves.toEqual({ verifiedInputs: 1, skippedInputs: 0 })
    expect(verifyDigestBatch).toHaveBeenCalledTimes(1)
  })
})
