import { Transaction, Script, P2PKH, PrivateKey, MerklePath, Spend, OP } from '@bsv/sdk'
import { jest } from '@jest/globals'
import BdkVerifier, {
  BdkErrorDomain,
  BdkVerificationError,
  DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD,
  isStandardP2PKHScript,
  isVeriFastCandidateScript,
  type BdkVerificationResult,
  type BdkWasmModule
} from '../BdkVerifier.js'

interface TestBackendGlobal {
  __bsvSdkAsyncCryptoBackendV1?: object
  __bsvSdkScriptVerificationBackendV1?: object
}

function clearDefaultBackends(): void {
  const registry = globalThis as typeof globalThis & TestBackendGlobal
  delete registry.__bsvSdkAsyncCryptoBackendV1
  delete registry.__bsvSdkScriptVerificationBackendV1
}

class MockVector {
  items: number[] = []
  push_back(value: number): void {
    this.items.push(value)
  }
  delete(): void {}
}

interface MockCall {
  extendedTX: number[]
  utxoHeights: number[]
  blockHeight: number
  consensus: boolean
  customFlags: number[]
}

function makeMockModule(result: BdkVerificationResult, calls: MockCall[]): BdkWasmModule {
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

async function buildTx(inputCount = 1): Promise<Transaction> {
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
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
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

function spendForInput(tx: Transaction, inputIndex = 0): Spend {
  const input = tx.inputs[inputIndex]
  const source = input.sourceTransaction
  if (source === undefined || input.unlockingScript === undefined)
    throw new Error('missing fixture source data')
  const sourceOutput = source.outputs[input.sourceOutputIndex]
  return new Spend({
    sourceTXID: input.sourceTXID ?? source.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: sourceOutput.satoshis ?? 0,
    lockingScript: sourceOutput.lockingScript,
    transactionVersion: tx.version,
    otherInputs: [],
    allInputs: tx.inputs,
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: input.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime
  })
}

describe('BdkVerifier', () => {
  afterEach(clearDefaultBackends)

  it('selects scripts over 100 bytes and signature opcodes without scanning pushed data', () => {
    const script = (bytes: Uint8Array): Script => Script.fromBinaryView(bytes)

    expect(DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD).toBe(100)
    expect(() => isVeriFastCandidateScript(script(Uint8Array.of(OP.OP_TRUE)), -1)).toThrow(
      'scriptByteThreshold must be a non-negative safe integer'
    )
    expect(isVeriFastCandidateScript(script(new Uint8Array(100).fill(OP.OP_TRUE)))).toBe(false)
    expect(isVeriFastCandidateScript(script(new Uint8Array(101).fill(OP.OP_TRUE)))).toBe(true)
    for (const opcode of [
      OP.OP_CHECKSIG,
      OP.OP_CHECKSIGVERIFY,
      OP.OP_CHECKMULTISIG,
      OP.OP_CHECKMULTISIGVERIFY
    ]) {
      expect(isVeriFastCandidateScript(script(Uint8Array.of(opcode)))).toBe(true)
    }
    expect(isVeriFastCandidateScript(script(Uint8Array.of(1, OP.OP_CHECKSIG)))).toBe(false)
    expect(isStandardP2PKHScript(new P2PKH().lock(new PrivateKey(42).toAddress()))).toBe(true)
    expect(isStandardP2PKHScript(Script.fromASM('OP_CHECKSIG'))).toBe(false)
  })

  it('loads once through preload and reports synchronous readiness', async () => {
    let factoryCalls = 0
    const verifier = new BdkVerifier(async () => {
      factoryCalls++
      return makeMockModule({ domain: 0, code: 0 }, [])
    })

    expect(verifier.isReady()).toBe(false)
    await Promise.all([verifier.preload(), verifier.preload()])
    expect(verifier.isReady()).toBe(true)
    expect(factoryCalls).toBe(1)
  })

  it('retries after a transient main-module load failure', async () => {
    let attempts = 0
    const verifier = new BdkVerifier(async () => {
      attempts++
      if (attempts === 1) throw new Error('transient load failure')
      return makeMockModule({ domain: 0, code: 0 }, [])
    })

    await expect(verifier.preload()).rejects.toThrow('transient load failure')
    await expect(verifier.preload()).resolves.toBeUndefined()
    expect(verifier.isReady()).toBe(true)
    expect(attempts).toBe(2)
  })

  it('makes disposal final', async () => {
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, []), {
      registerAsDefault: false
    })
    const tx = await buildTx()
    await verifier.preload()
    verifier.dispose()

    expect(verifier.isReady()).toBe(false)
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: false
      })
    ).toBe(false)
    await expect(
      verifier.verifyScripts({
        tx,
        blockHeight: 1,
        consensus: false
      })
    ).rejects.toThrow('disposed')
  })

  it('keeps a cold eligible transaction on JS, then selects WASM when ready', async () => {
    const tx = await buildTx()
    let resolveModule: (module: BdkWasmModule) => void = () => {}
    const pendingModule = new Promise<BdkWasmModule>(resolve => {
      resolveModule = resolve
    })
    let wasmCalls = 0
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScriptArray = () => {
      wasmCalls++
      return { domain: 0, code: 0 }
    }
    let factoryCalls = 0
    const verifier = new BdkVerifier(async () => {
      factoryCalls++
      return await pendingModule
    })

    await expect(tx.verify('scripts only', undefined, undefined, verifier)).resolves.toBe(true)
    expect(verifier.isReady()).toBe(false)
    expect(factoryCalls).toBe(0)
    expect(wasmCalls).toBe(0)

    resolveModule(module)
    await verifier.preload()
    await expect(tx.verify('scripts only', undefined, undefined, verifier)).resolves.toBe(true)
    expect(verifier.isReady()).toBe(true)
    expect(wasmCalls).toBe(1)
  })

  it('allows strict always mode to select the backend before it is warm', async () => {
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, []), {
      mode: 'always',
      registerAsDefault: false
    })
    expect(
      verifier.shouldVerifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true })
    ).toBe(true)
    expect(verifier.isReady()).toBe(false)
  })

  it('distinguishes version-1 policy routing from explicit consensus validation', async () => {
    const tx = await buildTx()
    const verifier = new BdkVerifier(async () => makeMockModule({ domain: 0, code: 0 }, []))
    await verifier.preload()
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: false
      })
    ).toBe(true)

    const source = tx.inputs[0].sourceTransaction
    if (source === undefined) throw new Error('missing fixture source')
    source.outputs[0].lockingScript = Script.fromASM('OP_CHECKSIG')
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: false
      })
    ).toBe(false)
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: true
      })
    ).toBe(true)

    tx.version = 2
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: true
      })
    ).toBe(true)
    expect(
      verifier.shouldVerifyScripts({
        tx,
        blockHeight: 1,
        consensus: true,
        memoryLimit: 1024
      })
    ).toBe(false)
  })

  it('rejects invalid adaptive routing options', () => {
    expect(() => new BdkVerifier({ scriptByteThreshold: -1 })).toThrow(RangeError)
    expect(() => new BdkVerifier({ scriptByteThreshold: 1.5 })).toThrow(RangeError)
  })

  it('applies the same cold-fallback and warm-selection policy to Spend.validateWith', async () => {
    const spend = spendForInput(await buildTx())
    let resolveModule: (module: BdkWasmModule) => void = () => {}
    const pendingModule = new Promise<BdkWasmModule>(resolve => {
      resolveModule = resolve
    })
    let wasmCalls = 0
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifySpendArray = () => {
      wasmCalls++
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => await pendingModule)

    await expect(spend.validateWith(verifier)).resolves.toBe(true)
    expect(wasmCalls).toBe(0)

    resolveModule(module)
    await verifier.preload()
    await expect(spend.validateWith(verifier)).resolves.toBe(true)
    expect(wasmCalls).toBe(1)
  })

  it('uses the bulk-copy ABI when the module provides it', async () => {
    const calls: MockCall[] = []
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScript = () => {
      throw new Error('legacy vector ABI should not be called')
    }
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

    await expect(
      verifier.verifyScripts({ tx, blockHeight: 800000, consensus: true })
    ).resolves.toBe(true)
    expect(calls).toEqual([
      {
        extendedTX: tx.toEF(),
        utxoHeights: [777, 777],
        blockHeight: 800000,
        consensus: true,
        customFlags: []
      }
    ])
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
      await expect(
        verifier.verifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true })
      ).resolves.toBe(false)
    }
  })

  it('throws a typed error for BDK exception and unknown domains', async () => {
    for (const domain of [BdkErrorDomain.EXCEPTION, 99]) {
      const verifier = new BdkVerifier(async () => makeMockModule({ domain, code: 0 }, []))
      await expect(
        verifier.verifyScripts({ tx: await buildTx(), blockHeight: 1, consensus: true })
      ).rejects.toBeInstanceOf(BdkVerificationError)
    }
  })

  it('exposes BDK domain and code through the detailed API', async () => {
    const expected = { domain: BdkErrorDomain.SCRIPT, code: 39 }
    const verifier = new BdkVerifier(async () => makeMockModule(expected, []))
    await expect(
      verifier.verifyScriptsDetailed({ tx: await buildTx(), blockHeight: 1, consensus: true })
    ).resolves.toEqual(expected)
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
    await expect(
      verifier.verifyScriptsFromEF({
        extendedTransaction: ef,
        utxoHeights: [100],
        blockHeight: 200,
        consensus: false
      })
    ).resolves.toBe(true)
    expect(calls).toEqual([ef])
  })

  it.each(['ttn', 'teratestnet', 'terratestnet'] as const)(
    'maps the %s alias to TeraTestNet',
    async network => {
      const module = makeMockModule({ domain: 0, code: 0 }, [])
      module.VerifyScriptArrayNetwork = (
        _bytes,
        _heights,
        _blockHeight,
        _consensus,
        _flags,
        networkId
      ) => {
        expect(networkId).toBe(4)
        return { domain: 0, code: 0 }
      }
      const verifier = new BdkVerifier(async () => module, { network })
      await expect(
        verifier.verifyScriptsFromEF({
          extendedTransaction: Uint8Array.of(1),
          utxoHeights: [1],
          blockHeight: 1,
          consensus: true
        })
      ).resolves.toBe(true)
    }
  )

  it('keeps Tera Scaling Test Network distinct from TeraTestNet aliases', async () => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifyScriptArrayNetwork = (
      _bytes,
      _heights,
      _blockHeight,
      _consensus,
      _flags,
      networkId
    ) => {
      expect(networkId).toBe(5)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module, { network: 'tstn' })
    await expect(
      verifier.verifyScriptsFromEF({
        extendedTransaction: Uint8Array.of(1),
        utxoHeights: [1],
        blockHeight: 1,
        consensus: true
      })
    ).resolves.toBe(true)
  })

  it('packs a transaction batch into one ABI call and preserves result order', async () => {
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    let batchCalls = 0
    module.VerifyScriptBatchArray = (
      transactions,
      offsets,
      heights,
      heightOffsets,
      blockHeights,
      consensus,
      flags,
      flagOffsets,
      network
    ) => {
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
    await expect(
      verifier.verifyScriptsBatchFromEF([
        {
          extendedTransaction: Uint8Array.of(1, 2),
          utxoHeights: [10],
          blockHeight: 30,
          consensus: true
        },
        {
          extendedTransaction: Uint8Array.of(3, 4, 5),
          utxoHeights: [20, 21],
          blockHeight: 31,
          consensus: false
        }
      ])
    ).resolves.toEqual([true, false])
    expect(batchCalls).toBe(1)
  })

  it('treats maxBatchBytes as a soft target for oversized singleton items', async () => {
    const tx = await buildTx()
    const spend = spendForInput(tx)
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    const calls: string[] = []
    module.VerifyScriptBatchArray = () => {
      calls.push('script')
      return Int32Array.from([0, 0])
    }
    module.VerifySpendBatchArray = () => {
      calls.push('spend')
      return Int32Array.from([0, 0])
    }
    module.VerifyDigestBatchArray = () => {
      calls.push('digest')
      return Uint8Array.of(1)
    }
    const verifier = new BdkVerifier(async () => module, {
      maxBatchBytes: 1,
      registerAsDefault: false
    })

    await expect(
      verifier.verifyScriptsBatchFromEF([
        {
          extendedTransaction: Uint8Array.of(1, 2),
          utxoHeights: [10],
          blockHeight: 30,
          consensus: true
        }
      ])
    ).resolves.toEqual([true])
    await expect(verifier.verifySpendsBatch([{ spend, consensus: true }])).resolves.toEqual([true])
    await expect(
      verifier.verifyDigestBatch([
        {
          publicKey: Uint8Array.of(2, 3),
          digest: new Uint8Array(32),
          signature: Uint8Array.of(4, 5)
        }
      ])
    ).resolves.toEqual([true])
    expect(calls).toEqual(['script', 'spend', 'digest'])
  })

  it('serializes a shared transaction once for a multi-input Spend batch', async () => {
    const tx = await buildTx(2)
    const spends = [spendForInput(tx, 0), spendForInput(tx, 1)]
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifySpendBatchArray = () => Int32Array.from([0, 0, 0, 0])
    const verifier = new BdkVerifier(async () => module, { registerAsDefault: false })
    const serialize = jest.spyOn(Spend.prototype, 'toTransactionUint8Array')

    await expect(
      verifier.verifySpendsBatch(spends.map(spend => ({ spend, consensus: true })))
    ).resolves.toEqual([true, true])
    expect(serialize).toHaveBeenCalledTimes(1)
    serialize.mockRestore()
  })

  it('validates a Spend directly and through Spend.validateWith', async () => {
    const tx = await buildTx()
    const input = tx.inputs[0]
    const source = input.sourceTransaction
    if (source === undefined) throw new Error('missing fixture source data')
    const sourceOutput = source.outputs[input.sourceOutputIndex]
    const spend = spendForInput(tx)
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    let calls = 0
    const consensusValues: boolean[] = []
    module.VerifySpendArray = (
      transaction,
      inputIndex,
      lockingScript,
      sourceSatoshis,
      utxoHeight,
      blockHeight,
      consensus,
      hasFlags,
      flags,
      network
    ) => {
      calls++
      expect(transaction).toEqual(tx.toUint8Array())
      expect(inputIndex).toBe(0)
      expect(lockingScript).toEqual(sourceOutput.lockingScript.toUint8Array())
      expect(sourceSatoshis).toBe(sourceOutput.satoshis)
      expect(utxoHeight).toBe(943816)
      expect(blockHeight).toBe(943816)
      consensusValues.push(consensus)
      expect(hasFlags).toBe(false)
      expect(flags).toBe(0)
      expect(network).toBe(0)
      return { domain: 0, code: 0 }
    }
    const verifier = new BdkVerifier(async () => module)
    await expect(verifier.verifySpend(spend, { consensus: false })).resolves.toBe(true)
    await expect(spend.validateWith(verifier, { consensus: true })).resolves.toBe(true)
    expect(calls).toBe(2)
    expect(consensusValues).toEqual([false, true])
  })

  it('rejects unsafe source satoshi values consistently before packing', async () => {
    const spend = spendForInput(await buildTx())
    spend.sourceSatoshis = 1.5
    const module = makeMockModule({ domain: 0, code: 0 }, [])
    module.VerifySpendArray = () => ({ domain: 0, code: 0 })
    module.VerifySpendBatchArray = () => new Int32Array()
    const verifier = new BdkVerifier(async () => module)

    await expect(verifier.verifySpend(spend)).rejects.toThrow('non-negative safe integer')
    await expect(verifier.verifySpendsBatch([{ spend }])).rejects.toThrow(
      'non-negative safe integer'
    )
  })
})
