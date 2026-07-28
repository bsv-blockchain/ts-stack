import { jest } from '@jest/globals'
import type { Db } from 'mongodb'

import { AppsStorageManager } from '../apps/AppsStorageManager.js'
import { BTMSStorageManager } from '../btms/BTMSStorageManager.js'
import { DesktopIntegrityStorage } from '../desktopintegrity/DesktopIntegrityStorage.js'
import { DIDStorageManager } from '../did/DIDStorageManager.js'
import { FractionalizeStorage } from '../fractionalize/FractionalizeStorage.js'
import { IdentityStorageManager } from '../identity/IdentityStorageManager.js'
import { MonsterBattleStorage } from '../monsterbattle/MonsterBattleStorage.js'
import { SlackThreadsStorage } from '../slackthreads/SlackThreadsStorage.js'
import { SupplyChainStorage } from '../supplychain/SupplyChainStorage.js'
import { TokenDemoStorage } from '../utility-tokens/TokenDemoStorage.js'

interface DeletableStorage {
  deleteRecord: (txid: string, outputIndex: number) => Promise<void>
}

describe('storage index initialization', () => {
  test('creates each manager index set once across repeated operations', async () => {
    const createIndex = jest.fn(async () => 'index')
    const deleteOne = jest.fn(async () => ({ acknowledged: true, deletedCount: 0 }))
    const collection = { createIndex, deleteOne }
    const db = {
      collection: jest.fn(() => collection)
    } as unknown as Db

    const managers: DeletableStorage[] = [
      new AppsStorageManager(db),
      new BTMSStorageManager(db),
      new DesktopIntegrityStorage(db),
      new DIDStorageManager(db),
      new FractionalizeStorage(db),
      new IdentityStorageManager(db),
      new MonsterBattleStorage(db),
      new SlackThreadsStorage(db),
      new SupplyChainStorage(db),
      new TokenDemoStorage(db)
    ]

    for (const manager of managers) {
      const indexesBefore = createIndex.mock.calls.length
      await manager.deleteRecord('txid', 0)
      const indexesAfterFirstOperation = createIndex.mock.calls.length
      expect(indexesAfterFirstOperation).toBeGreaterThan(indexesBefore)

      await manager.deleteRecord('txid', 0)
      expect(createIndex).toHaveBeenCalledTimes(indexesAfterFirstOperation)
    }

    expect(deleteOne).toHaveBeenCalledTimes(managers.length * 2)
  })
})
