import { StasTopicManager } from '../StasTopicManager'
import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'

// Synthetic classic STAS locking script: 76a914 <owner> 88ac69 <engine> 6a <flags> <symbol>
function stasScript (ownerHex: string, symbol = 'TEST'): LockingScript {
  const engine = 'ac'.repeat(8) // opaque filler, free of 0x6a
  const symBytes = Buffer.from(symbol, 'utf8').toString('hex')
  const symPush = (symBytes.length / 2).toString(16).padStart(2, '0') + symBytes
  return LockingScript.fromHex(`76a914${ownerHex}88ac69${engine}6a0100${symPush}`)
}

const OWNER_A = 'ab'.repeat(20)
const OWNER_B = 'cd'.repeat(20)

describe('StasTopicManager', () => {
  const manager = new StasTopicManager()

  it('admits an issuance output (no STAS inputs)', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: stasScript(OWNER_A), satoshis: 1000 })
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([0])
  })

  it('admits a conserving transfer (out sats == in sats for the asset)', async () => {
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: stasScript(OWNER_A), satoshis: 1000 })

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: stasScript(OWNER_B), satoshis: 1000 })

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([0])
    expect(admitted.coinsToRetain).toEqual([0])
  })

  it('rejects inflation (out sats > in sats for an asset with inputs)', async () => {
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: stasScript(OWNER_A), satoshis: 1000 })

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: stasScript(OWNER_B), satoshis: 2000 }) // inflated

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([])
  })

  it('ignores non-STAS outputs', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: LockingScript.fromHex(`76a914${OWNER_A}88ac`), satoshis: 1000 }) // plain P2PKH
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([])
  })
})
