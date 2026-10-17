import {
  DeviceBackupController,
  migrateDeviceBackupPreferences,
  type DeviceBackupProfile
} from './DeviceBackupController'
import type { Chain } from '../sdk/types'
import type { WalletStorageManager } from './WalletStorageManager'
import type { WalletStorageProvider } from '../sdk/WalletStorage.interfaces'
import type { SyncSessionOptions, SyncSessionResult } from './sync/syncSession'
import { Brc38StagingCleanupError } from './portable/Brc38StagingCleanupError'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
const completed: SyncSessionResult = { status: 'completed', mode: 'paged', pages: 1, inserts: 1, updates: 0 }
function profile(id: string, effects: string[], chain: Chain = 'test'): DeviceBackupProfile {
  const primary = {} as WalletStorageProvider
  return {
    profileId: id,
    identityKey: `identity-${id}`,
    chain,
    manager: {
      getAuth: async () => ({ identityKey: `identity-${id}` }),
      getActive: () => primary,
      getActiveSettings: () => ({ chain }),
      syncToWriterResumable: async (
        auth: { identityKey: string },
        _writer: WalletStorageProvider,
        options: SyncSessionOptions
      ) => {
        effects.push(`sync:${auth.identityKey}`)
        expect(Object.keys(options)).not.toContain('checkpoint')
        return completed
      }
    } as unknown as WalletStorageManager,
    openDestination: async id => {
      effects.push(`open:${id}`)
      return { makeAvailable: async () => ({ chain }) } as WalletStorageProvider
    },
    closeDestination: async () => {
      effects.push('close')
    }
  }
}
function store(value: unknown = { automaticSync: true, backupDestinations: ['archive'] }) {
  return { read: jest.fn(async () => value), write: jest.fn(async () => {}) }
}
test('legacy device migration preserves selection, refuses unknown versions and detaches destinations', () => {
  const legacy = { automaticSync: true, backupDestinations: ['first'] }
  const migrated = migrateDeviceBackupPreferences(legacy)
  legacy.backupDestinations.push('second')
  expect(migrated).toEqual({ version: 1, automaticSync: true, backupDestinations: ['first'] })
  expect(() => migrateDeviceBackupPreferences({ version: 2 })).toThrow('version')
  expect(() => migrateDeviceBackupPreferences({ backupDestinations: ['a', 'a'] })).toThrow('Duplicate')
  expect(() => migrateDeviceBackupPreferences({ automaticSync: 'true' })).toThrow('automatic')
})
test('one device preference selects independent authenticated profile runs without activating a primary', async () => {
  const effects: string[] = [],
    preferences = store()
  const controller = await DeviceBackupController.open(preferences, [
    profile('a', effects),
    profile('b', effects, 'main')
  ])
  const result = await controller.syncAutomatically()
  expect(result.map(value => value.profileId)).toEqual(['a', 'b'])
  expect(effects).toEqual(['open:archive', 'sync:identity-a', 'close', 'open:archive', 'sync:identity-b', 'close'])
  expect(preferences.write).not.toHaveBeenCalled()
  await controller.close()
})
test('regtest backup profiles preserve their declared network and independent destination', async () => {
  const effects: string[] = []
  const controller = await DeviceBackupController.open(store(), [profile('regtest', effects, 'regtest')])
  try {
    expect((await controller.syncNow()).map(value => value.profileId)).toEqual(['regtest'])
    expect(effects).toEqual(['open:archive', 'sync:identity-regtest', 'close'])
  } finally {
    await controller.close()
  }
})
test('suspension awaits an in-flight acknowledged commit and closes the actual provider before resume', async () => {
  const effects: string[] = [],
    binding = profile('a', effects),
    entered = deferred<AbortSignal>(),
    ack = deferred<void>()
  binding.manager.syncToWriterResumable = async (_auth, _writer, options = {}) => {
    entered.resolve(options.signal!)
    await ack.promise
    effects.push('ack')
    return { ...completed, status: options.signal!.aborted ? 'cancelled' : 'completed' }
  }
  const controller = await DeviceBackupController.open(store(), [binding])
  const run = controller.syncNow(),
    signal = await entered.promise
  let stopped = false
  const stop = controller.suspend().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(signal.aborted).toBe(true)
  expect(stopped).toBe(false)
  expect(effects).toEqual(['open:archive'])
  ack.resolve()
  await stop
  await run
  expect(effects).toEqual(['open:archive', 'ack', 'close'])
  controller.resume()
  await controller.close()
})
test('cancellation after destination open still closes it and does not start synchronization', async () => {
  const effects: string[] = [],
    binding = profile('a', effects),
    opened = deferred<void>(),
    pending = deferred<WalletStorageProvider>()
  const originalOpen = binding.openDestination
  const changed = {
    ...binding,
    openDestination: async () => {
      opened.resolve()
      return pending.promise
    }
  }
  const controller = await DeviceBackupController.open(store(), [changed])
  const run = controller.syncNow()
  await opened.promise
  const stopping = controller.suspend()
  pending.resolve(await originalOpen('archive', new AbortController().signal))
  await stopping
  expect(await run).toEqual([])
  expect(effects).toEqual(['open:archive', 'close'])
  await controller.close()
})
test('failed physical cleanup fences the controller and retains the exact retry owner', async () => {
  const effects: string[] = [],
    binding = profile('a', effects)
  let closing = 0
  const changed = {
    ...binding,
    closeDestination: async () => {
      if (++closing < 2) throw new Error('actual close failed')
    }
  }
  const controller = await DeviceBackupController.open(store(), [changed])
  await expect(controller.syncNow()).rejects.toBeInstanceOf(Brc38StagingCleanupError)
  expect(() => controller.syncNow()).toThrow(Brc38StagingCleanupError)
  await controller.retryCleanup()
  expect(closing).toBe(2)
  await controller.close()
})
test('preference replacement waits for actual run cleanup and close waits for actual preference write', async () => {
  const effects: string[] = [],
    preferences = store(),
    entered = deferred<void>(),
    persisted = deferred<void>()
  preferences.write = jest.fn(async () => {
    entered.resolve()
    await persisted.promise
  })
  const controller = await DeviceBackupController.open(preferences, [profile('a', effects)])
  const changing = controller.setPreferences({ version: 1, automaticSync: false, backupDestinations: ['other'] })
  await entered.promise
  let closed = false
  const closing = controller.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(closed).toBe(false)
  persisted.resolve()
  await changing
  await closing
  expect(controller.getPreferences().backupDestinations).toEqual(['other'])
})
test('a profile identity/network replacement refuses before opening a destination', async () => {
  const effects: string[] = [],
    binding = profile('a', effects)
  const controller = await DeviceBackupController.open(store(), [binding])
  binding.manager.getAuth = async () => ({ identityKey: 'other' })
  await expect(controller.syncNow()).rejects.toThrow('binding changed')
  expect(effects).toEqual([])
  await controller.close()
})
