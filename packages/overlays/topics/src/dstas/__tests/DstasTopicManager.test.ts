import { DstasTopicManager } from '../DstasTopicManager'
import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { DstasToken } from '@bsv/templates'
import { allowlistIssuerPolicy } from '../../admission/issuerPolicy'
import { DSTAS_PLAIN_HEX } from './dstas-fixture'

// A real DSTAS script (from dxs-bsv-token-sdk). The tokenId is the redemption
// pkh baked into the script, so two outputs of the same script share a tokenId.
const dstasScript = (): LockingScript => LockingScript.fromHex(DSTAS_PLAIN_HEX)
const FIXTURE_TOKEN_ID = DstasToken.decode(dstasScript()).tokenId

describe('DstasTopicManager', () => {
  const manager = new DstasTopicManager()

  it('admits an issuance output (no DSTAS inputs)', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([0])
  })

  it('admits a conserving transfer (out sats == in sats for the tokenId)', async () => {
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([0])
    expect(admitted.coinsToRetain).toEqual([0])
  })

  it('rejects inflation (out sats > in sats for a tokenId with inputs)', async () => {
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: dstasScript(), satoshis: 2000 })

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([])
  })

  it('ignores non-DSTAS outputs', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: LockingScript.fromHex('76a914' + 'ab'.repeat(20) + '88ac'), satoshis: 1000 })
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([])
  })

  describe('issuer policy', () => {
    it('rejects an issuance whose tokenId is not in the allowlist', async () => {
      const gated = new DstasTopicManager(allowlistIssuerPolicy([])) // empty allowlist
      const tx = new Transaction()
      tx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })
      const admitted = await gated.identifyAdmissibleOutputs(tx.toBEEF(), [])
      expect(admitted.outputsToAdmit).toEqual([])
    })

    it('admits an issuance whose tokenId is in the allowlist', async () => {
      const gated = new DstasTopicManager(allowlistIssuerPolicy([FIXTURE_TOKEN_ID]))
      const tx = new Transaction()
      tx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })
      const admitted = await gated.identifyAdmissibleOutputs(tx.toBEEF(), [])
      expect(admitted.outputsToAdmit).toEqual([0])
    })

    it('does not gate transfers — a conserving spend is admitted even under an empty allowlist', async () => {
      const gated = new DstasTopicManager(allowlistIssuerPolicy([])) // would reject issuance
      const sourceTx = new Transaction()
      sourceTx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
      tx.addOutput({ lockingScript: dstasScript(), satoshis: 1000 })
      const admitted = await gated.identifyAdmissibleOutputs(tx.toBEEF(), [0])
      expect(admitted.outputsToAdmit).toEqual([0]) // a transfer, not an issuance — not gated
    })
  })
})
