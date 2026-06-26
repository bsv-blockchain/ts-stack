import { Bsv21TopicManager } from '../Bsv21TopicManager'
import { LockingScript, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { allowlistIssuerPolicy } from '../../admission/issuerPolicy'

const OWNER_A = 'ab'.repeat(20)
const OWNER_B = 'cd'.repeat(20)

function utf8ToHex (s: string): string {
  return Utils.toArray(s, 'utf8').map(b => b.toString(16).padStart(2, '0')).join('')
}
function push (bytesHex: string): string {
  const len = bytesHex.length / 2
  if (len <= 0x4b) return len.toString(16).padStart(2, '0') + bytesHex
  return '4c' + len.toString(16).padStart(2, '0') + bytesHex
}
function bsv21Script (payload: Record<string, string>, owner = OWNER_A): LockingScript {
  const envelope =
    '0063' + push(utf8ToHex('ord')) + '51' + push(utf8ToHex('application/bsv-20')) +
    '00' + push(utf8ToHex(JSON.stringify(payload))) + '68'
  return LockingScript.fromHex(envelope + '76a914' + owner + '88ac')
}

describe('Bsv21TopicManager', () => {
  const manager = new Bsv21TopicManager()

  it('admits a deploy+mint output (issuance)', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '1000', dec: '0' }), satoshis: 1 })
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([0])
  })

  it('admits a conserving transfer (out amt == in amt for the tokenId)', async () => {
    const mint = new Transaction()
    mint.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '1000' }), satoshis: 1 })
    const tokenId = `${mint.id('hex')}_0`

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: mint, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'transfer', id: tokenId, amt: '600' }, OWNER_B), satoshis: 1 })
    tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'transfer', id: tokenId, amt: '400' }, OWNER_A), satoshis: 1 })

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([0, 1])
  })

  it('rejects inflation (out amt > in amt for a tokenId with inputs)', async () => {
    const mint = new Transaction()
    mint.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '1000' }), satoshis: 1 })
    const tokenId = `${mint.id('hex')}_0`

    const tx = new Transaction()
    tx.addInput({ sourceTransaction: mint, sourceOutputIndex: 0, unlockingScript: new UnlockingScript([]) })
    tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'transfer', id: tokenId, amt: '1500' }, OWNER_B), satoshis: 1 })

    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [0])
    expect(admitted.outputsToAdmit).toEqual([])
  })

  it('ignores non-BSV-21 outputs', async () => {
    const tx = new Transaction()
    tx.addOutput({ lockingScript: LockingScript.fromHex(`76a914${OWNER_A}88ac`), satoshis: 1 })
    const admitted = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(admitted.outputsToAdmit).toEqual([])
  })

  describe('issuer policy', () => {
    it('rejects a mint whose tokenId is not in the allowlist', async () => {
      const gated = new Bsv21TopicManager(allowlistIssuerPolicy([]))
      const tx = new Transaction()
      tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '1000', dec: '0' }), satoshis: 1 })
      const admitted = await gated.identifyAdmissibleOutputs(tx.toBEEF(), [])
      expect(admitted.outputsToAdmit).toEqual([])
    })

    it('admits a mint whose tokenId (outpoint) is in the allowlist', async () => {
      const tx = new Transaction()
      tx.addOutput({ lockingScript: bsv21Script({ p: 'bsv-20', op: 'deploy+mint', amt: '1000', dec: '0' }), satoshis: 1 })
      const tokenId = `${tx.id('hex')}_0`
      const gated = new Bsv21TopicManager(allowlistIssuerPolicy([tokenId]))
      const admitted = await gated.identifyAdmissibleOutputs(tx.toBEEF(), [])
      expect(admitted.outputsToAdmit).toEqual([0])
    })
  })
})
