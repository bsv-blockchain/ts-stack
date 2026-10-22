import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { WalletStorageManager, type WalletStorageProviderTransition } from '../WalletStorageManager'
import type * as sdk from '../../sdk'

// These cases cover the real manager queue and provider lifecycle. They do
// not supply native retirement, composed wallet or cutover qualification.
jest.setTimeout(30000)
const identity = '02' + '11'.repeat(32),
  storageKey = 'transition-original'
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
let directory: string,
  original: StorageKnex,
  replacement: StorageKnex,
  backup: StorageKnex,
  manager: WalletStorageManager,
  opened: StorageKnex[]
async function make(name: string, key: string): Promise<StorageKnex> {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, name + '.sqlite') },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
  const storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
  opened.push(storage)
  await db.raw('PRAGMA journal_mode = WAL')
  await storage.migrate(name, key)
  await storage.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity)
  await storage.updateUser(user.userId, { activeStorage: storageKey })
  return storage
}
beforeEach(async () => {
  opened = []
  directory = await mkdtemp(join(tmpdir(), 'manager-provider-transition-'))
  original = await make('original', storageKey)
  replacement = await make('replacement', storageKey)
  backup = await make('backup', 'transition-backup')
  manager = new WalletStorageManager(identity, original, [backup])
  await manager.makeAvailable()
})
afterEach(async () => {
  jest.restoreAllMocks()
  const drained = await Promise.allSettled(opened.map(async store => await store.destroy()))
  await rm(directory, { recursive: true, force: true })
  const failures = drained.filter(value => value.status === 'rejected')
  if (failures.length !== 0)
    throw new AggregateError(
      failures.map(value => value.reason),
      'Provider transition fixture did not drain'
    )
})
const policy = () => ({ expiresAt: Date.now() + 60000 })

test('waiting wallet access reaches the replacement only after installation; backups and auth object survive', async () => {
  const entered = gate(),
    proceed = gate(),
    installing = gate(),
    finish = gate()
  const auth = await manager.getAuth(),
    backupStores = [...manager._backups!],
    stores = [...manager._stores]
  const makeAvailable = replacement.makeAvailable.bind(replacement)
  jest.spyOn(replacement, 'makeAvailable').mockImplementation(async () => {
    installing.resolve()
    await finish.promise
    return await makeAvailable()
  })
  const transition = manager.withOwnedProviderTransition(original, policy(), async scope => {
    entered.resolve()
    await proceed.promise
    manager.blockRetiringProviderInTransition(scope)
    await manager.replaceProviderInTransition(scope, replacement)
  })
  await entered.promise
  const reader = jest.fn(async (active: sdk.WalletStorageReader) => active),
    writer = jest.fn(async (active: sdk.WalletStorageWriter) => active)
  const waitingRead = manager.runAsReader(reader),
    waitingWrite = manager.runAsWriter(writer)
  try {
    proceed.resolve()
    await installing.promise
    expect(reader).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
    expect(manager.isAvailable()).toBe(false)
    finish.resolve()
    await transition
    expect(await waitingRead).toBe(replacement)
    expect(await waitingWrite).toBe(replacement)
    expect(manager._stores[1]).toBe(stores[1])
    expect(manager._backups).toEqual(backupStores)
    expect(await manager.getAuth()).toBe(auth)
    expect(auth).toMatchObject({ identityKey: identity, userId: 1, isActive: true })
    expect(manager.getActiveStore()).toBe(storageKey)
    expect(manager.getBackupStores()).toEqual(['transition-backup'])
  } finally {
    proceed.resolve()
    finish.resolve()
    await Promise.allSettled([transition, waitingRead, waitingWrite])
  }
})

test('a failure before retirement leaves the original usable; an ambiguous retirement blocks it until a fresh recovery scope', async () => {
  const before = new Error('prepared source changed'),
    ambiguous = new Error('retirement acknowledgement lost')
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async () => {
      throw before
    })
  ).rejects.toBe(before)
  expect(await manager.runAsWriter(async active => active)).toBe(original)
  let escaped!: WalletStorageProviderTransition
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async scope => {
      escaped = scope
      manager.blockRetiringProviderInTransition(scope)
      throw ambiguous
    })
  ).rejects.toBe(ambiguous)
  const oldAvailability = jest.spyOn(original, 'makeAvailable'),
    oldCallback = jest.fn(async () => undefined)
  await expect(manager.makeAvailable()).rejects.toThrow('forward recovery')
  await expect(manager.runAsWriter(oldCallback)).rejects.toThrow('forward recovery')
  expect(oldCallback).not.toHaveBeenCalled()
  expect(oldAvailability).not.toHaveBeenCalled()
  expect(() => manager.blockRetiringProviderInTransition(escaped)).toThrow('live queue scope')
  await manager.withOwnedProviderTransition(original, policy(), async scope => {
    expect(scope).not.toBe(escaped)
    await manager.replaceProviderInTransition(scope, replacement)
  })
  expect(await manager.runAsWriter(async active => active)).toBe(replacement)
  expect(oldAvailability).not.toHaveBeenCalled()
})

test('unawaited installation is drained under the queue; cloned and escaped scopes cannot replace a provider', async () => {
  const entered = gate(),
    proceed = gate(),
    installing = gate(),
    finish = gate()
  const makeAvailable = replacement.makeAvailable.bind(replacement)
  let escaped!: WalletStorageProviderTransition
  jest.spyOn(replacement, 'makeAvailable').mockImplementation(async () => {
    installing.resolve()
    await finish.promise
    return await makeAvailable()
  })
  const transition = manager.withOwnedProviderTransition(original, policy(), async scope => {
    escaped = scope
    expect(() => manager.blockRetiringProviderInTransition({ ...scope })).toThrow('live queue scope')
    entered.resolve()
    await proceed.promise
    manager.blockRetiringProviderInTransition(scope)
    void manager.replaceProviderInTransition(scope, replacement)
  })
  await entered.promise
  const callback = jest.fn(async (active: sdk.WalletStorageWriter) => active),
    waiting = manager.runAsWriter(callback)
  try {
    proceed.resolve()
    await installing.promise
    expect(callback).not.toHaveBeenCalled()
    finish.resolve()
    await transition
    expect(await waiting).toBe(replacement)
    expect(() => manager.replaceProviderInTransition(escaped, original)).toThrow('live queue scope')
  } finally {
    proceed.resolve()
    finish.resolve()
    await Promise.allSettled([transition, waiting])
  }
})

test('foreign identity and changed primary refuse installation and retain the forward recovery barrier', async () => {
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async scope => {
      manager.blockRetiringProviderInTransition(scope)
      await manager.replaceProviderInTransition(scope, backup)
    })
  ).rejects.toThrow('distinct admitted provider')
  expect(manager.isAvailable()).toBe(false)
  const foreign = await make('foreign', 'transition-foreign')
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async scope => {
      await manager.replaceProviderInTransition(scope, foreign)
    })
  ).rejects.toThrow('storage identity or network')
  const { user } = await replacement.findOrInsertUser(identity)
  await replacement.updateUser(user.userId, { activeStorage: 'changed-primary' })
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async scope => {
      await manager.replaceProviderInTransition(scope, replacement)
    })
  ).rejects.toThrow('preserved user and primary')
  await expect(manager.runAsReader(async () => undefined)).rejects.toThrow('forward recovery')
  await replacement.updateUser(user.userId, { activeStorage: storageKey })
  await manager.withOwnedProviderTransition(original, policy(), async scope => {
    await manager.replaceProviderInTransition(scope, replacement)
  })
})

test('transition handles belong to one manager and one current provider, with cancellation checked before admission', async () => {
  const other = new WalletStorageManager(identity, replacement)
  await other.makeAvailable()
  await manager.withOwnedProviderTransition(original, policy(), async scope => {
    manager.requireOriginalProviderInTransition(scope, original)
    expect(() => manager.requireOriginalProviderInTransition(scope, replacement)).toThrow('original member')
    expect(() => other.blockRetiringProviderInTransition(scope)).toThrow('live queue scope')
    manager.blockRetiringProviderInTransition(scope)
    manager.requireOriginalProviderInTransition(scope, original)
    await manager.replaceProviderInTransition(scope, replacement)
  })
  const abort = new AbortController(),
    failure = new Error('cancel before transition'),
    callback = jest.fn(async () => undefined)
  abort.abort(failure)
  await expect(
    manager.withOwnedProviderTransition(replacement, { ...policy(), signal: abort.signal }, callback)
  ).rejects.toBe(failure)
  expect(callback).not.toHaveBeenCalled()
  await expect(
    manager.withOwnedProviderTransition(replacement, { expiresAt: Date.now() - 1 }, callback)
  ).rejects.toThrow('live bounded')
  expect(manager.getActive()).toBe(replacement)
})

test('cancellation drains admitted provider I/O and leaves recovery blocked, with a new scope required', async () => {
  const installing = gate(),
    finish = gate(),
    abort = new AbortController()
  const makeAvailable = replacement.makeAvailable.bind(replacement)
  jest.spyOn(replacement, 'makeAvailable').mockImplementation(async () => {
    installing.resolve()
    await finish.promise
    return await makeAvailable()
  })
  const transition = manager.withOwnedProviderTransition(
    original,
    { ...policy(), signal: abort.signal },
    async scope => {
      manager.blockRetiringProviderInTransition(scope)
      await manager.replaceProviderInTransition(scope, replacement)
    }
  )
  const failure = new Error('cancel provider transition'),
    rejected = expect(transition).rejects.toBe(failure)
  try {
    await installing.promise
    abort.abort(failure)
    expect(manager.isAvailable()).toBe(false)
    finish.resolve()
    await rejected
    await expect(manager.makeAvailable()).rejects.toThrow('forward recovery')
    await manager.withOwnedProviderTransition(original, policy(), async scope => {
      await manager.replaceProviderInTransition(scope, replacement)
    })
    expect(manager.getActive()).toBe(replacement)
  } finally {
    finish.resolve()
    await transition.catch(() => undefined)
  }
})

test('whole unawaited controller drains before installation I/O closes and waiting access resumes', async () => {
  const entered = gate(),
    finish = gate()
  const transition = manager.withOwnedProviderTransition(original, policy(), async scope => {
    void manager.retainOriginalProviderTransition(scope, original, async () => {
      manager.blockRetiringProviderInTransition(scope)
      entered.resolve()
      await finish.promise
      await manager.replaceProviderInTransition(scope, replacement)
    })
  })
  await entered.promise
  const callback = jest.fn(async (active: sdk.WalletStorageWriter) => active),
    waiting = manager.runAsWriter(callback)
  try {
    expect(callback).not.toHaveBeenCalled()
    expect(manager.isAvailable()).toBe(false)
    finish.resolve()
    await transition
    expect(await waiting).toBe(replacement)
  } finally {
    finish.resolve()
    await Promise.allSettled([transition, waiting])
  }
})

test('final provider preparation refuses before selection and retains the original recovery barrier', async () => {
  const failure = new Error('actual target changed after availability'),
    checked = jest.fn(async () => {
      expect(manager.isAvailable()).toBe(false)
      throw failure
    })
  await expect(
    manager.withOwnedProviderTransition(original, policy(), async scope => {
      await manager.retainOriginalProviderTransition(scope, original, async () => {
        manager.blockRetiringProviderInTransition(scope)
        await manager.replaceProviderInTransition(scope, replacement, checked)
      })
    })
  ).rejects.toBe(failure)
  expect(checked).toHaveBeenCalledTimes(1)
  await expect(manager.makeAvailable()).rejects.toThrow('forward recovery')
  await manager.withOwnedProviderTransition(original, policy(), async scope => {
    await manager.replaceProviderInTransition(scope, replacement, async () => {
      expect(manager.requireOriginalProviderInTransition(scope, original)).toMatchObject({
        userId: 1,
        primary: storageKey
      })
    })
  })
  expect(manager.getActive()).toBe(replacement)
})
