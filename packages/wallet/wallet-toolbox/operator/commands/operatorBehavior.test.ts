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
      reconcileTransaction(
        storage as never,
        {} as never,
        {} as never,
        {} as never,
        transaction as never,
        'unknown',
        new Date('2026-01-01T00:00:00.000Z'),
        true
      )
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
      reconcileTransaction(
        storage as never,
        {} as never,
        runtime as never,
        sdk as never,
        transaction as never,
        'mined',
        new Date('2026-01-01T00:00:00.000Z'),
        true
      )
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
})
