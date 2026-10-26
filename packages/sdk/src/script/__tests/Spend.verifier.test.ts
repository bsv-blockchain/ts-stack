import { P2PKH, PrivateKey, Script, Spend, Transaction } from '../../../mod'
import {
  registerScriptVerificationBackend,
  unregisterScriptVerificationBackend
} from '../../transaction/ScriptVerificationBackend'

async function buildSpend(): Promise<{ spend: Spend; tx: Transaction }> {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
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
  it('does not let unrelated code replace an active verifier backend', () => {
    const first = {
      verifyScripts: async () => true,
      verifySpend: async () => true
    }
    const second = {
      verifyScripts: async () => true,
      verifySpend: async () => true
    }
    registerScriptVerificationBackend(first)
    try {
      expect(() => registerScriptVerificationBackend(second)).toThrow(
        'A different script verification backend is already registered'
      )
      unregisterScriptVerificationBackend(second)
      expect(() => registerScriptVerificationBackend(first)).not.toThrow()
    } finally {
      unregisterScriptVerificationBackend(first)
    }
  })

  it('serializes the exact ordinary transaction represented by the Spend', async () => {
    const { spend, tx } = await buildSpend()
    expect(spend.toTransactionUint8Array()).toEqual(tx.toUint8Array())
  })

  it('delegates validateWith without masking backend failures', async () => {
    const { spend } = await buildSpend()
    const verifier = { verifySpend: jest.fn(async () => false) }
    await expect(spend.validateWith(verifier)).resolves.toBe(false)
    const verifiedSpend = verifier.verifySpend.mock.calls[0][0]
    expect(verifiedSpend).not.toBe(spend)
    expect(verifiedSpend.toTransactionUint8Array()).toEqual(spend.toTransactionUint8Array())

    const failure = new Error('backend unavailable')
    await expect(
      spend.validateWith({
        verifySpend: async () => {
          throw failure
        }
      })
    ).rejects.toBe(failure)
  })

  it('rejects truthy non-boolean asynchronous and synchronous verifier verdicts', async () => {
    const { spend } = await buildSpend()
    await expect(
      spend.validateWith({
        verifySpend: async () => 'false' as unknown as boolean
      })
    ).rejects.toThrow('Spend verifier returned a non-boolean verdict')

    const backend = {
      verifyScripts: async () => true,
      verifySpend: async () => true,
      verifySpendSync: () => 'false' as unknown as boolean,
      shouldVerifySpend: () => true
    }
    registerScriptVerificationBackend(backend)
    try {
      expect(() => spend.validate()).toThrow(
        'The selected script-verification backend rejected the spend.'
      )
    } finally {
      unregisterScriptVerificationBackend(backend)
    }
  })

  it('passes explicit consensus context through every backend hook', async () => {
    const { spend } = await buildSpend()
    const context = { consensus: true, blockHeight: 943816 }
    const verifier = {
      shouldVerifySpend: jest.fn(() => true),
      verifySpend: jest.fn(async () => true)
    }

    await expect(spend.validateWith(verifier, context)).resolves.toBe(true)
    const selectedSpend = verifier.shouldVerifySpend.mock.calls[0][0]
    const selectedContext = verifier.shouldVerifySpend.mock.calls[0][1]
    expect(selectedSpend).not.toBe(spend)
    expect(selectedSpend.toTransactionUint8Array()).toEqual(spend.toTransactionUint8Array())
    expect(selectedContext).not.toBe(context)
    expect(selectedContext).toEqual(context)
    expect(verifier.verifySpend).toHaveBeenCalledWith(selectedSpend, selectedContext)
  })

  it('owns Spend and policy context while asynchronous verification is pending', async () => {
    const { spend } = await buildSpend()
    const context = { consensus: true, blockHeight: 943816, verifyFlags: ['GENESIS'] }
    const originalOutput = spend.outputs[0].satoshis
    let resume!: () => void
    const gate = new Promise<void>(resolve => {
      resume = resolve
    })
    let verifiedSpend: Spend | undefined
    let verifiedContext: typeof context | undefined
    const pending = spend.validateWith(
      {
        verifySpend: async (snapshot, snapshotContext) => {
          verifiedSpend = snapshot
          verifiedContext = snapshotContext as typeof context
          await gate
          return true
        }
      },
      context
    )

    spend.outputs[0].satoshis = (originalOutput ?? 0) + 100
    context.consensus = false
    context.verifyFlags[0] = 'SUBSTITUTED'
    resume()

    await expect(pending).resolves.toBe(true)
    expect(verifiedSpend).not.toBe(spend)
    expect(verifiedSpend?.outputs[0].satoshis).toBe(originalOutput)
    expect(verifiedContext).toEqual({
      consensus: true,
      blockHeight: 943816,
      utxoHeight: undefined,
      verifyFlags: ['GENESIS']
    })
  })

  it('uses the JavaScript validator when an adaptive backend declines', async () => {
    const { spend } = await buildSpend()
    const verifySpend = jest.fn(async () => false)
    const shouldVerifySpend = jest.fn(() => false)

    await expect(spend.validateWith({ shouldVerifySpend, verifySpend })).resolves.toBe(true)
    expect(shouldVerifySpend).toHaveBeenCalledTimes(1)
    expect(shouldVerifySpend.mock.calls[0][0]).not.toBe(spend)
    expect(verifySpend).not.toHaveBeenCalled()
  })

  it('keeps a selected adaptive backend authoritative', async () => {
    const { spend } = await buildSpend()
    const failure = new Error('selected backend failed')
    await expect(
      spend.validateWith({
        shouldVerifySpend: () => true,
        verifySpend: async () => {
          throw failure
        }
      })
    ).rejects.toBe(failure)
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
      const selectedSpend = backend.shouldVerifySpend.mock.calls[0][0]
      expect(selectedSpend).not.toBe(spend)
      expect(selectedSpend.toTransactionUint8Array()).toEqual(spend.toTransactionUint8Array())
      expect(backend.verifySpendSync).toHaveBeenCalledWith(selectedSpend)
    } finally {
      unregisterScriptVerificationBackend(backend)
    }
  })

  it('does not expose live Spend or policy objects to a synchronous backend', async () => {
    const { spend } = await buildSpend()
    const originalOutput = spend.outputs[0].satoshis
    const context = { consensus: true, verifyFlags: ['GENESIS'] }
    const backend = {
      verifyScripts: async () => true,
      verifySpend: async () => true,
      shouldVerifySpend: jest.fn((snapshot: Spend, snapshotContext: typeof context) => {
        snapshot.outputs[0].satoshis = 999
        snapshotContext.verifyFlags[0] = 'SUBSTITUTED'
        return true
      }),
      verifySpendSync: jest.fn(() => true)
    }
    registerScriptVerificationBackend(backend)
    try {
      expect(spend.validate(context)).toBe(true)
      expect(spend.outputs[0].satoshis).toBe(originalOutput)
      expect(context.verifyFlags).toEqual(['GENESIS'])
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
    sources.forEach((source, index) =>
      tx.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM(`OP_${index + 1}`),
        sequence: 100 + index
      })
    )
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
