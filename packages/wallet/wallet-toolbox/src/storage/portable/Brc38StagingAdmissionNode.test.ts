import { fork, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Brc38StagingAdmissionNode, type Brc38StagingCapacity } from './Brc38StagingAdmissionNode'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { semanticStageFixture, options } from './Brc38SemanticStageFixture'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

const rootCapacity: Brc38StagingCapacity = {
  maximumImports: 3,
  maximumPhysicalBytes: 15728640,
  maximumLogicalBytes: 3145728
}
let directory = '',
  roots: Brc38StagingAdmissionNode[] = [],
  stores: KnexBrc38StagingStore[] = [],
  children: ChildProcess[] = []
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'brc38-admission-test-'))
  roots = []
  stores = []
  children = []
})
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned admission child did not exit')), 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited(child)
  }
  for (const store of stores) await store.close()
  for (const root of roots) await root.close()
  await fs.rm(directory, { recursive: true, force: true })
})
async function create(capacity: Brc38StagingCapacity = rootCapacity) {
  const root = await Brc38StagingAdmissionNode.create(directory, capacity)
  roots.push(root)
  return root
}
async function reopen(capacity: Brc38StagingCapacity = rootCapacity) {
  const root = await Brc38StagingAdmissionNode.reopen(directory, capacity)
  roots.push(root)
  return root
}
async function admit(root: Brc38StagingAdmissionNode, limits = resumeLimits()) {
  const reservation = await root.admit(limits, resumeBinding())
  stores.push(reservation.store)
  return reservation
}
test('durable shared reservations precede creation and charge maximum footprint rather than current empty bytes', async () => {
  const root = await create({ ...rootCapacity, maximumPhysicalBytes: 7340032 })
  const first = await admit(root)
  expect(await root.usage()).toEqual({
    imports: 1,
    physicalBytes: 7340032,
    logicalBytes: 1048576
  })
  expect((await fs.lstat(join(directory, 'brc38-admission.sqlite'))).mode & 0o777).toBe(0o600)
  expect((await fs.lstat(first.store.directory)).mode & 0o777).toBe(0o700)
  await expect(admit(root)).rejects.toThrow('capacity is reserved')
  await first.store.close()
  expect((await root.usage()).imports).toBe(1)
  await expect(admit(root)).rejects.toThrow('capacity is reserved')
})
test('explicit released disposal refuses live and copied stores, and actual next owners retain kernel exclusion', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits)
  await expect(root.discardReleased(first)).rejects.toThrow('actual physically closed store')
  await first.store.close()
  await expect(
    root.discardReleased({ id: first.id, store: Object.freeze({ ...first.store }) as KnexBrc38StagingStore })
  ).rejects.toThrow()
  const next = await root.resume(first.id, limits, resumeBinding())
  stores.push(next.store)
  await expect(root.discardReleased(first)).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
  expect((await root.usage()).imports).toBe(1)
  await next.store.close()
  await root.discardReleased(first)
  expect((await root.usage()).imports).toBe(0)
  await root.discardReleased(first)
  expect((await root.usage()).imports).toBe(0)
})
test('released disposal removes only its exact expired reservation without renewing or collecting a neighbor', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits),
    neighbor = await admit(root),
    neighborLimits = { ...neighbor.store.limits }
  await first.store.close()
  const originalNow = Date.now()
  jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt)
  try {
    await root.discardReleased(first)
  } finally {
    jest.spyOn(Date, 'now').mockReturnValue(originalNow)
  }
  expect((await root.usage()).imports).toBe(1)
  expect(neighbor.store.limits).toEqual(neighborLimits)
  expect((await fs.lstat(neighbor.store.directory)).isDirectory()).toBe(true)
})
test.each(['maximumImports', 'maximumLogicalBytes'] as const)(
  'shared %s refuses independently of free physical bytes',
  async field => {
    const root = await create({
      ...rootCapacity,
      [field]: field === 'maximumImports' ? 1 : 1048576
    })
    await admit(root)
    await expect(admit(root)).rejects.toThrow('capacity is reserved')
    expect((await root.usage()).imports).toBe(1)
  }
)
test('two independent catalog connections cannot both reserve the final slot', async () => {
  const root = await create({ ...rootCapacity, maximumImports: 1 }),
    other = await reopen({ ...rootCapacity, maximumImports: 1 })
  const results = await Promise.allSettled([admit(root), admit(other)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect((await root.usage()).imports).toBe(1)
})
test('resume retains original quota, binding, deadline and partial records across catalog replacement', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits)
  await new Brc38SemanticStage(first.store, options).provisionalRow(
    'outputBaskets',
    0,
    semanticStageFixture().tables.outputBaskets[0]
  )
  await first.store.close()
  await root.close()
  const next = await reopen(),
    resumed = await next.resume(first.id, limits, resumeBinding())
  stores.push(resumed.store)
  expect(await resumed.store.count('outputBaskets')).toBe(1)
  expect(resumed.store.limits.expiresAt).toBe(limits.expiresAt)
  expect((await next.usage()).imports).toBe(1)
  await expect(next.resume(first.id, limits, { ...resumeBinding(), targetGeneration: 8 })).rejects.toThrow('binding')
  await next.discard(resumed, new Error('synthetic finish'))
  expect(await next.usage()).toEqual({
    imports: 0,
    physicalBytes: 3145728,
    logicalBytes: 0
  })
})
test('live expired owners keep capacity while another expired closed import can drain', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits),
    other = await admit(root, limits)
  await other.store.close()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
  try {
    expect(await root.collectExpired(3)).toBe(1)
    expect((await root.usage()).imports).toBe(1)
    expect(await fs.readdir(first.store.directory)).toContain('stage.sqlite')
    await first.store.close()
    expect(await root.collectExpired(3)).toBe(1)
    expect((await root.usage()).imports).toBe(0)
  } finally {
    clock.mockRestore()
  }
})
test('failed physical deletion retains the reservation and deterministic retired path until cleanup succeeds', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits),
    original = fs.rm
  const removal = jest.spyOn(fs, 'rm').mockImplementation(async (path, ...args) => {
    if (String(path).endsWith('.retired')) throw new Error('Synthetic physical deletion refusal')
    return await original(path, ...args)
  })
  await expect(root.discard(first, new Error('finish'))).rejects.toThrow('physical deletion refusal')
  expect((await root.usage()).imports).toBe(1)
  expect(await fs.readdir(directory)).toContain(first.id + '.retired')
  await expect(root.close()).rejects.toThrow('disposal')
  removal.mockRestore()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
  try {
    expect(await root.collectExpired(3)).toBe(1)
  } finally {
    clock.mockRestore()
  }
  expect((await root.usage()).imports).toBe(0)
})
test('caller configuration mutation during admission cannot enlarge its reserved capacity or change binding', async () => {
  const root = await create(),
    limits = { ...resumeLimits() },
    binding = { ...resumeBinding() },
    original = KnexBrc38StagingStore.createOwnedAt
  const createStage = jest.spyOn(KnexBrc38StagingStore, 'createOwnedAt').mockImplementation(async (...args) => {
    limits.maximumPhysicalBytes = 8388608
    binding.targetGeneration = 99
    return await original.apply(KnexBrc38StagingStore, args)
  })
  const first = await root.admit(limits, binding)
  stores.push(first.store)
  createStage.mockRestore()
  expect(first.store.limits.maximumPhysicalBytes).toBe(4194304)
  expect(first.store.binding?.binding.targetGeneration).toBe(7)
  expect((await root.usage()).physicalBytes).toBe(7340032)
})
test('incomplete private creation can be collected only from an unpublished reservation under the root writer', async () => {
  const root = await create(),
    limits = resumeLimits(),
    id = randomUUID()
  await root.knex('reservations').insert({
    id,
    digest: brc38StagingBinding(resumeBinding(), limits).digest,
    expiresAt: limits.expiresAt,
    maximumPhysicalBytes: limits.maximumPhysicalBytes,
    maximumLogicalBytes: limits.maximumLogicalBytes,
    state: 'reserved'
  })
  await fs.mkdir(join(directory, id), { mode: 0o700 })
  const file = await fs.open(join(directory, id, 'brc38-owner.sqlite'), 'wx', 0o600)
  await file.close()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
  try {
    expect(await root.collectExpired(3)).toBe(1)
  } finally {
    clock.mockRestore()
  }
  expect((await root.usage()).imports).toBe(0)
})
test.each(['foreign', 'symlink'] as const)(
  'unknown %s files refuse admission and cleanup while retaining capacity',
  async kind => {
    const root = await create(),
      limits = resumeLimits(),
      first = await admit(root, limits)
    await first.store.close()
    const path = join(first.store.directory, 'unexpected')
    if (kind === 'foreign') await fs.writeFile(path, 'synthetic', { mode: 0o600 })
    else await fs.symlink(join(first.store.directory, 'stage.sqlite'), path)
    await expect(admit(root)).rejects.toThrow('Unknown file')
    const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
    try {
      await expect(root.collectExpired(3)).rejects.toThrow('Unknown file')
    } finally {
      clock.mockRestore()
    }
    expect(await root.knex('reservations').count({ count: '*' }).first()).toEqual({ count: 1 })
  }
)
test('root capacity is immutable on reopen and malformed scalar metadata is refused', async () => {
  const root = await create()
  await expect(
    reopen({
      ...rootCapacity,
      maximumPhysicalBytes: rootCapacity.maximumPhysicalBytes + 1
    })
  ).rejects.toThrow('capacity is immutable')
  const first = await admit(root)
  await root.knex('reservations').where({ id: first.id }).update({ maximumLogicalBytes: 'invalid' })
  await expect(root.usage()).rejects.toThrow('reservations are invalid')
})
test('invalid per-import limits fail before leaving a reservation', async () => {
  const root = await create()
  await expect(root.admit({ ...resumeLimits(), maximumRows: 0 }, resumeBinding())).rejects.toThrow('limit')
  expect((await root.usage()).imports).toBe(0)
})
test('a duplicate retired path refuses uncharged filesystem growth', async () => {
  const root = await create(),
    first = await admit(root)
  await fs.mkdir(first.store.directory + '.retired', { mode: 0o700 })
  await expect(root.usage()).rejects.toThrow('Ambiguous private staging retirement')
  expect(await root.knex('reservations').count({ count: '*' }).first()).toEqual({ count: 1 })
})
test('the native catalog page limit is checked before admitting new work', async () => {
  const root = await create()
  await root.knex.raw('PRAGMA max_page_count=512')
  await expect(admit(root)).rejects.toThrow('page bound')
  expect(await root.knex('reservations').count({ count: '*' }).first()).toEqual({ count: 0 })
})
test('replacement of the catalog pathname cannot authorize an old open database', async () => {
  const root = await create()
  await fs.rename(join(directory, 'brc38-admission.sqlite'), join(directory, 'old.sqlite'))
  await fs.writeFile(join(directory, 'brc38-admission.sqlite'), '', {
    mode: 0o600
  })
  await expect(root.usage()).rejects.toThrow()
})
test('an expired oversized known stage refuses admission but can physically drain under its owner', async () => {
  const root = await create(),
    limits = resumeLimits(),
    first = await admit(root, limits)
  await first.store.close()
  await fs.truncate(join(first.store.directory, 'stage.sqlite'), limits.maximumPhysicalBytes + 1)
  await expect(admit(root)).rejects.toThrow('physical reservation exceeded')
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
  try {
    expect(await root.collectExpired(3)).toBe(1)
  } finally {
    clock.mockRestore()
  }
  expect((await root.usage()).imports).toBe(0)
})
test.each(['reserved', 'created', 'ready', 'retired', 'deleted', 'owner-uncommitted', 'schema-uncommitted'] as const)(
  'owned process exit at %s recovers charged capacity after physical ownership drains',
  async phase => {
    const root = await create(),
      limits = resumeLimits()
    const child = fork(
      join(__dirname, '../../../out/test/storage/portableAdmissionChild.js'),
      [directory, JSON.stringify(rootCapacity), JSON.stringify(limits), phase],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    children.push(child)
    const report = await new Promise<{ id: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned admission boundary did not report')), 3000)
      child.once('message', value => {
        clearTimeout(timer)
        resolve(value as { id: string })
      })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    expect(report.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(child.exitCode).toBeNull()
    if (phase !== 'ready') await expect(root.usage()).rejects.toThrow()
    else expect((await root.usage()).imports).toBe(1)
    child.kill('SIGKILL')
    await exited(child)
    expect((await root.usage()).imports).toBe(1)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
    try {
      expect(await root.collectExpired(3)).toBe(1)
    } finally {
      clock.mockRestore()
    }
    expect((await root.usage()).imports).toBe(0)
    expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
  }
)

test('a disposal retry retains both failures and capacity until complete physical deletion before expiry', async () => {
  const root = await create({ ...rootCapacity, maximumImports: 1 }),
    first = await admit(root),
    original = fs.rm,
    operationFailure = new Error('synthetic caller import failure'),
    unlinkFailure = new Error('synthetic temporary unlink refusal')
  const removal = jest.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.retired')) throw unlinkFailure
    return await original(...args)
  })
  const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
  expect(failure.errors[0]).toBe(operationFailure)
  expect(failure.errors[1]).toBe(unlinkFailure)
  await expect(root.close()).rejects.toThrow('disposal')
  await expect(admit(root)).rejects.toThrow('capacity is reserved')
  await expect(failure.retryCleanup()).rejects.toBeInstanceOf(Brc38StagingCleanupError)
  expect((await root.usage()).imports).toBe(1)
  expect(await fs.readdir(directory)).toContain(first.id + '.retired')
  removal.mockRestore()
  await failure.retryCleanup()
  expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
  expect(await root.usage()).toEqual({
    imports: 0,
    physicalBytes: 3145728,
    logicalBytes: 0
  })
  await failure.retryCleanup()
  expect((await admit(root)).id).not.toBe(first.id)
})

test('a disposal retry acquires the actual catalog writer before unlink and retains capacity on contention', async () => {
  const root = await create({ ...rootCapacity, maximumImports: 1 }),
    other = await reopen({ ...rootCapacity, maximumImports: 1 }),
    first = await admit(root),
    original = fs.rm,
    unlinkFailure = new Error('synthetic first unlink refusal')
  const removal = jest.spyOn(fs, 'rm').mockRejectedValueOnce(unlinkFailure)
  const failure = await root.discard(first, new Error('synthetic finish')).catch(cause => cause as unknown)
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
  removal.mockRestore()
  const unlink = jest.spyOn(fs, 'rm').mockImplementation(original)
  await other.knex.transaction(async trx => {
    await trx('capacity').where({ slot: 1 }).update({ slot: 1 })
    await expect(failure.retryCleanup()).rejects.toMatchObject({
      code: 'SQLITE_BUSY'
    })
    expect(unlink).not.toHaveBeenCalled()
    expect(await trx('reservations').count({ count: '*' }).first()).toEqual({
      count: 1
    })
    expect(await fs.readdir(directory)).toContain(first.id + '.retired')
  })
  await failure.retryCleanup()
  expect((await root.usage()).imports).toBe(0)
  expect(unlink).toHaveBeenCalledTimes(1)
})

test('a failed actual stage pool close keeps the kernel owner and reservation until catalog-owned retry', async () => {
  const root = await create({ ...rootCapacity, maximumImports: 1 }),
    limits = resumeLimits(),
    first = await admit(root, limits),
    operationFailure = new Error('synthetic import stop'),
    closeFailure = new Error('synthetic native pool close refusal')
  const close = jest.spyOn(first.store.knex.client, 'destroy').mockRejectedValueOnce(closeFailure)
  const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
  expect(failure.errors[0]).toBe(operationFailure)
  expect(failure.errors[1]).toBe(closeFailure)
  expect((await root.usage()).imports).toBe(1)
  await expect(root.resume(first.id, limits, resumeBinding())).rejects.toMatchObject({
    code: 'SQLITE_BUSY'
  })
  expect(await fs.readdir(directory)).toContain(first.id)
  close.mockRestore()
  await failure.retryCleanup()
  expect((await root.usage()).imports).toBe(0)
  expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
})

test('non-Error physical refusal retains its exact value and still provides complete catalog-owned retry', async () => {
  const root = await create(),
    first = await admit(root),
    original = fs.rm,
    operationFailure = new Error('synthetic import stop'),
    unlinkFailure = { native: 'synthetic unlink refusal' }
  const removal = jest.spyOn(fs, 'rm').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('.retired')) throw unlinkFailure
    return await original(...args)
  })
  const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
  expect(failure.errors[0]).toBe(operationFailure)
  expect(failure.errors[1]).toBe(unlinkFailure)
  expect((await root.usage()).imports).toBe(1)
  removal.mockRestore()
  await failure.retryCleanup()
  expect((await root.usage()).imports).toBe(0)
})

test('a native catalog commit refusal after physical disposal retains its exact failure and retry owner', async () => {
  const root = await create(),
    first = await admit(root),
    operationFailure = new Error('synthetic original stop')
  await root.knex.raw('PRAGMA foreign_keys = ON')
  await root.knex.raw('CREATE TABLE disposal_parent (id INTEGER PRIMARY KEY)')
  await root.knex.raw(
    'CREATE TABLE disposal_child (parentId INTEGER REFERENCES disposal_parent(id) DEFERRABLE INITIALLY DEFERRED)'
  )
  await root.knex.raw(
    'CREATE TRIGGER refuse_disposal_commit AFTER DELETE ON reservations BEGIN INSERT INTO disposal_child(parentId) VALUES (1); END'
  )
  let failure: unknown
  try {
    failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
  } finally {
    await root.knex.raw('DROP TRIGGER refuse_disposal_commit')
  }
  if (!(failure instanceof Brc38StagingCleanupError))
    throw new Error('Catalog commit failure lost its concrete disposal retry')
  expect(failure.errors[0]).toBe(operationFailure)
  expect(failure.errors[1]).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
  expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
  expect((await root.usage()).imports).toBe(1)
  await expect(root.close()).rejects.toThrow('disposal')
  await failure.retryCleanup()
  expect(await root.usage()).toEqual({ imports: 0, physicalBytes: 3145728, logicalBytes: 0 })
  await failure.retryCleanup()
  await root.close()
})

test.each(['retry', 'close'] as const)(
  'independent committed expiry cleanup releases the original pending owner through %s',
  async mode => {
    const root = await create(),
      other = await reopen(),
      limits = resumeLimits(),
      first = await admit(root, limits),
      original = fs.rm,
      operationFailure = new Error('synthetic original stop')
    try {
      const removal = jest.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('synthetic unlink refusal'))
      const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
      removal.mockRestore()
      if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
      expect((await other.usage()).imports).toBe(1)
      const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
      try {
        expect(await other.collectExpired(3)).toBe(1)
      } finally {
        clock.mockRestore()
      }
      expect((await other.usage()).imports).toBe(0)
      expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
      const unlink = jest.spyOn(fs, 'rm').mockImplementation(original)
      if (mode === 'retry') {
        await failure.retryCleanup()
        expect((await root.usage()).imports).toBe(0)
        await failure.retryCleanup()
      }
      await root.close()
      await failure.retryCleanup()
      expect(unlink).not.toHaveBeenCalled()
    } finally {
      // Fixture drain remains explicit even when the predecessor cannot clear
      // its pending logical owner after independent committed physical removal.
      await root.knex.destroy()
      roots = roots.filter(value => value !== root)
    }
  }
)

test('retained disposal owner count stays bounded while an independent catalog recycles a reservation', async () => {
  const selected = { ...rootCapacity, maximumImports: 1 },
    root = await create(selected),
    other = await reopen(selected),
    limits = resumeLimits(),
    first = await admit(root, limits),
    operationFailure = new Error('synthetic original stop')
  const removal = jest.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('synthetic unlink refusal'))
  const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
  removal.mockRestore()
  if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
  try {
    expect(await other.collectExpired(1)).toBe(1)
  } finally {
    clock.mockRestore()
  }
  const next = await admit(root)
  await expect(root.discard(next, operationFailure)).rejects.toThrow('prior owned')
  expect((await other.usage()).imports).toBe(1)
  expect(await fs.readdir(next.store.directory)).toContain('stage.sqlite')
  await root.close()
  await failure.retryCleanup()
  await other.discard(next, operationFailure)
  expect((await other.usage()).imports).toBe(0)
})

test('a rejected native rollback keeps its exact catalog connection and retry until physical settlement', async () => {
  const root = await create(),
    other = await reopen(),
    first = await admit(root),
    operationFailure = new Error('synthetic original stop'),
    rollbackFailure = new Error('synthetic native rollback refusal')
  await root.knex.raw('PRAGMA foreign_keys = ON')
  await root.knex.raw('CREATE TABLE disposal_parent (id INTEGER PRIMARY KEY)')
  await root.knex.raw(
    'CREATE TABLE disposal_child (parentId INTEGER REFERENCES disposal_parent(id) DEFERRABLE INITIALLY DEFERRED)'
  )
  await root.knex.raw(
    'CREATE TRIGGER refuse_disposal_commit AFTER DELETE ON reservations BEGIN INSERT INTO disposal_child(parentId) VALUES (1); END'
  )
  const connection: { exec: (sql: string) => unknown; readonly inTransaction: boolean } =
    await root.knex.client.acquireConnection()
  const original = connection.exec.bind(connection)
  const rollback = jest.spyOn(connection, 'exec').mockImplementation(sql => {
    if (sql === 'ROLLBACK') throw rollbackFailure
    return original(sql)
  })
  await root.knex.client.releaseConnection(connection)
  try {
    const failure = await root.discard(first, operationFailure).catch(cause => cause as unknown)
    if (!(failure instanceof Brc38StagingCleanupError)) throw new Error('Concrete disposal retry missing')
    expect(failure.errors[0]).toBe(operationFailure)
    const cleanup = failure.errors[1]
    if (!(cleanup instanceof Brc38StagingCleanupError)) throw new Error('Catalog rollback retry missing')
    expect(cleanup.errors[0]).toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' })
    expect(cleanup.errors[1]).toBe(rollbackFailure)
    expect(connection.inTransaction).toBe(true)
    await expect(root.close()).rejects.toBe(rollbackFailure)
    await expect(other.usage()).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    rollback.mockRestore()
    await cleanup.retryCleanup()
    expect(connection.inTransaction).toBe(false)
    await root.knex.raw('DROP TRIGGER refuse_disposal_commit')
    expect((await other.usage()).imports).toBe(1)
    await failure.retryCleanup()
    expect((await root.usage()).imports).toBe(0)
    expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
  } finally {
    rollback.mockRestore()
    if (connection.inTransaction) original('ROLLBACK')
    await root.knex.client.releaseConnection(connection)
    await root.knex.destroy()
    roots = roots.filter(value => value !== root)
  }
})
