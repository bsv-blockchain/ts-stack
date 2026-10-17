import { jest } from '@jest/globals'
import { MerklePath, Script, Transaction } from '@bsv/sdk'
import { toBinaryBaseBlockHeader } from '../../src/services/Services'
import { asString } from '../../src/utility/utilityHelpers.noBuffer'
import { doubleSha256BE } from '../../src/utility/utilityHelpers'
import type { WalletServices } from '../../src/sdk/WalletServices.interfaces'
import type { BRC38WalletData } from '../../src/storage/portable/index'

export interface RestoreProofFixture {
  txid: string
  tx: Transaction
  path: MerklePath
  header: ReturnType<typeof toBinaryBaseBlockHeader>
  services: WalletServices
  isValidRootForHeight: jest.Mock<(root: string, height: number) => Promise<boolean>>
}
export function restoreProofFixture(measurementRawBytes?: 256 | 32768 | 131073): RestoreProofFixture {
  if (measurementRawBytes !== undefined && ![256, 32768, 131073].includes(measurementRawBytes))
    throw new RangeError('Independent proof measurement shape differs')
  const tx = new Transaction()
  tx.addOutput({
    satoshis: 1,
    lockingScript:
      measurementRawBytes === undefined
        ? Script.fromHex('51')
        : Script.fromASM(`OP_FALSE OP_RETURN ${'31'.repeat(measurementRawBytes)}`)
  })
  const txid = tx.id('hex'),
    path = new MerklePath(100, [[{ offset: 0, hash: txid, txid: true }]]),
    header = toBinaryBaseBlockHeader({
      version: 1,
      previousHash: '0'.repeat(64),
      merkleRoot: txid,
      time: 1,
      bits: 0,
      nonce: 0
    }),
    isValidRootForHeight = jest.fn(async (root: string, height: number) => root === txid && height === 100),
    services = {
      getChainTracker: async () => ({ isValidRootForHeight }),
      getHeaderForHeight: async () => [...header]
    } as unknown as WalletServices
  return { txid, tx, path, header, services, isValidRootForHeight }
}
export function restorePortableProof(data: BRC38WalletData, proof: ReturnType<typeof restoreProofFixture>) {
  Object.assign(data.tables.provenTxs[0], {
    txid: proof.txid.toUpperCase(),
    height: 100,
    index: 0,
    rawTx: Buffer.from(proof.tx.toBinary()).toString('base64'),
    merklePath: Buffer.from(proof.path.toBinary()).toString('base64'),
    blockHash: asString(doubleSha256BE(proof.header)).toUpperCase(),
    merkleRoot: proof.txid.toUpperCase()
  })
  data.tables.provenTxReqs[0].txid = proof.txid.toUpperCase()
  data.tables.transactions[0].txid = proof.txid.toUpperCase()
  data.tables.outputs[0].txid = proof.txid.toUpperCase()
}
