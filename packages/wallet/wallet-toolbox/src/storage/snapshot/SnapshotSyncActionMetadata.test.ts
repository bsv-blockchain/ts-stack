import { createSyncMap } from '../schema/entities/EntityBase'
import { planTransactionMerge } from '../schema/entities/EntityTransaction'
import { planOutputMerge } from '../schema/entities/EntityOutput'
import { snapshotSyncTransactionMetadata, snapshotSyncOutputMetadata } from './SnapshotSyncActionMetadata'

const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-02-01') },
  binary = Object.freeze({ kind: 'binary' as const, bytes: 100000000, sha256: 'ab'.repeat(32) }),
  text = Object.freeze({ kind: 'utf16le' as const, bytes: 200000000, sha256: 'cd'.repeat(32) })

describe('complete descriptor action metadata (authored before qualification)', () => {
  it('retains newer ordinary payload and advances an older target-winner lifecycle', () => {
    const fields = {
        ...dates,
        transactionId: 8,
        userId: 1,
        status: 'nosend',
        reference: 'current',
        isOutgoing: true,
        satoshis: 3,
        updated_at: new Date('2026-03-01'),
        noSendExpiryState: 'reclaimed',
        noSendExpiryReclaimTxid: '44'.repeat(32)
      },
      current = snapshotSyncTransactionMetadata(fields, { rawTx: binary, description: text }),
      incoming = snapshotSyncTransactionMetadata(
        {
          ...fields,
          transactionId: 26,
          userId: 77,
          updated_at: dates.updated_at,
          noSendExpiryState: 'target-won',
          satoshis: 999,
          reference: 'foreign',
          description: 'older'
        },
        {}
      ),
      result = planTransactionMerge(current, incoming, createSyncMap())
    expect(result!.row.reference).toBe('current')
    expect(result!.row.rawTx).toBe(binary)
    expect(result!.row.description).toBe(text)
    expect(result!.row.satoshis).toBe(3)
    expect(result!.row.noSendExpiryState).toBe('target-won')
    expect(result!.quarantineReclaimTxid).toBe('44'.repeat(32))
    expect(result!.row.updated_at).toEqual(new Date('2026-03-01'))
  })
  it('remaps mutable output relationships and retains its immutable identity and derivation', () => {
    const fields = {
        ...dates,
        outputId: 5,
        userId: 1,
        transactionId: 9,
        spendable: false,
        change: true,
        vout: 0,
        satoshis: 2,
        providedBy: 'you-and-storage',
        type: 'P2PKH',
        purpose: 'change',
        outputDescription: 'old',
        txid: '44'.repeat(32)
      },
      current = snapshotSyncOutputMetadata(fields, { derivationPrefix: text }),
      incoming = snapshotSyncOutputMetadata(
        {
          ...fields,
          updated_at: new Date('2026-03-01'),
          outputId: 51,
          userId: 77,
          transactionId: 27,
          basketId: 28,
          spentBy: 29,
          satoshis: 999,
          txid: '55'.repeat(32),
          outputDescription: 'new'
        },
        { lockingScript: binary }
      ),
      map = createSyncMap()
    map.transaction.idMap[27] = 9
    map.transaction.idMap[29] = 10
    map.outputBasket.idMap[28] = 7
    const result = planOutputMerge(current, incoming, map)!
    expect(result.outputId).toBe(5)
    expect(result.userId).toBe(1)
    expect(result.transactionId).toBe(9)
    expect(result.txid).toBe('44'.repeat(32))
    expect(result.satoshis).toBe(2)
    expect(result.derivationPrefix).toBe(text)
    expect(result.basketId).toBe(7)
    expect(result.spentBy).toBe(10)
    expect(result.lockingScript).toBe(binary)
  })
  it('rejects incomplete required fields, hydrated payloads, unknown columns and invalid enums', () => {
    const fields = {
      ...dates,
      transactionId: 8,
      userId: 1,
      status: 'unprocessed',
      reference: 'ref',
      isOutgoing: false,
      satoshis: 1,
      description: ''
    }
    expect(() => snapshotSyncTransactionMetadata({ ...fields, description: undefined }, {})).toThrow()
    expect(() => snapshotSyncTransactionMetadata({ ...fields, rawTx: [] }, {})).toThrow()
    expect(() => snapshotSyncTransactionMetadata({ ...fields, noSendExpiryState: 'arbitrary' }, {})).toThrow()
    expect(() => snapshotSyncTransactionMetadata({ ...fields, invented: true }, {})).toThrow()
    expect(() => snapshotSyncTransactionMetadata(fields, { rawTx: text })).toThrow()
  })
})
