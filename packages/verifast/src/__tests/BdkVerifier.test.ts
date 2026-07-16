import { Transaction, Script, P2PKH, PrivateKey, MerklePath } from '@bsv/sdk'
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
    delete tx.inputs[0].sourceTransaction!.merklePath
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
})
