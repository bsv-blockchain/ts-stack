import { FindStaleMerkleRootsArgs } from '../../sdk/WalletStorage.interfaces'
import { StorageProvider, TableProvenTx } from '../../index.client'

describe('findStaleMerkleRoots test', () => {
  test('0 returns distinct merkle roots at the target height excluding the provided root', async () => {
    const height = 42
    const args: FindStaleMerkleRootsArgs = {
      height,
      merkleRoot: 'root-a'
    }
    const provenTxs: TableProvenTx[] = [
      makeProvenTx(1, height, 'root-a'),
      makeProvenTx(2, height, 'root-b'),
      makeProvenTx(3, height, 'root-b'),
      makeProvenTx(4, height, 'root-c'),
      makeProvenTx(5, height + 1, 'root-d')
    ]

    const storage = {
      findProvenTxs: jest.fn().mockResolvedValue(provenTxs.filter(ptx => ptx.height === height))
    } as unknown as StorageProvider

    const roots = await StorageProvider.prototype.findStaleMerkleRoots.call(storage, args)

    expect(storage.findProvenTxs).toHaveBeenCalledWith({ partial: { height } })
    expect(roots.sort()).toEqual(['root-b', 'root-c'])
  })
})

function makeProvenTx(provenTxId: number, height: number, merkleRoot: string): TableProvenTx {
  const now = new Date()
  return {
    created_at: now,
    updated_at: now,
    provenTxId,
    txid: `${provenTxId}`.padStart(64, '0'),
    height,
    index: 0,
    merklePath: [1, 2, 3],
    rawTx: [4, 5, 6],
    blockHash: `${provenTxId}`.padStart(64, 'f'),
    merkleRoot
  }
}
