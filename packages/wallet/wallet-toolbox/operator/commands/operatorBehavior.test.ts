import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { prepareSqliteDestination } from './walletLegacyFixture'
import { parseInstructions, reviewExportOutput } from './walletReinternalizeExports'
import { reconcileTransaction } from './walletReconcileStuck'
import { reviewProvenTransaction } from './walletRepairProvenTransactions'
import { reviewCustomOutput } from './walletReviewCustomOutputs'

describe('extracted Wallet Toolbox operator behavior', () => {
  test('refuses an existing SQLite fixture unless replacement is explicit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-legacy-fixture-'))
    const existing = path.join(directory, 'existing.sqlite')
    const missing = path.join(directory, 'nested', 'missing.sqlite')
    try {
      await fs.writeFile(existing, 'fixture')

      await expect(prepareSqliteDestination(existing, false)).rejects.toThrow('Destination SQLite file already exists')
      await expect(prepareSqliteDestination(existing, true)).resolves.toBeUndefined()
      await expect(prepareSqliteDestination(missing, false)).resolves.toBeUndefined()
      expect((await fs.stat(path.dirname(missing))).isDirectory()).toBe(true)
      await expect(prepareSqliteDestination('', false)).resolves.toBeUndefined()
    } finally {
      await fs.rm(directory, { force: true, recursive: true })
    }
  })

  test('recovers a missing custom-output script and verifies restoration', async () => {
    const txid = 'ab'.repeat(32)
    const storedOutput = {
      lockingScript: [],
      outputId: 42,
      scriptLength: 2,
      scriptOffset: 5,
      spendable: false,
      txid,
      vout: 7
    }
    const findOutputById = jest
      .fn()
      .mockResolvedValueOnce(storedOutput)
      .mockResolvedValueOnce({ ...storedOutput, spendable: true })
    const storage = {
      findOutputById,
      getRawTxOfKnownValidTransaction: jest.fn().mockResolvedValue([0x51]),
      updateOutput: jest.fn().mockResolvedValue(1)
    }
    const services = {
      getUtxoStatus: jest.fn().mockResolvedValue({
        isUtxo: true,
        status: 'success'
      }),
      hashOutputScript: jest.fn().mockReturnValue('script-hash')
    }

    await expect(
      reviewCustomOutput(storage as never, services as never, value => Buffer.from(value).toString('hex'), 42, true)
    ).resolves.toEqual({
      outcome: 'restored',
      recoveredScript: true
    })
    expect(storage.getRawTxOfKnownValidTransaction).toHaveBeenCalledWith(txid, 5, 2)
    expect(services.hashOutputScript).toHaveBeenCalledWith('51')
    expect(services.getUtxoStatus).toHaveBeenCalledWith('script-hash', undefined, `${txid}.7`)
    expect(storage.updateOutput).toHaveBeenCalledWith(42, { spendable: true })
    expect(findOutputById).toHaveBeenLastCalledWith(42, undefined, true)
  })

  test('internalizes BRC-29 exports at the stored output index for the intended payee', async () => {
    const txid = 'cd'.repeat(32)
    const sourceUser = {
      identityKey: `02${'11'.repeat(32)}`,
      userId: 2
    }
    const destinationUser = {
      identityKey: `03${'22'.repeat(32)}`,
      userId: 141
    }
    const instructions = {
      type: 'BRC29',
      derivationPrefix: 'prefix',
      derivationSuffix: 'suffix',
      payee: destinationUser.identityKey
    }
    const storage = {
      findOutputById: jest.fn().mockResolvedValue({
        customInstructions: JSON.stringify(instructions),
        outputId: 91,
        txid,
        vout: 7
      }),
      findOutputs: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ outputId: 300 }]),
      findProvenTxReqs: jest.fn().mockResolvedValue([{ provenTxReqId: 12 }]),
      getBeefForTransaction: jest.fn().mockResolvedValue({
        toBinaryAtomic: jest.fn().mockReturnValue([1, 2, 3])
      }),
      internalizeAction: jest.fn().mockResolvedValue({ txid })
    }

    await expect(
      reviewExportOutput(storage as never, 91, sourceUser as never, [destinationUser] as never, true)
    ).resolves.toBe('internalized')
    expect(storage.findOutputById).toHaveBeenCalledWith(91, undefined, true)
    expect(storage.internalizeAction).toHaveBeenCalledWith(
      {
        identityKey: destinationUser.identityKey,
        userId: destinationUser.userId
      },
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            outputIndex: 7,
            paymentRemittance: expect.objectContaining({
              senderIdentityKey: sourceUser.identityKey
            })
          })
        ]
      })
    )
    expect(parseInstructions('not-json')).toBeUndefined()
    expect(parseInstructions(JSON.stringify({ ...instructions, type: 'other' }))).toBeUndefined()
  })

  test('distinguishes proof mismatches from matches and verifies exact repairs', async () => {
    const txid = 'ef'.repeat(32)
    const externalPath = {
      blockHeight: 900,
      computeRoot: jest.fn().mockReturnValue('external-root'),
      path: [[{ hash: txid, offset: 4 }]],
      toBinary: jest.fn().mockReturnValue([2, 3])
    }
    const services = {
      getMerklePath: jest.fn().mockResolvedValue({
        header: {
          hash: 'block-hash',
          height: 900,
          merkleRoot: 'external-root'
        },
        merklePath: externalPath
      })
    }
    const transaction = {
      blockHash: 'old-block',
      height: 899,
      index: 1,
      merklePath: [1],
      merkleRoot: 'old-root',
      provenTxId: 77,
      txid
    }
    const update = {
      blockHash: 'block-hash',
      height: 900,
      index: 4,
      merklePath: [2, 3],
      merkleRoot: 'external-root'
    }
    const storage = {
      findProvenTxById: jest.fn().mockResolvedValue({
        ...transaction,
        ...update
      }),
      updateProvenTx: jest.fn().mockResolvedValue(1)
    }
    const sdk = {
      MerklePath: {
        fromBinary: jest.fn().mockReturnValue({
          blockHeight: 899,
          computeRoot: jest.fn().mockReturnValue('old-root')
        })
      },
      Utils: {
        toHex: (value: number[]) => Buffer.from(value).toString('hex')
      }
    }

    await expect(
      reviewProvenTransaction(storage as never, services as never, sdk as never, transaction as never, false)
    ).resolves.toBe('mismatched')
    expect(storage.updateProvenTx).not.toHaveBeenCalled()

    await expect(
      reviewProvenTransaction(storage as never, services as never, sdk as never, transaction as never, true)
    ).resolves.toBe('repaired')
    expect(storage.updateProvenTx).toHaveBeenCalledWith(77, update)
    expect(storage.findProvenTxById).toHaveBeenCalledWith(77)
  })

  test('repairs a stale unknown transaction only when persistence can be verified', async () => {
    const storage = {
      findTransactionById: jest.fn().mockResolvedValue({ status: 'failed' }),
      updateTransactionStatus: jest.fn().mockResolvedValue(1)
    }
    const transaction = {
      transactionId: 19,
      txid: '01'.repeat(32),
      updated_at: new Date('2025-01-01T00:00:00.000Z')
    }

    await expect(
      reconcileTransaction({
        storage: storage as never,
        services: {} as never,
        runtime: {} as never,
        sdk: {} as never,
        transaction: transaction as never,
        chainStatus: 'unknown',
        cutoff: new Date('2026-01-01T00:00:00.000Z'),
        repair: true
      })
    ).resolves.toEqual({
      eligible: true,
      outcome: 'marked-failed'
    })
    expect(storage.updateTransactionStatus).toHaveBeenCalledWith('failed', 19)
    expect(storage.findTransactionById).toHaveBeenCalledWith(19)
  })

  test('re-enters a verified mined transaction through the normal proof-request pipeline', async () => {
    const rawTx = [1, 2, 3]
    const txid = 'verified-txid'
    const request = {
      addNotifyTransactionId: jest.fn(),
      updateStorage: jest.fn().mockResolvedValue(undefined)
    }
    const storage = {
      findProvenTxReqs: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ status: 'unmined' }]),
      getProvenOrReq: jest.fn().mockResolvedValue({})
    }
    const runtime = {
      doubleSha256BE: jest.fn().mockReturnValue([0xaa]),
      EntityProvenTxReq: {
        fromTxid: jest.fn().mockReturnValue(request)
      }
    }
    const Beef = jest.fn().mockImplementation(() => ({
      toBinary: () => [9]
    }))
    const sdk = {
      Beef,
      Utils: {
        toHex: jest.fn().mockReturnValue(txid)
      }
    }
    const transaction = {
      rawTx,
      transactionId: 20,
      txid,
      updated_at: new Date('2025-01-01T00:00:00.000Z')
    }

    await expect(
      reconcileTransaction({
        storage: storage as never,
        services: {} as never,
        runtime: runtime as never,
        sdk: sdk as never,
        transaction: transaction as never,
        chainStatus: 'mined',
        cutoff: new Date('2026-01-01T00:00:00.000Z'),
        repair: true
      })
    ).resolves.toEqual({
      eligible: true,
      outcome: 'created-request'
    })
    expect(runtime.EntityProvenTxReq.fromTxid).toHaveBeenCalledWith(txid, rawTx)
    expect(request).toMatchObject({
      inputBEEF: [9],
      status: 'unmined'
    })
    expect(request.addNotifyTransactionId).toHaveBeenCalledWith(20)
    expect(request.updateStorage).toHaveBeenCalledWith(storage)
  })

  test('classifies non-repairable and already tracked stale transactions without mutation', async () => {
    const transaction = {
      transactionId: 21,
      txid: '12'.repeat(32),
      updated_at: new Date('2025-06-01T00:00:00.000Z')
    }
    const cutoff = new Date('2026-01-01T00:00:00.000Z')
    const storage = {
      findProvenTxReqs: jest.fn().mockResolvedValue([{ status: 'completed' }]),
      getProvenOrReq: jest.fn().mockResolvedValue({}),
      updateTransactionStatus: jest.fn()
    }
    const common = {
      storage: storage as never,
      services: {} as never,
      runtime: {} as never,
      sdk: {} as never,
      transaction: transaction as never,
      cutoff
    }

    await expect(
      reconcileTransaction({
        ...common,
        transaction: {
          ...transaction,
          updated_at: new Date('2026-02-01T00:00:00.000Z')
        } as never,
        chainStatus: 'unknown',
        repair: true
      })
    ).resolves.toEqual({ eligible: false, outcome: 'none' })
    await expect(reconcileTransaction({ ...common, chainStatus: 'unknown', repair: false })).resolves.toEqual({
      eligible: true,
      outcome: 'none'
    })
    await expect(reconcileTransaction({ ...common, chainStatus: 'rejected', repair: true })).resolves.toEqual({
      eligible: true,
      outcome: 'none'
    })
    await expect(reconcileTransaction({ ...common, chainStatus: 'mined', repair: true })).resolves.toEqual({
      eligible: true,
      outcome: 'already-tracked'
    })
    expect(storage.updateTransactionStatus).not.toHaveBeenCalled()

    storage.findProvenTxReqs.mockResolvedValue([])
    storage.getProvenOrReq.mockResolvedValue({ proven: { provenTxId: 1 } })
    await expect(reconcileTransaction({ ...common, chainStatus: 'mined', repair: true })).resolves.toEqual({
      eligible: true,
      outcome: 'already-tracked'
    })
  })

  test('rejects unverifiable mined transaction bytes and verifies repair persistence', async () => {
    const txid = '13'.repeat(32)
    const transaction = {
      transactionId: 22,
      txid,
      updated_at: new Date('2025-06-01T00:00:00.000Z')
    }
    const storage = {
      findProvenTxReqs: jest.fn().mockResolvedValue([]),
      getProvenOrReq: jest.fn().mockResolvedValue({}),
      findTransactionById: jest.fn().mockResolvedValue({ status: 'sending' }),
      updateTransactionStatus: jest.fn().mockResolvedValue(1)
    }
    const services = {
      getRawTx: jest.fn().mockResolvedValue({})
    }
    const runtime = {
      doubleSha256BE: jest.fn().mockReturnValue([0])
    }
    const sdk = {
      Utils: {
        toHex: jest.fn().mockReturnValue('not-the-expected-txid')
      }
    }
    const common = {
      storage: storage as never,
      services: services as never,
      runtime: runtime as never,
      sdk: sdk as never,
      transaction: transaction as never,
      cutoff: new Date('2026-01-01T00:00:00.000Z')
    }

    await expect(reconcileTransaction({ ...common, chainStatus: 'mined', repair: true })).resolves.toEqual({
      eligible: true,
      outcome: 'unresolved-raw-transaction'
    })
    services.getRawTx.mockResolvedValue({ rawTx: [1, 2, 3] })
    await expect(reconcileTransaction({ ...common, chainStatus: 'mined', repair: true })).resolves.toEqual({
      eligible: true,
      outcome: 'unresolved-raw-transaction'
    })

    await expect(reconcileTransaction({ ...common, chainStatus: 'unknown', repair: true })).rejects.toThrow(
      'Stale transaction did not persist with failed status'
    )
  })

  test('fails closed when a mined-transaction proof request cannot be verified after writing', async () => {
    const txid = '14'.repeat(32)
    const request = {
      addNotifyTransactionId: jest.fn(),
      updateStorage: jest.fn().mockResolvedValue(undefined)
    }
    const storage = {
      findProvenTxReqs: jest.fn().mockResolvedValue([]),
      getProvenOrReq: jest.fn().mockResolvedValue({})
    }
    const runtime = {
      doubleSha256BE: jest.fn().mockReturnValue([1]),
      EntityProvenTxReq: {
        fromTxid: jest.fn().mockReturnValue(request)
      }
    }
    const sdk = {
      Beef: jest.fn().mockImplementation(() => ({ toBinary: () => [2] })),
      Utils: { toHex: jest.fn().mockReturnValue(txid) }
    }
    const transaction = {
      rawTx: [1, 2, 3],
      transactionId: 23,
      txid,
      updated_at: new Date('2025-06-01T00:00:00.000Z')
    }

    await expect(
      reconcileTransaction({
        storage: storage as never,
        services: {} as never,
        runtime: runtime as never,
        sdk: sdk as never,
        transaction: transaction as never,
        chainStatus: 'mined',
        cutoff: new Date('2026-01-01T00:00:00.000Z'),
        repair: false
      })
    ).resolves.toEqual({ eligible: true, outcome: 'none' })
    await expect(
      reconcileTransaction({
        storage: storage as never,
        services: {} as never,
        runtime: runtime as never,
        sdk: sdk as never,
        transaction: transaction as never,
        chainStatus: 'mined',
        cutoff: new Date('2026-01-01T00:00:00.000Z'),
        repair: true
      })
    ).rejects.toThrow('did not create an unmined proof request')
  })

  test('classifies invalid, ignored, existing, and missing-proof exports before internalization', async () => {
    const txid = '15'.repeat(32)
    const sourceUser = { identityKey: `02${'10'.repeat(32)}`, userId: 2 }
    const destinationUser = { identityKey: `03${'20'.repeat(32)}`, userId: 3 }
    const validInstructions = JSON.stringify({
      type: 'BRC29',
      derivationPrefix: 'prefix',
      derivationSuffix: 'suffix',
      payee: destinationUser.identityKey
    })
    const storage = {
      findOutputById: jest.fn(),
      findOutputs: jest.fn(),
      findProvenTxReqs: jest.fn()
    }

    storage.findOutputById.mockResolvedValue(undefined)
    await expect(
      reviewExportOutput(storage as never, 1, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('invalid-instructions')
    storage.findOutputById.mockResolvedValue({ txid, vout: 0 })
    await expect(
      reviewExportOutput(storage as never, 2, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('invalid-instructions')
    storage.findOutputById.mockResolvedValue({
      txid,
      vout: 0,
      customInstructions: JSON.stringify({
        type: 'BRC29',
        derivationPrefix: '',
        derivationSuffix: 'suffix',
        payee: destinationUser.identityKey
      })
    })
    await expect(
      reviewExportOutput(storage as never, 3, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('invalid-instructions')
    storage.findOutputById.mockResolvedValue({
      txid,
      vout: 0,
      customInstructions: JSON.stringify({
        type: 'BRC29',
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        payee: 'another-wallet'
      })
    })
    await expect(
      reviewExportOutput(storage as never, 4, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('ignored')

    storage.findOutputById.mockResolvedValue({ txid, vout: 0, customInstructions: validInstructions })
    storage.findOutputs.mockResolvedValue([{ outputId: 99 }])
    await expect(
      reviewExportOutput(storage as never, 5, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('already-present')
    storage.findOutputs.mockResolvedValue([])
    storage.findProvenTxReqs.mockResolvedValue([])
    await expect(
      reviewExportOutput(storage as never, 6, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('missing-proof')
    storage.findProvenTxReqs.mockResolvedValue([{ provenTxReqId: 1 }])
    await expect(
      reviewExportOutput(storage as never, 7, sourceUser as never, [destinationUser] as never, false)
    ).resolves.toBe('candidate')
  })

  test('fails closed when internalization does not return and persist the exact output', async () => {
    const txid = '16'.repeat(32)
    const sourceUser = { identityKey: `02${'10'.repeat(32)}`, userId: 2 }
    const destinationUser = { identityKey: `03${'20'.repeat(32)}`, userId: 3 }
    const output = {
      txid,
      vout: 1,
      customInstructions: JSON.stringify({
        type: 'BRC29',
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        payee: destinationUser.identityKey
      })
    }
    const storage = {
      findOutputById: jest.fn().mockResolvedValue(output),
      findOutputs: jest.fn().mockResolvedValueOnce([]),
      findProvenTxReqs: jest.fn().mockResolvedValue([{ provenTxReqId: 1 }]),
      getBeefForTransaction: jest.fn().mockResolvedValue({
        toBinaryAtomic: jest.fn().mockReturnValue([1, 2])
      }),
      internalizeAction: jest.fn().mockResolvedValue({ txid: 'different-txid' })
    }

    await expect(
      reviewExportOutput(storage as never, 8, sourceUser as never, [destinationUser] as never, true)
    ).rejects.toThrow('did not return expected txid')

    storage.findOutputs.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([])
    storage.internalizeAction.mockResolvedValue({ txid })
    await expect(
      reviewExportOutput(storage as never, 8, sourceUser as never, [destinationUser] as never, true)
    ).rejects.toThrow('did not persist exactly once')
  })

  test('classifies unavailable, spent, and non-persisting custom outputs safely', async () => {
    const txid = '17'.repeat(32)
    const storage = {
      findOutputById: jest.fn(),
      getRawTxOfKnownValidTransaction: jest.fn(),
      updateOutput: jest.fn().mockResolvedValue(1)
    }
    const services = {
      getUtxoStatus: jest.fn(),
      hashOutputScript: jest.fn().mockReturnValue('script-hash')
    }

    storage.findOutputById.mockResolvedValue(undefined)
    await expect(reviewCustomOutput(storage as never, services as never, () => '51', 1, false)).resolves.toEqual({
      outcome: 'unavailable-script',
      recoveredScript: false
    })
    storage.findOutputById.mockResolvedValue({ outputId: 2, txid, vout: 0, lockingScript: [] })
    storage.getRawTxOfKnownValidTransaction.mockResolvedValue(undefined)
    await expect(reviewCustomOutput(storage as never, services as never, () => '51', 2, false)).resolves.toEqual({
      outcome: 'unavailable-script',
      recoveredScript: false
    })

    storage.findOutputById.mockResolvedValue({ outputId: 3, txid, vout: 0, lockingScript: [0x51] })
    services.getUtxoStatus.mockResolvedValue({ status: 'error', isUtxo: true })
    await expect(reviewCustomOutput(storage as never, services as never, () => '51', 3, false)).resolves.toEqual({
      outcome: 'not-utxo',
      recoveredScript: false
    })
    services.getUtxoStatus.mockResolvedValue({ status: 'success', isUtxo: false })
    await expect(reviewCustomOutput(storage as never, services as never, () => '51', 3, false)).resolves.toEqual({
      outcome: 'not-utxo',
      recoveredScript: false
    })

    services.getUtxoStatus.mockResolvedValue({ status: 'success', isUtxo: true })
    storage.findOutputById
      .mockReset()
      .mockResolvedValueOnce({ outputId: 4, txid, vout: 0, lockingScript: [0x51] })
      .mockResolvedValueOnce({ outputId: 4, txid, vout: 0, spendable: false })
    await expect(reviewCustomOutput(storage as never, services as never, () => '51', 4, true)).rejects.toThrow(
      'did not persist as spendable'
    )
  })

  test('accepts exact stored proofs and rejects invalid or non-persisting repairs', async () => {
    const txid = '18'.repeat(32)
    const externalPath = {
      blockHeight: 100,
      computeRoot: jest.fn().mockReturnValue('root'),
      path: [[{ hash: txid, offset: 2 }]],
      toBinary: jest.fn().mockReturnValue([1, 2])
    }
    const services = {
      getMerklePath: jest.fn().mockResolvedValue({
        header: { hash: 'block', height: 100, merkleRoot: 'root' },
        merklePath: externalPath
      })
    }
    const transaction = {
      provenTxId: 55,
      txid,
      merklePath: [1, 2],
      merkleRoot: 'root',
      height: 100,
      blockHash: 'block',
      index: 2
    }
    const sdk = {
      MerklePath: {
        fromBinary: jest.fn().mockReturnValue({
          blockHeight: 100,
          computeRoot: jest.fn().mockReturnValue('root')
        })
      },
      Utils: {
        toHex: (value: number[]) => Buffer.from(value).toString('hex')
      }
    }
    const storage = {
      updateProvenTx: jest.fn().mockResolvedValue(1),
      findProvenTxById: jest.fn()
    }

    await expect(
      reviewProvenTransaction(storage as never, services as never, sdk as never, transaction as never, false)
    ).resolves.toBe('matched')

    services.getMerklePath.mockResolvedValue({
      header: { hash: 'block', height: 99, merkleRoot: 'root' },
      merklePath: externalPath
    })
    await expect(
      reviewProvenTransaction(storage as never, services as never, sdk as never, transaction as never, false)
    ).rejects.toThrow('failed internal validation')

    services.getMerklePath.mockResolvedValue({
      header: { hash: 'new-block', height: 100, merkleRoot: 'root' },
      merklePath: externalPath
    })
    storage.findProvenTxById.mockResolvedValue(undefined)
    await expect(
      reviewProvenTransaction(storage as never, services as never, sdk as never, transaction as never, true)
    ).rejects.toThrow('did not persist exactly')
  })
})
