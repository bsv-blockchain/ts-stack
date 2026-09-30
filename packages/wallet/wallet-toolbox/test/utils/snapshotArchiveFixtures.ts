import type { StorageKnex } from '../../src/storage/StorageKnex'

const identity = '02' + '11'.repeat(32)
const date = '2026-01-01T00:00:00.000Z'
const timestamp = { created_at: date, updated_at: date }

export async function seedArchiveClosure(source: StorageKnex, userId: number, otherId: number): Promise<void> {
  const k = source.knex
  await k('output_baskets').del()
  for (const id of [1, 2, 3]) {
    await k('proven_txs').insert({
      ...timestamp,
      provenTxId: id,
      txid: String(id).repeat(64),
      height: id,
      index: 0,
      merklePath: Buffer.from([id, 0, 255]),
      rawTx: Buffer.from([id, 1, 255]),
      blockHash: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64)
    })
    await k('transactions').insert({
      ...timestamp,
      transactionId: id,
      userId: id === 2 ? otherId : userId,
      provenTxId: id === 3 ? null : id,
      status: 'completed',
      reference: `tx-${id}`,
      isOutgoing: true,
      satoshis: 0,
      description: `tx-${id}`,
      txid: String(id).repeat(64),
      rawTx: Buffer.from([id, 2, 255]),
      inputBEEF: Buffer.from([id, 3, 255])
    })
    await k('proven_tx_reqs').insert({
      ...timestamp,
      provenTxReqId: id,
      provenTxId: id,
      txid: String(id).repeat(64),
      status: 'completed',
      attempts: 0,
      notified: true,
      history: '{}',
      notify: '{}',
      rawTx: Buffer.from([id, 4, 255]),
      wasBroadcast: true
    })
    await k('output_baskets').insert({
      ...timestamp,
      basketId: id,
      userId: id === 2 ? otherId : userId,
      name: `basket-${id}`,
      isDeleted: id === 3
    })
    await k('outputs').insert({
      ...timestamp,
      outputId: id,
      userId: id === 2 ? otherId : userId,
      transactionId: id,
      basketId: id,
      spendable: false,
      change: true,
      vout: 0,
      satoshis: 1,
      providedBy: 'you',
      purpose: '',
      type: 'P2PKH',
      lockingScript: Buffer.from([id, 5, 255])
    })
    await k('commissions').insert({
      ...timestamp,
      commissionId: id,
      userId: id === 2 ? otherId : userId,
      transactionId: id,
      satoshis: 0,
      keyOffset: 'offset',
      isRedeemed: true,
      lockingScript: Buffer.from([id, 6, 255])
    })
    await k('output_tags').insert({
      ...timestamp,
      outputTagId: id,
      userId: id === 2 ? otherId : userId,
      tag: `tag-${id}`,
      isDeleted: id === 3
    })
    await k('output_tags_map').insert({ ...timestamp, outputTagId: id, outputId: id, isDeleted: id === 3 })
    await k('tx_labels').insert({
      ...timestamp,
      txLabelId: id,
      userId: id === 2 ? otherId : userId,
      label: `label-${id}`,
      isDeleted: id === 3
    })
    await k('tx_labels_map').insert({ ...timestamp, txLabelId: id, transactionId: id, isDeleted: id === 3 })
    await k('certificates').insert({
      ...timestamp,
      certificateId: id,
      userId: id === 2 ? otherId : userId,
      serialNumber: `serial-${id}`,
      type: 'type',
      certifier: identity,
      subject: identity,
      revocationOutpoint: 'a'.repeat(64) + '.0',
      signature: 'signature',
      isDeleted: id === 3
    })
    for (const fieldName of ['a', 'Z', 'é', '😀'])
      await k('certificate_fields').insert({
        ...timestamp,
        certificateId: id,
        userId: id === 2 ? otherId : userId,
        fieldName,
        fieldValue: `value-${id}`,
        masterKey: 'key'
      })
    await k('sync_states').insert({
      ...timestamp,
      syncStateId: id,
      userId: id === 2 ? otherId : userId,
      storageIdentityKey: `peer-${id}`,
      storageName: `peer-${id}`,
      status: 'unknown',
      init: true,
      refNum: `state-${id}`,
      syncMap: '{}',
      when: date
    })
  }
  // Composite positions must handle repeated first keys and preserve deleted mappings.
  await k('output_tags_map').insert({ ...timestamp, outputTagId: 1, outputId: 3, isDeleted: true })
  await k('tx_labels_map').insert({ ...timestamp, txLabelId: 1, transactionId: 3, isDeleted: true })
}
