import type { WalletInterface } from '@bsv/sdk'

import { Monitor } from '../monitor/Monitor'
import { TaskCheckForProofs } from '../monitor/tasks/TaskCheckForProofs'
import { TaskCheckNoSends } from '../monitor/tasks/TaskCheckNoSends'
import { TaskPurge } from '../monitor/tasks/TaskPurge'
import { TaskReviewDoubleSpends } from '../monitor/tasks/TaskReviewDoubleSpends'
import { TaskReviewProvenTxs } from '../monitor/tasks/TaskReviewProvenTxs'
import { TaskReviewStatus } from '../monitor/tasks/TaskReviewStatus'
import { TaskReviewUtxos } from '../monitor/tasks/TaskReviewUtxos'
import { TaskUnFail } from '../monitor/tasks/TaskUnFail'
import { SimpleWalletManager } from '../SimpleWalletManager'
import { WalletSigner } from '../signer/WalletSigner'
import { StorageIdb } from '../storage/StorageIdb'
import { transformVerifiableCertificatesWithTrust } from '../utility/identityUtils'
import { WABClient } from '../wab-client/WABClient'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('Wave 28 compatibility boundaries', () => {
  test('initializes a simple wallet lazily and only once', async () => {
    const walletBuilder = jest.fn(async () => Object.create(null) as WalletInterface)
    const manager = new SimpleWalletManager('admin.example', walletBuilder)

    expect(manager.authenticated).toBe(false)
    expect(manager.ready).toBe(manager.ready)
    await expect(manager.ready).resolves.toBeUndefined()
    expect(walletBuilder).not.toHaveBeenCalled()
  })

  test('retains the WalletSigner discriminator as a true literal', () => {
    const signer = new WalletSigner('main', {} as never, {} as never)
    expect(signer.isWalletSigner).toBe(true)
  })

  test('normalizes E.164 share-auth payloads before transport', async () => {
    const fetchClient = jest.fn(async () =>
      jsonResponse({
        success: true,
        message: 'started'
      })
    ) as typeof fetch
    const client = new WABClient('https://wab.example', { fetch: fetchClient })

    await expect(
      client.startShareAuth('TwilioPhone', 'a'.repeat(64), {
        phoneNumber: ' +15555550123 '
      })
    ).resolves.toMatchObject({ success: true })

    const body = JSON.parse(String(fetchClient.mock.calls[0][1]?.body)) as {
      payload: { phoneNumber: string }
    }
    expect(body.payload.phoneNumber).toBe('+15555550123')

    await expect(
      client.startShareAuth('TwilioPhone', 'a'.repeat(64), {
        phoneNumber: '555-555-0123'
      })
    ).rejects.toThrow('canonical E.164')
  })

  test('preserves monitor lazy readiness and explicit task triggers', async () => {
    const monitor = Object.create(Monitor.prototype) as any
    monitor._init = jest.fn(async () => {})

    expect(monitor.ready).toBe(monitor.ready)
    await expect(monitor.ready).resolves.toBeUndefined()
    expect(monitor._init).toHaveBeenCalledTimes(1)

    const taskTypes = [
      TaskCheckForProofs,
      TaskCheckNoSends,
      TaskPurge,
      TaskReviewDoubleSpends,
      TaskReviewProvenTxs,
      TaskReviewStatus,
      TaskReviewUtxos,
      TaskUnFail
    ]
    for (const taskType of taskTypes) {
      taskType.checkNow = true
      expect(taskType.checkNow).toBe(true)
      taskType.checkNow = false
      expect(taskType.checkNow).toBe(false)
    }
  })

  test('reports both structured and scalar IndexedDB key mismatches', async () => {
    const storage = Object.create(StorageIdb.prototype) as any
    storage.validatePartialForUpdate = (update: unknown) => update
    const done = Promise.resolve()
    const put = jest
      .fn()
      .mockResolvedValueOnce({ unexpected: 'key' })
      .mockResolvedValueOnce('unexpected-key')
      .mockResolvedValueOnce(7)
    storage.toDbTrx = () => ({
      objectStore: () => ({
        get: async () => ({ key: 7, value: 'before' }),
        put
      }),
      done
    })

    await expect(storage.updateIdb(7, { value: 'after' }, 'key', 'records')).rejects.toThrow(
      'updated id {"unexpected":"key"} does not match original 7'
    )
    await expect(storage.updateIdb(7, { value: 'after' }, 'key', 'records')).rejects.toThrow(
      'updated id unexpected-key does not match original 7'
    )
    await expect(storage.updateIdb(7, { value: 'after' }, 'key', 'records')).resolves.toBe(1)
  })

  test('groups multiple trusted certificates for the same identity', () => {
    const certificate = {
      subject: 'subject-key',
      certifier: 'certifier-key',
      signature: 'signature',
      decryptedFields: {},
      keyring: {}
    }
    const result = transformVerifiableCertificatesWithTrust(
      {
        trustLevel: 2,
        trustedCertifiers: [
          {
            name: 'Certifier',
            description: 'Test certifier',
            identityKey: 'certifier-key' as never,
            trust: 1
          }
        ]
      },
      [certificate, { ...certificate }] as never
    )

    expect(result.totalCertificates).toBe(2)
    expect(result.certificates).toHaveLength(2)
  })
})
