import createKnex from 'knex'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, readdir, rm, lstat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnexBrc38StagingStore, Brc38StagingCleanupError, type KnexBrc38StagingLimits } from './KnexBrc38StagingStore'
import { Brc38SemanticStage, brc38StageTables } from './Brc38SemanticStage'
import { semanticStageFixture, options, source } from './Brc38SemanticStageFixture'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { brc38StagingBinding, type Brc38StagingBinding } from './Brc38StagingBinding'

let parent = '',
  stores: KnexBrc38StagingStore[] = [],
  children: ChildProcess[] = []
beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'brc38-resume-test-'))
  stores = []
  children = []
})
async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned staging fixture did not exit')), 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited(child)
  }
  for (const store of stores) await store.close()
  await rm(parent, { recursive: true, force: true })
})
async function created(limits: KnexBrc38StagingLimits = resumeLimits()) {
  const store = await KnexBrc38StagingStore.createOwned(parent, limits, resumeBinding())
  stores.push(store)
  return store
}
async function reopen(
  directory: string,
  limits: KnexBrc38StagingLimits,
  binding: Brc38StagingBinding = resumeBinding()
) {
  const store = await KnexBrc38StagingStore.reopenOwned(directory, limits, binding)
  stores.push(store)
  return store
}
async function metadata(store: KnexBrc38StagingStore) {
  return await store.knex('metadata').first()
}
async function complete(store: KnexBrc38StagingStore) {
  await readBrc38JsonStream(source(semanticStageFixture()), new Brc38SemanticStage(store, options), {
    maximumArchiveBytes: 1048576,
    maximumRowAllocationBytes: 65536
  })
}
test('owner binding and every policy are immutable across a clean partial handoff', async () => {
  const limits = resumeLimits(),
    first = await created(limits),
    stage = new Brc38SemanticStage(first, options)
  await stage.provisionalRow('outputBaskets', 0, semanticStageFixture().tables.outputBaskets[0])
  const before = await metadata(first)
  await expect(reopen(first.directory, limits)).rejects.toThrow()
  await first.close()
  await expect(first.discard(new Error('old instance'))).rejects.toThrow('handed off')
  const resumed = await reopen(first.directory, limits)
  expect(resumed.limits.expiresAt).toBe(limits.expiresAt)
  expect(await metadata(resumed)).toEqual(before)
  await complete(resumed)
  expect((await metadata(resumed)).rows).toBe(13)
  for (const table of brc38StageTables) expect(await resumed.count(table)).toBe(1)
})
test.each([
  'archiveSha256',
  'identityKey',
  'chain',
  'sourceStorageIdentityKey',
  'targetStorageIdentityKey',
  'targetGeneration'
] as const)('changed %s cannot resume or delete another binding', async field => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first.close()
  const next = { ...resumeBinding() }
  if (field === 'chain') next.chain = next.chain === 'test' ? 'main' : 'test'
  else if (field === 'targetGeneration') next.targetGeneration++
  else next[field] = field === 'archiveSha256' ? 'b'.repeat(64) : 'other'
  await expect(reopen(first.directory, limits, next)).rejects.toThrow('binding')
  expect(await readdir(first.directory)).toContain('stage.sqlite')
  const exact = await reopen(first.directory, limits)
  expect((await metadata(exact)).rows).toBe(0)
})
test.each([
  'maximumRows',
  'maximumLogicalBytes',
  'maximumPhysicalBytes',
  'maximumRowBytes',
  'maximumRowAllocationBytes',
  'expiresAt'
] as const)('changed %s cannot extend the original policy', async field => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first.close()
  await expect(reopen(first.directory, { ...limits, [field]: limits[field] + 1 })).rejects.toThrow('binding')
  const exact = await reopen(first.directory, limits)
  expect(exact.limits).toEqual(limits)
})
test('replay checks exact row bytes and keys before advancing or writing', async () => {
  const limits = resumeLimits(),
    first = await created(limits),
    stage = new Brc38SemanticStage(first, options),
    row = semanticStageFixture().tables.outputBaskets[0]
  await stage.provisionalRow('outputBaskets', 0, row)
  const original = await metadata(first)
  await first.close()
  const next = await reopen(first.directory, limits)
  await expect(
    new Brc38SemanticStage(next, options).provisionalRow('outputBaskets', 0, {
      ...row,
      name: '!efault'
    })
  ).rejects.toThrow('committed prefix')
  await expect(
    new Brc38SemanticStage(next, options).provisionalRow('outputBaskets', 0, {
      ...row,
      name: String(row.name) + 'extra'
    })
  ).rejects.toThrow('byte extent')
  expect(await metadata(next)).toEqual(original)
  await complete(next)
  const sealed = await metadata(next)
  await complete(next)
  expect(await metadata(next)).toEqual(sealed)
})
test('missing durable prefix index refuses exact replay rather than repairing provenance', async () => {
  const store = await created(),
    row = semanticStageFixture().tables.outputBaskets[0]
  await new Brc38SemanticStage(store, options).provisionalRow('outputBaskets', 0, row)
  await store.knex('unique_keys').where({ namespace: 'outputBaskets' }).delete()
  await expect(new Brc38SemanticStage(store, options).provisionalRow('outputBaskets', 0, row)).rejects.toThrow(
    'unique index'
  )
  expect(await store.count('outputBaskets')).toBe(1)
})
test('expired original deadline refuses reopening without deleting private state', async () => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first.close()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt)
  try {
    await expect(reopen(first.directory, limits)).rejects.toThrow('limit')
    expect(await readdir(first.directory)).toContain('stage.sqlite')
  } finally {
    clock.mockRestore()
  }
})
test('unsafe files refuse under the owner and failed reopen releases its own lock', async () => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first.close()
  await writeFile(join(first.directory, 'unexpected'), 'synthetic', { mode: 0o600 })
  await expect(reopen(first.directory, limits)).rejects.toThrow('Unexpected file')
  await rm(join(first.directory, 'unexpected'))
  const exact = await reopen(first.directory, limits)
  await exact.close()
  await symlink(join(first.directory, 'stage.sqlite'), join(first.directory, 'stage.sqlite-journal'))
  await expect(reopen(first.directory, limits)).rejects.toThrow('Actual private file type or link count differs')
  await rm(join(first.directory, 'stage.sqlite-journal'))
  await reopen(first.directory, limits)
})
test('owned disposal removes the public resume path before releasing physical ownership', async () => {
  const store = await created(),
    directory = store.directory
  await store.discard(new Error('cancelled'))
  await store.discard(new Error('again'))
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(parent)).toEqual([])
  await expect(reopen(directory, store.limits)).rejects.toMatchObject({ code: 'ENOENT' })
})
test('forged bounded metadata refuses before exposing resume state', async () => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first
    .knex('private_binding')
    .where({ slot: 1 })
    .update({ bindingJson: 'x'.repeat(4097) })
  await first.close()
  await expect(reopen(first.directory, limits)).rejects.toThrow('byte bounds')
})
test.each(['payload', 'recordDigest'] as const)(
  'actual forged %s extent refuses before any payload selection',
  async field => {
    const store = await created(),
      row = semanticStageFixture().tables.outputBaskets[0]
    await new Brc38SemanticStage(store, options).provisionalRow('outputBaskets', 0, row)
    await store
      .knex('rows')
      .where({ tableName: 'outputBaskets', position: 0 })
      .update({ [field]: 'x'.repeat(65537) })
    const selections: string[] = [],
      listener = (query: { sql: string }) => {
        selections.push(query.sql)
      }
    store.knex.on('query', listener)
    try {
      await expect(store.row('outputBaskets', 0)).rejects.toThrow(
        field === 'payload' ? 'length is inconsistent' : 'byte bound'
      )
      await expect(new Brc38SemanticStage(store, options).provisionalRow('outputBaskets', 0, row)).rejects.toThrow(
        'byte extent'
      )
      expect(selections.some(sql => /^select\s+(?:\*|["`]?payload["`]?).*\bfrom\s+["`]?rows["`]?/i.test(sql))).toBe(
        false
      )
    } finally {
      store.knex.off('query', listener)
    }
  }
)
test.each(['state', 'rows', 'logicalBytes'] as const)(
  'forged %s scalar refuses before loading metadata',
  async field => {
    const limits = resumeLimits(),
      first = await created(limits)
    await first
      .knex('metadata')
      .where({ slot: 1 })
      .update({ [field]: 'x'.repeat(65537) })
    await first.close()
    await expect(reopen(first.directory, limits)).rejects.toThrow('counters are invalid')
  }
)
test('forged table scalar refuses a bounded lookup and cannot advance its order', async () => {
  const store = await created(),
    row = semanticStageFixture().tables.outputBaskets[0]
  await store
    .knex('table_counts')
    .where({ tableName: 'outputBaskets' })
    .update({ rows: 'x'.repeat(65537) })
  await expect(store.count('outputBaskets')).rejects.toThrow('Invalid private BRC-38 table count')
  await expect(new Brc38SemanticStage(store, options).provisionalRow('outputBaskets', 0, row)).rejects.toThrow(
    'row order is invalid'
  )
  expect((await metadata(store)).rows).toBe(0)
})
test('failed close retains physical exclusion and a retry can complete handoff', async () => {
  const limits = resumeLimits(),
    first = await created(limits),
    cause = new Error('synthetic driver teardown failure'),
    destroy = jest.spyOn(first.knex.client, 'destroy').mockRejectedValueOnce(cause)
  try {
    await expect(first.close()).rejects.toBe(cause)
    await expect(reopen(first.directory, limits)).rejects.toThrow()
    await first.close()
    const next = await reopen(first.directory, limits)
    expect(next.limits.expiresAt).toBe(limits.expiresAt)
  } finally {
    destroy.mockRestore()
  }
})
test('failed reopen teardown exposes a concrete retry owner and preserves both causes', async () => {
  const limits = resumeLimits(),
    first = await created(limits)
  await first
    .knex('private_binding')
    .where({ slot: 1 })
    .update({ digest: 'b'.repeat(64) })
  await first.close()
  const prototype = Object.getPrototypeOf(first.knex.client) as { destroy: () => Promise<void> },
    cause = new Error('synthetic reopen teardown failure'),
    destroy = jest.spyOn(prototype, 'destroy').mockRejectedValueOnce(cause)
  let retained: Brc38StagingCleanupError | undefined
  try {
    try {
      await reopen(first.directory, limits)
    } catch (failure) {
      expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
      retained = failure as Brc38StagingCleanupError
      expect(String(retained.errors[0])).toContain('inconsistent')
      expect(retained.errors[1]).toBe(cause)
    }
    expect(retained).toBeDefined()
    await expect(reopen(first.directory, limits)).rejects.toThrow()
  } finally {
    destroy.mockRestore()
    await retained?.retryCleanup()
  }
  await retained?.retryCleanup()
  await expect(reopen(first.directory, limits)).rejects.toThrow('inconsistent')
})
test.each(Array.from({ length: 15 }, (_, prefix) => prefix))(
  'actual own-child exit after private prefix %i recovers all thirteen tables without duplication',
  async prefix => {
    const limits = resumeLimits(),
      child = fork(
        join(__dirname, '../../../out/test/storage/portableResumeChild.js'),
        [parent, String(prefix), JSON.stringify(limits)],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      )
    children.push(child)
    const report = await new Promise<{ status: string; directory: string; expiresAt: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Owned staging child did not report')), 3000)
      child.once('message', value => {
        clearTimeout(timer)
        resolve(value as { status: string; directory: string; expiresAt: number })
      })
      child.once('error', cause => {
        clearTimeout(timer)
        reject(cause)
      })
    })
    expect(report.status).toBe('held')
    await expect(reopen(report.directory, limits)).rejects.toThrow()
    child.kill('SIGKILL')
    await exited(child)
    expect(child.signalCode).toBe('SIGKILL')
    const resumed = await reopen(report.directory, limits)
    expect((await metadata(resumed)).rows).toBe(Math.min(prefix, 13))
    expect(resumed.limits.expiresAt).toBe(report.expiresAt)
    await complete(resumed)
    expect((await metadata(resumed)).state).toBe('sealed')
    expect((await metadata(resumed)).rows).toBe(13)
    for (const table of brc38StageTables)
      expect(await resumed.row(table, 0)).toEqual(semanticStageFixture().tables[table][0])
    const inspection = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(report.directory, 'stage.sqlite') },
      useNullAsDefault: true
    })
    try {
      expect(await inspection('sqlite_master').where({ name: 'users' }).first()).toBeUndefined()
    } finally {
      await inspection.destroy()
    }
  }
)
test.each([
  { archiveSha256: 'wrong' },
  { identityKey: '' },
  { sourceStorageIdentityKey: '' },
  { targetStorageIdentityKey: '' },
  { targetGeneration: -1 },
  { targetGeneration: 1.5 },
  { chain: 'other' }
])('invalid binding %j refuses before creating a private directory', async override => {
  await expect(
    KnexBrc38StagingStore.createOwned(parent, resumeLimits(), {
      ...resumeBinding(),
      ...override
    } as Brc38StagingBinding)
  ).rejects.toThrow()
  expect(await readdir(parent)).toEqual([])
})
test('binding scalar order is stable and caller mutation cannot change retained binding', () => {
  const selected = { ...resumeBinding() },
    limits = resumeLimits(),
    original = brc38StagingBinding(selected, limits)
  selected.targetGeneration++
  expect(original.binding.targetGeneration).toBe(7)
  expect(original.digest).toBe(brc38StagingBinding(resumeBinding(), limits).digest)
})
