import { Transaction, Script, P2PKH, PrivateKey, MerklePath, Spend } from '@bsv/sdk'
import BdkVerifier, {
  BdkErrorDomain,
  BdkVerificationError,
  type BdkVerificationResult,
  type BdkWasmModule
} from '../BdkVerifier.js'

class MockVector {
  items: number[] = []
  push_back (value: number): void { this.items.push(value) }
  delete (): void {}
}

interface MockCall {
  extendedTX: number[]
  utxoHeights: number[]
  blockHeight: number
  consensus: boolean
  customFlags: number[]
}

function makeMockModule (result: BdkVerificationResult, calls: MockCall[]): BdkWasmModule {
  return {
    VectorUInt8: MockVector,
    VectorInt32: MockVector,
    VectorUInt32: MockVector,
    VerifyScript: (extendedTX, utxoHeights, blockHeight, consensus, customFlags) => {
      calls.push({
        extendedTX: [...(extendedTX as MockVector).items],
        utxoHeights: [...(utxoHeights as MockVector).items],
        blockHeight,
        consensus,
        customFlags: [...(customFlags as MockVector).items]
      })
      return result
    }
  }
}

async function buildTx (inputCount = 1): Promise<Transaction> {
  const key = new PrivateKey(42)
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  for (let i = 0; i < inputCount; i++) {
    source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  }
  source.merklePath = new MerklePath(777, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  const tx = new Transaction()
  for (let i = 0; i < inputCount; i++) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: i,
      unlockingScriptTemplate: new P2PKH().unlock(key)
    })
  }
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('BdkVerifier', () => {
  it('uses the bulk-copy ABI when the module provides it', async () => {
    const calls: MockCall[] = []
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScript = () => { throw new Error('legacy vector ABI should not be called') }
    module.VerifyScriptArray = (extendedTX, utxoHeights, blockHeight, consensus, customFlags) => {
      calls.push({
        extendedTX: Array.from(extendedTX),
        utxoHeights: Array.from(utxoHeights),
        blockHeight,
        consensus,
        customFlags: Array.from(customFlags)
      })
      return { domain: 0, code: 0 }
    }
    const tx = await buildTx(2)
    const verifier = new BdkVerifier(async () => module)

    await expect(verifier.verifyScripts({ tx, blockHeight: 800000, consensus: true }))
      .resolves.toBe(true)
    expect(calls).toEqual([{
      extendedTX: tx.toEF(),
      utxoHeights: [777, 777],
      blockHeight: 800000,
      consensus: true,
      customFlags: []
    }])
  })

  it('marshals EF, heights, and one custom flag word per input', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, calls))
    const tx = await buildTx(3)

    const ok = await verifier.verifyScripts({
      tx,
      blockHeight: 800000,
      consensus: true,
      verifyFlags: 'P2SH,MINIMALDATA'
    })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].extendedTX).toEqual(tx.toEF())
    expect(calls[0].utxoHeights).toEqual([777, 777, 777])
    expect(calls[0].blockHeight).toBe(800000)
    expect(calls[0].consensus).toBe(true)
    expect(calls[0].customFlags).toEqual([65, 65, 65])
  })

  it('leaves custom flags empty when the caller does not override BDK policy', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, calls))
    await verifier.verifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true })
    expect(calls[0].customFlags).toEqual([])
  })

  it('returns false for script and DoS domains', async () => {
    for (const domain of [BdkErrorDomain.SCRIPT, BdkErrorDomain.DOS]) {
      const verifier = new BdkVerifier(async () => makeMockModule({ domain, code: 39 }, []))
      await expect(verifier.verifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true }))
        .resolves.toBe(false)
    }
  })

  it('throws a typed error for BDK exception and unknown domains', async () => {
    for (const domain of [BdkErrorDomain.EXCEPTION, 99]) {
      const verifier = new BdkVerifier(async () => makeMockModule({ domain, code: 0 }, []))
      await expect(verifier.verifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true }))
        .rejects.toBeInstanceOf(BdkVerificationError)
    }
  })

  it('exposes BDK domain and code through the detailed API', async () => {
    const expected = { domain: BdkErrorDomain.SCRIPT, code: 39 }
    const verifier = new BdkVerifier(async () => makeMockModule(expected, []))
    await expect(verifier.verifyScriptsDetailed({ tx: await buildTx(), blockHeight: 1, consensus: true }))
      .resolves.toEqual(expected)
  })

  it('uses the Chronicle height fallback for an unmined source', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, calls))
    const tx = await buildTx()
    const sourceTransaction = tx.inputs[0].sourceTransaction
    if (sourceTransaction === undefined) throw new Error('test transaction is missing its source')
    delete sourceTransaction.merklePath
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(calls[0].utxoHeights).toEqual([943816])
  })

  it('initialises the module once across calls', async () => {
    let factoryCalls = 0
    const verifier = new BdkVerifier(async () => {
      factoryCalls++
      return makeMockModule({ domain: 0, code: 0 }, [])
    })
    const tx = await buildTx()
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(factoryCalls).toBe(1)
  })

  it('verifies caller-owned pre-serialized EF bytes without serializing a Transaction', async () => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    const ef = Uint8Array.of(1, 2, 3)
    const calls: Uint8Array[] = []
    module.VerifyScriptArrayNetwork = (bytes, heights, blockHeight, consensus, flags, network) => {
      calls.push(bytes)
      expect(Array.from(heights)).toEqual([100])
      expect(blockHeight).toBe(200)
      expect(consensus).toBe(false)
      expect(flags).toHaveLength(0)
      expect(network).toBe(1)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module, { network: 'test' })
    await expect(verifier.verifyScriptsFromEF({
      extendedTransaction: ef,
      utxoHeights: [100],
      blockHeight: 200,
      consensus: false
    })).resolves.toBe(true)
    expect(calls).toEqual([ef])
  })

  it.each(['ttn', 'teratestnet', 'terratestnet'] as const)('maps the %s alias to TeraTestNet', async (network) => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScriptArrayNetwork = (_bytes, _heights, _blockHeight, _consensus, _flags, networkId) => {
      expect(networkId).toBe(4)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module, { network })
    await expect(verifier.verifyScriptsFromEF({
      extendedTransaction: Uint8Array.of(1),
      utxoHeights: [1],
      blockHeight: 1,
      consensus: true
    })).resolves.toBe(true)
  })

  it('keeps Tera Scaling Test Network distinct from TeraTestNet aliases', async () => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScriptArrayNetwork = (_bytes, _heights, _blockHeight, _consensus, _flags, networkId) => {
      expect(networkId).toBe(5)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module, { network: 'tstn' })
    await expect(verifier.verifyScriptsFromEF({
      extendedTransaction: Uint8Array.of(1),
      utxoHeights: [1],
      blockHeight: 1,
      consensus: true
    })).resolves.toBe(true)
  })

  it('packs a transaction batch into one ABI call and preserves result order', async () => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    let batchCalls = 0
    module.VerifyScriptBatchArray = (transactions, offsets, heights, heightOffsets, blockHeights, consensus, flags, flagOffsets, network) => {
      batchCalls++
      expect(Array.from(offsets)).toEqual([0, 2, 5])
      expect(Array.from(transactions)).toEqual([1, 2, 3, 4, 5])
      expect(Array.from(heights)).toEqual([10, 20, 21])
      expect(Array.from(heightOffsets)).toEqual([0, 1, 3])
      expect(Array.from(blockHeights)).toEqual([30, 31])
      expect(Array.from(consensus)).toEqual([1, 0])
      expect(flags).toHaveLength(0)
      expect(Array.from(flagOffsets)).toEqual([0, 0, 0])
      expect(network).toBe(0)
      return Int32Array.from([0, 0, 1, 39])
    }
    const verifier = new BdkVerifier(async () => module)
    await expect(verifier.verifyScriptsBatchFromEF([
      { extendedTransaction: Uint8Array.of(1, 2), utxoHeights: [10], blockHeight: 30, consensus: true },
      { extendedTransaction: Uint8Array.of(3, 4, 5), utxoHeights: [20, 21], blockHeight: 31, consensus: false }
    ])).resolves.toEqual([true, false])
    expect(batchCalls).toBe(1)
  })

  it('validates a Spend directly and through Spend.validateWith', async () => {
    const tx = await buildTx()
    const input = tx.inputs[0]
    const source = input.sourceTransaction
    if (source === undefined || input.unlockingScript === undefined) throw new Error('missing fixture source data')
    const sourceOutput = source.outputs[input.sourceOutputIndex]
    const spend = new Spend({
      sourceTXID: input.sourceTXID ?? source.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sourceOutput.satoshis ?? 0,
      lockingScript: sourceOutput.lockingScript,
      transactionVersion: tx.version,
      otherInputs: [],
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex: 0,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime
    })
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    let calls = 0
    module.VerifySpendArray = (transaction, inputIndex, lockingScript, sourceSatoshis, utxoHeight, blockHeight, consensus, hasFlags, flags, network) => {
      calls++
      expect(transaction).toEqual(tx.toUint8Array())
      expect(inputIndex).toBe(0)
      expect(lockingScript).toEqual(sourceOutput.lockingScript.toUint8Array())
      expect(sourceSatoshis).toBe(sourceOutput.satoshis)
      expect(utxoHeight).toBe(943816)
      expect(blockHeight).toBe(943816)
      expect(consensus).toBe(true)
      expect(hasFlags).toBe(false)
      expect(flags).toBe(0)
      expect(network).toBe(0)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module)
    await expect(verifier.verifySpend(spend)).resolves.toBe(true)
    await expect(spend.validateWith(verifier)).resolves.toBe(true)
    expect(calls).toBe(2)
  })
})
