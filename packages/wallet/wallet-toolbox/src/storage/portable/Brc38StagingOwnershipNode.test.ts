import createKnex from 'knex'
import { fork, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38StagingOwnershipNode } from './Brc38StagingOwnershipNode'

const digest = 'a'.repeat(64)
let directory = '',
  owners: Brc38StagingOwnershipNode[] = [],
  children: ChildProcess[] = []
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'brc38-owner-test-'))
  owners = []
  children = []
})
async function exit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owned ownership fixture did not exit within 2 seconds')), 2000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit(child)
  }
  for (const owner of owners) await owner.release()
  await rm(directory, { recursive: true, force: true })
})
async function child(mode: 'create' | 'claim' | 'probe') {
  const value = fork(
    join(__dirname, '../../../out/test/storage/portableOwnershipChild.js'),
    [directory, mode, digest],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }
  )
  children.push(value)
  const ready = await new Promise<{ status: string; expiresAt: number; message?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Owned ownership fixture did not report within 2 seconds')), 2000)
    value.once('message', result => {
      clearTimeout(timeout)
      resolve(result as { status: string; expiresAt: number; message?: string })
    })
    value.once('error', cause => {
      clearTimeout(timeout)
      reject(cause)
    })
  })
  return { process: value, ready }
}
async function claim() {
  const owner = await Brc38StagingOwnershipNode.claimExisting(directory, digest)
  owners.push(owner)
  return owner
}
test('the exact private binding and fixed expiry persist after a clean handoff', async () => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  owner.assertLive()
  expect((await lstat(join(directory, 'brc38-owner.sqlite'))).mode & 0o777).toBe(0o600)
  await expect(Brc38StagingOwnershipNode.claimExisting(directory, digest)).rejects.toThrow()
  await owner.release()
  await owner.release()
  expect(() => owner.assertLive()).toThrow('unavailable')
  const next = await claim()
  expect(next.expiresAt).toBe(expiry)
  expect(next.binding).toBe(digest)
  next.assertLive()
})
test('current source admission checks the real pinned transaction and rejects copied ownership', async () => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  await expect(owner.assertCurrentSource(directory, digest, expiry)).resolves.toBeUndefined()
  await expect(owner.assertCurrentSource(directory, 'b'.repeat(64), expiry)).rejects.toThrow(
    'actual private staging claim'
  )
  await expect(
    Brc38StagingOwnershipNode.prototype.assertCurrentSource.call({ ...owner }, directory, digest, expiry)
  ).rejects.toThrow('actual private staging claim')
  await owner.release()
  await expect(owner.assertCurrentSource(directory, digest, expiry)).rejects.toThrow('unavailable')
})
test('another real process is refused while the live owner remains pinned', async () => {
  const owner = await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
  owners.push(owner)
  const probe = await child('probe')
  expect(probe.ready.status).toBe('refused')
  await exit(probe.process)
  owner.assertLive()
  await owner.release()
  const after = await child('probe')
  expect(after.ready.status).toBe('acquired')
  await exit(after.process)
})
test('actual owned process termination releases the kernel lock without renewing its lease', async () => {
  const first = await child('create')
  expect(first.ready.status).toBe('held')
  await expect(Brc38StagingOwnershipNode.claimExisting(directory, digest)).rejects.toThrow()
  first.process.kill('SIGKILL')
  await exit(first.process)
  expect(first.process.signalCode).toBe('SIGKILL')
  const recovered = await claim()
  expect(recovered.expiresAt).toBe(first.ready.expiresAt)
  recovered.assertLive()
})
test('bounded commits on a separate real staging DB never release the owner lock', async () => {
  const owner = await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
  owners.push(owner)
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: join(directory, 'synthetic-stage.sqlite') },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await db.schema.createTable('counter', table => {
      table.integer('slot').primary()
      table.integer('position').notNullable()
    })
    await db('counter').insert({ slot: 1, position: 0 })
    for (let position = 1; position <= 3; position++) {
      await db.transaction(async trx => {
        await trx('counter').where({ slot: 1 }).update({ position })
      })
      const probe = await child('probe')
      expect(probe.ready.status).toBe('refused')
      await exit(probe.process)
      expect((await db('counter').first()).position).toBe(position)
    }
  } finally {
    await db.destroy()
  }
})
test('expired ownership does not become a writable resumed owner; cleanup can claim after physical release', async () => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  await owner.release()
  const clock = jest.spyOn(Date, 'now').mockReturnValue(expiry)
  try {
    await expect(Brc38StagingOwnershipNode.claimExisting(directory, digest)).rejects.toThrow('expired')
    const cleanup = await Brc38StagingOwnershipNode.claimExisting(directory, digest, 'cleanup')
    owners.push(cleanup)
    expect(() => cleanup.assertLive()).toThrow('unavailable')
    expect(cleanup.expiresAt).toBe(expiry)
  } finally {
    clock.mockRestore()
  }
})
test('a wrong binding refuses without deleting or changing the private owner file', async () => {
  const owner = await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
  owners.push(owner)
  await owner.release()
  await expect(Brc38StagingOwnershipNode.claimExisting(directory, 'b'.repeat(64))).rejects.toThrow('binding')
  expect(await readdir(directory)).toContain('brc38-owner.sqlite')
  expect((await claim()).binding).toBe(digest)
})
test('missing owner file refuses instead of creating a guessed recovery database', async () => {
  await expect(Brc38StagingOwnershipNode.claimExisting(directory, digest)).rejects.toMatchObject({
    code: 'ENOENT'
  })
  expect(await readdir(directory)).toEqual([])
})
test('a public directory and malformed ownership parameters refuse before creating files', async () => {
  await expect(Brc38StagingOwnershipNode.create(directory, 'invalid', Date.now() + 60000)).rejects.toThrow('digest')
  await expect(Brc38StagingOwnershipNode.create(directory, digest, Date.now())).rejects.toThrow('deadline')
  await chmod(directory, 0o755)
  await expect(Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)).rejects.toThrow(
    'Actual Unix private ownership or mode differs'
  )
  expect(await readdir(directory)).toEqual([])
})
