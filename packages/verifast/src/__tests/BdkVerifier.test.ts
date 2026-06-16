import { Transaction, Script, P2PKH, PrivateKey, MerklePath } from '@bsv/sdk'
import BdkVerifier, { type BdkWasmModule } from '../BdkVerifier.js'

// Minimal embind-style vector mock that records what was pushed.
class MockVector {
  items: number[] = []
  push_back (v: number): void { this.items.push(v) }
  delete (): void { /* freed */ }
}

interface MockCall {
  extendedTX: number[]
  utxoHeights: number[]
  blockHeight: number
  consensus: boolean
  customFlags: number[]
}

function makeMockModule (returnCode: number, calls: MockCall[]): BdkWasmModule {
  return {
    VectorUInt8: MockVector as any,
    VectorInt32: MockVector as any,
    VectorUInt32: MockVector as any,
    VerifyScript: (extendedTX: any, utxoHeights: any, blockHeight: number, consensus: boolean, customFlags: any) => {
      calls.push({
        extendedTX: [...extendedTX.items],
        utxoHeights: [...utxoHeights.items],
        blockHeight,
        consensus,
        customFlags: [...customFlags.items]
      })
      return returnCode
    }
  }
}

async function buildTx (): Promise<Transaction> {
  const key = PrivateKey.fromRandom()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 2, lockingScript: new P2PKH().lock(key.toAddress()) })
  await source.sign()
  source.merklePath = new MerklePath(777, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(key) })
  tx.addOutput({ satoshis: 1, lockingScript: new P2PKH().lock(key.toAddress()) })
  await tx.sign()
  return tx
}

describe('BdkVerifier', () => {
  it('marshals tx.toEF, utxo heights, flags and returns true on success code', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(1, calls))
    const tx = await buildTx()

    const ok = await verifier.verifyScripts({ tx, blockHeight: 800000, consensus: true, verifyFlags: 'P2SH' })

    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].extendedTX).toEqual(tx.toEF())
    expect(calls[0].blockHeight).toBe(800000)
    expect(calls[0].consensus).toBe(true)
    expect(calls[0].customFlags).toEqual([1]) // P2SH bit
    // one input, its source has merklePath height 777
    expect(calls[0].utxoHeights).toEqual([777])
  })

  it('returns false on a non-success code', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(0, calls))
    const tx = await buildTx()
    const ok = await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(ok).toBe(false)
  })

  it('uses 943816 height fallback for inputs whose source lacks a merklePath', async () => {
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => makeMockModule(1, calls))
    const tx = await buildTx()
    delete tx.inputs[0].sourceTransaction!.merklePath
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(calls[0].utxoHeights).toEqual([943816])
  })

  it('initialises the wasm module only once across calls', async () => {
    let factoryCalls = 0
    const calls: MockCall[] = []
    const verifier = new BdkVerifier(async () => { factoryCalls++; return makeMockModule(1, calls) })
    const tx = await buildTx()
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    await verifier.verifyScripts({ tx, blockHeight: 1, consensus: true })
    expect(factoryCalls).toBe(1)
  })
})
