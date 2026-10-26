import { Beef, LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { classifyBroadcastInputSpendEvidence } from '../attemptToPostReqsToNetwork'

function fixture(): { beef: Beef; spend: Transaction; outpoint: string } {
  const source = new Transaction()
  source.addOutput({ satoshis: 1000, lockingScript: new LockingScript([0x51]) })
  const spend = new Transaction()
  spend.addInput({ sourceTransaction: source, sourceOutputIndex: 0, unlockingScript: new UnlockingScript() })
  spend.addOutput({ satoshis: 900, lockingScript: new LockingScript([0x51]) })
  const beef = new Beef()
  beef.mergeTransaction(source)
  beef.mergeTransaction(spend)
  return { beef, spend, outpoint: `${source.id('hex')}.0` }
}

describe('broadcast double-spend confirmation evidence', () => {
  test.each([
    [false, { spent: 1, unspent: 0, unknown: 0 }],
    [true, { spent: 0, unspent: 1, unknown: 0 }]
  ])('counts an exact conclusive UTXO verdict (%s)', async (isUtxo, expected) => {
    const { beef, spend, outpoint } = fixture()
    const services = {
      hashOutputScript: jest.fn().mockReturnValue('aa'.repeat(32)),
      getUtxoStatus: jest.fn().mockResolvedValue({ name: 'configured', status: 'success', isUtxo, details: [] })
    }

    await expect(classifyBroadcastInputSpendEvidence(spend, beef, services)).resolves.toEqual(expected)
    expect(services.getUtxoStatus).toHaveBeenCalledWith('aa'.repeat(32), undefined, outpoint)
  })

  test('treats contradictory evidence as unknown rather than spent', async () => {
    const { beef, spend, outpoint } = fixture()
    const services = {
      hashOutputScript: () => 'aa'.repeat(32),
      getUtxoStatus: async () => ({
        name: 'configured',
        status: 'success' as const,
        isUtxo: false,
        details: [{ txid: outpoint.slice(0, 64), index: 0, height: 1, satoshis: 1 }]
      })
    }

    await expect(classifyBroadcastInputSpendEvidence(spend, beef, services)).resolves.toEqual({
      spent: 0,
      unspent: 0,
      unknown: 1
    })
  })
})
