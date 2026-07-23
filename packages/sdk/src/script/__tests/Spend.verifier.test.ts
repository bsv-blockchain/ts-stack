import { P2PKH, PrivateKey, Script, Spend, Transaction } from '../../../mod'
import {
  registerScriptVerificationBackend,
  unregisterScriptVerificationBackend
} from '../../transaction/ScriptVerificationBackend'

async function buildSpend (): Promise<{ spend: Spend, tx: Transaction }> {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({ sourceTXID: '00'.repeat(32), sourceOutputIndex: 0, unlockingScript: Script.fromASM('OP_TRUE') })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  const input = tx.inputs[0]
  if (input.unlockingScript === undefined) throw new Error('fixture was not signed')
  return {
    tx,
    spend: new Spend({
      sourceTXID: source.id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 2,
      lockingScript: source.outputs[0].lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    })
  }
}

describe('Spend verifier integration', () => {
  it('serializes the exact ordinary transaction represented by the Spend', async () => {
    const { spend, tx } = await buildSpend()
    expect(spend.toTransactionUint8Array()).toEqual(tx.toUint8Array())
  })

  it('delegates validateWith without masking backend failures', async () => {
    const { spend } = await buildSpend()
    const verifier = { verifySpend: jest.fn(async () => false) }
    await expect(spend.validateWith(verifier)).resolves.toBe(false)
    expect(verifier.verifySpend).toHaveBeenCalledWith(spend)

    const failure = new Error('backend unavailable')
    await expect(spend.validateWith({ verifySpend: async () => { throw failure } })).rejects.toBe(failure)
  })

  it('uses the JavaScript validator when an adaptive backend declines', async () => {
    const { spend } = await buildSpend()
    const verifySpend = jest.fn(async () => false)
    const shouldVerifySpend = jest.fn(() => false)

    await expect(spend.validateWith({ shouldVerifySpend, verifySpend })).resolves.toBe(true)
    expect(shouldVerifySpend).toHaveBeenCalledWith(spend)
    expect(verifySpend).not.toHaveBeenCalled()
  })

  it('keeps a selected adaptive backend authoritative', async () => {
    const { spend } = await buildSpend()
    const failure = new Error('selected backend failed')
    await expect(spend.validateWith({
      shouldVerifySpend: () => true,
      verifySpend: async () => { throw failure }
    })).rejects.toBe(failure)
  })

  it('uses a registered warm synchronous backend from the compatibility validate API', async () => {
    const { spend } = await buildSpend()
    const backend = {
      verifyScripts: async () => true,
      verifySpend: async () => true,
      verifySpendSync: jest.fn(() => false),
      shouldVerifySpend: jest.fn(() => true)
    }
    registerScriptVerificationBackend(backend)
    try {
      expect(() => spend.validate()).toThrow(
        'The selected script-verification backend rejected the spend.'
      )
      expect(backend.shouldVerifySpend).toHaveBeenCalledWith(spend)
      expect(backend.verifySpendSync).toHaveBeenCalledWith(spend)
    } finally {
      unregisterScriptVerificationBackend(backend)
    }
  })

  it('keeps compatibility validation on JavaScript while a sync backend is cold', async () => {
    const { spend } = await buildSpend()
    const backend = {
      isReady: jest.fn(() => false),
      verifyScripts: async () => true,
      verifySpend: async () => true,
      verifySpendSync: jest.fn(() => false),
      shouldVerifySpend: jest.fn(() => true)
    }
    registerScriptVerificationBackend(backend)
    try {
      expect(spend.validate()).toBe(true)
      expect(backend.isReady).toHaveBeenCalled()
      expect(backend.shouldVerifySpend).not.toHaveBeenCalled()
      expect(backend.verifySpendSync).not.toHaveBeenCalled()
    } finally {
      unregisterScriptVerificationBackend(backend)
    }
  })

  it('inserts the active input at its exact index when only otherInputs are supplied', () => {
    const sources = [0, 1, 2].map(index => {
      const source = new Transaction()
      source.addInput({
        sourceTXID: `${index + 1}`.padStart(64, '0'),
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_TRUE')
      })
      source.addOutput({ satoshis: index + 2, lockingScript: Script.fromASM('OP_TRUE') })
      return source
    })
    const tx = new Transaction()
    sources.forEach((source, index) => tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM(`OP_${index + 1}`),
      sequence: 100 + index
    }))
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    const active = tx.inputs[1]
    if (active.unlockingScript === undefined) throw new Error('fixture input is missing its script')
    const spend = new Spend({
      sourceTXID: sources[1].id('hex'),
      sourceOutputIndex: 0,
      sourceSatoshis: 3,
      lockingScript: sources[1].outputs[0].lockingScript,
      transactionVersion: tx.version,
      otherInputs: [tx.inputs[0], tx.inputs[2]],
      outputs: tx.outputs,
      inputIndex: 1,
      unlockingScript: active.unlockingScript,
      inputSequence: active.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    })
    expect(spend.toTransactionUint8Array()).toEqual(tx.toUint8Array())
  })

  it('rejects an active input index outside the reconstructed transaction', async () => {
    const { spend } = await buildSpend()
    spend.allInputs = undefined
    spend.inputIndex = 2
    expect(() => spend.toTransactionUint8Array()).toThrow('Spend input index is out of range')
  })
})
