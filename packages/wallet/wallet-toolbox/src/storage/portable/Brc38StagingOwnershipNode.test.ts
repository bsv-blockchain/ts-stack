import createKnex from 'knex'
import Database from 'better-sqlite3'
import { fork, type ChildProcess } from 'node:child_process'
import { chmod, lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Brc38StagingOwnershipNode } from './Brc38StagingOwnershipNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

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

test('failed actual SQLite connection setup closes the raw connection and preserves its cause', async () => {
  const cause = new Error('Actual private owner connection setup failed'),
    original = Database.prototype.exec
  const observed: { connection?: Database.Database } = {}
  const fault = jest.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    if (this.name === join(directory, 'brc38-owner.sqlite') && sql.includes('PRAGMA busy_timeout=0')) {
      observed.connection = this
      throw cause
    }
    return original.call(this, sql)
  })
  try {
    await expect(
      Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000).then(owner => {
        owners.push(owner)
        return owner
      })
    ).rejects.toBe(cause)
    expect(observed.connection).toBeDefined()
    expect(observed.connection?.open).toBe(false)
  } finally {
    fault.mockRestore()
    if (observed.connection?.open === true) observed.connection.close()
  }
})

test('failed setup and repeated physical close retain the same actual connection for retry', async () => {
  const cause = new Error('Actual setup failed before pool ownership'),
    cleanupCause = new Error('Actual raw connection close failed'),
    originalExec = Database.prototype.exec,
    originalClose = Database.prototype.close
  const observed: { connection?: Database.Database } = {}
  let closeAttempts = 0
  const setup = jest.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
      if (this.name === join(directory, 'brc38-owner.sqlite') && sql.includes('PRAGMA busy_timeout=0')) {
        observed.connection = this
        throw cause
      }
      return originalExec.call(this, sql)
    }),
    close = jest.spyOn(Database.prototype, 'close').mockImplementation(function (this: Database.Database) {
      if (this === observed.connection && ++closeAttempts <= 2) throw cleanupCause
      return originalClose.call(this)
    })
  try {
    let failure: unknown
    try {
      owners.push(await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000))
    } catch (error_) {
      failure = error_
    }
    expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
    const retained = failure as Brc38StagingCleanupError
    expect(retained.errors[0]).toBeInstanceOf(Brc38StagingCleanupError)
    expect((retained.errors[0] as Brc38StagingCleanupError).errors).toEqual([cause, cleanupCause])
    expect(observed.connection?.open).toBe(true)
    expect(closeAttempts).toBe(2)
    await retained.retryCleanup()
    await retained.retryCleanup()
    expect(observed.connection?.open).toBe(false)
    expect(closeAttempts).toBe(3)
  } finally {
    setup.mockRestore()
    close.mockRestore()
    if (observed.connection?.open === true) observed.connection.close()
  }
})

test.each([
  ['directory', 'different directory'],
  ['expiry', 'different expiry']
] as const)('current source rejects its %s mismatch before using the actual owner', async kind => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  await expect(
    owner.assertCurrentSource(
      kind === 'directory' ? join(directory, 'other') : directory,
      digest,
      kind === 'expiry' ? expiry + 1 : expiry
    )
  ).rejects.toThrow('Structured source requires its actual private staging claim')
})

test.each(['rollback', 'close'] as const)('current source refuses a physically %s original transaction', async mode => {
  const observed: { raw?: Database.Database } = {}
  const original = Database.prototype.exec,
    capture = jest.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
      if (this.name === join(directory, 'brc38-owner.sqlite')) observed.raw = this
      return original.call(this, sql)
    })
  try {
    const expiry = Date.now() + 60000,
      owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
    owners.push(owner)
    capture.mockRestore()
    const raw = observed.raw
    if (raw === undefined) throw new Error('Actual owner raw connection was not observed')
    expect(raw.inTransaction).toBe(true)
    if (mode === 'rollback') raw.exec('ROLLBACK')
    else raw.close()
    await expect(owner.assertCurrentSource(directory, digest, expiry)).rejects.toThrow(
      'Structured source lost its actual private kernel transaction'
    )
  } finally {
    capture.mockRestore()
  }
})

test.each(['missing', 'protocol', 'binding', 'expiresAt'] as const)(
  'current source rereads actual pinned owner SQL after %s corruption',
  async kind => {
    const observed: { raw?: Database.Database } = {}
    const original = Database.prototype.exec,
      capture = jest.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
        if (this.name === join(directory, 'brc38-owner.sqlite')) observed.raw = this
        return original.call(this, sql)
      })
    try {
      const expiry = Date.now() + 60000,
        owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
      owners.push(owner)
      capture.mockRestore()
      const raw = observed.raw
      if (raw === undefined) throw new Error('Actual owner raw connection was not observed')
      if (kind === 'missing') raw.prepare('DELETE FROM owner WHERE slot = 1').run()
      else raw.prepare(`UPDATE owner SET ${kind} = ? WHERE slot = 1`).run(kind === 'expiresAt' ? expiry + 1 : 'damaged')
      await expect(owner.assertCurrentSource(directory, digest, expiry)).rejects.toThrow(
        'Structured source current kernel binding differs'
      )
    } finally {
      capture.mockRestore()
    }
  }
)

test.each([0, -1, 1.5, NaN, Infinity])(
  'cleanup rejects invalid original deadline %s before file creation',
  async expiry => {
    await expect(Brc38StagingOwnershipNode.claimForCleanup(directory, digest, expiry, false)).rejects.toThrow(
      'Invalid original private import deadline'
    )
    expect(await readdir(directory)).toEqual([])
  }
)

test.each(['x' + digest, digest + 'x'])('digest anchors refuse the entire malformed value %s', async value => {
  await expect(Brc38StagingOwnershipNode.create(directory, value, Date.now() + 60000)).rejects.toThrow(
    'A fixed private import binding digest is required'
  )
  expect(await readdir(directory)).toEqual([])
})

test('cleanup of an existing owner retains its exact original persisted deadline', async () => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  await owner.release()
  await expect(Brc38StagingOwnershipNode.claimForCleanup(directory, digest, expiry + 1, false)).rejects.toThrow(
    'Private import owner binding or metadata is invalid'
  )
  const cleanup = await Brc38StagingOwnershipNode.claimForCleanup(directory, digest, expiry, false)
  owners.push(cleanup)
  expect(cleanup.expiresAt).toBe(expiry)
  expect(cleanup.purpose).toBe('cleanup')
  expect(() => cleanup.assertLive()).toThrow('Private import ownership is unavailable or expired')
})

test.each([false, true])(
  'only the actual locked root disposes an incomplete owner; owner table=%s',
  async tablePresent => {
    const { Brc38StagingAdmissionNode } = await import('./Brc38StagingAdmissionNode'),
      { resumeLimits, resumeBinding } = await import('./Brc38ResumeFixture'),
      { brc38StagingBinding } = await import('./Brc38StagingBinding'),
      limits = resumeLimits(),
      expectedBinding = brc38StagingBinding(resumeBinding(), limits).digest,
      id = randomUUID(),
      root = await Brc38StagingAdmissionNode.create(directory, {
        maximumImports: 3,
        maximumPhysicalBytes: 15728640,
        maximumLogicalBytes: 3145728
      })
    let clock: jest.SpyInstance | undefined,
      observed = 0
    const originalClaim = Brc38StagingOwnershipNode.claimForCleanup,
      claim = jest.spyOn(Brc38StagingOwnershipNode, 'claimForCleanup').mockImplementation(async (...args) => {
        const owner = await originalClaim.apply(Brc38StagingOwnershipNode, args)
        owners.push(owner)
        expect(args).toEqual([join(directory, id), expectedBinding, limits.expiresAt, true])
        expect(owner.binding).toBe(expectedBinding)
        expect(owner.expiresAt).toBe(limits.expiresAt)
        expect(owner.purpose).toBe('cleanup')
        expect(() => owner.assertLive()).toThrow('Private import ownership is unavailable or expired')
        observed++
        return owner
      })
    try {
      await root.knex('reservations').insert({
        id,
        digest: expectedBinding,
        expiresAt: limits.expiresAt,
        maximumPhysicalBytes: limits.maximumPhysicalBytes,
        maximumLogicalBytes: limits.maximumLogicalBytes,
        state: 'reserved'
      })
      const fs = await import('node:fs/promises')
      await fs.mkdir(join(directory, id), { mode: 0o700 })
      const file = await fs.open(join(directory, id, 'brc38-owner.sqlite'), 'wx', 0o600)
      await file.close()
      if (tablePresent) {
        const raw = new Database(join(directory, id, 'brc38-owner.sqlite'))
        try {
          raw.exec('CREATE TABLE owner (slot INTEGER PRIMARY KEY, protocol TEXT, binding TEXT, expiresAt INTEGER)')
        } finally {
          raw.close()
        }
      }
      clock = jest.spyOn(Date, 'now').mockReturnValue(limits.expiresAt + 1)
      expect(await root.collectExpired(3)).toBe(1)
      expect(observed).toBe(1)
      expect((await root.usage()).imports).toBe(0)
      expect(await readdir(directory)).not.toContain(id)
    } finally {
      clock?.mockRestore()
      claim.mockRestore()
      await root.close()
    }
  }
)

test('a constructor with the wrong issuer cannot enroll a second wrapper around the actual owned connection', async () => {
  const expiry = Date.now() + 60000,
    owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
  owners.push(owner)
  const actual = await lstat(join(directory, 'brc38-owner.sqlite'), { bigint: true })
  // Negative admission only. The original owner still closes the one actual
  // connection if a guard mutant unexpectedly returns a second wrapper.
  expect(() =>
    Reflect.construct(Brc38StagingOwnershipNode, [
      Reflect.get(owner, 'db'),
      Reflect.get(owner, 'connection'),
      directory,
      digest,
      expiry,
      'resume',
      { dev: actual.dev.toString(), ino: actual.ino.toString() },
      Symbol('unissued owner'),
      performance.now() + 60000
    ])
  ).toThrow('Private staging owner requires its actual factory')
  await owner.assertCurrentSource(directory, digest, expiry)
})

test.each([0, 1])(
  'the actual owner database physical 16384-byte boundary retains its exact comparison, excess=%s',
  async excess => {
    const expiry = Date.now() + 60000,
      owner = await Brc38StagingOwnershipNode.create(directory, digest, expiry)
    owners.push(owner)
    await owner.release()
    // Inspect and resize the same opened file, preserving the exact physical
    // boundary without reopening a path after checking its state.
    const file = await open(join(directory, 'brc38-owner.sqlite'), 'r+')
    try {
      expect((await file.stat()).size).toBeLessThanOrEqual(16384)
      await file.truncate(16384 + excess)
    } finally {
      await file.close()
    }
    if (excess === 0) {
      const next = await claim()
      expect(next.expiresAt).toBe(expiry)
      expect(next.binding).toBe(digest)
    } else
      await expect(Brc38StagingOwnershipNode.claimExisting(directory, digest)).rejects.toThrow(
        'Invalid private import ownership database'
      )
  }
)
test.each(['dev', 'ino'] as const)(
  'claim independently refuses changed %s returned by an actual owner-file stat',
  async field => {
    const fs = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
      original = fs.lstat
    let calls = 0
    const fault = jest.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      const actual = await Reflect.apply(original, fs, args)
      if (args[0] === join(directory, 'brc38-owner.sqlite') && ++calls === 2)
        Reflect.set(actual, field, Reflect.get(actual, field) + 1n)
      return actual
    })
    try {
      await expect(
        Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000).then(owner => {
          owners.push(owner)
          return owner
        })
      ).rejects.toThrow('Private ownership file was replaced while acquiring its lock')
    } finally {
      fault.mockRestore()
    }
  }
)
test('the exact original 24-hour ownership ceiling remains valid', async () => {
  const now = Date.now(),
    clock = jest.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const owner = await Brc38StagingOwnershipNode.create(directory, digest, now + 86400000)
    owners.push(owner)
    expect(owner.expiresAt).toBe(now + 86400000)
    owner.assertLive()
  } finally {
    clock.mockRestore()
  }
})
test.each(['release', 'destroy'] as const)(
  'failed actual pool %s retains retired ownership for physical retry',
  async phase => {
    const owner = await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
    owners.push(owner)
    const db = Reflect.get(owner, 'db') as ReturnType<typeof createKnex>,
      release = jest.spyOn(db.client, 'releaseConnection'),
      cause = new Error('Actual private owner teardown refused'),
      fault =
        phase === 'release'
          ? release.mockRejectedValueOnce(cause)
          : jest.spyOn(db.client, 'destroy').mockRejectedValueOnce(cause)
    try {
      await expect(owner.release()).rejects.toBe(cause)
      expect(() => owner.assertLive()).toThrow('Private import ownership is unavailable or expired')
      await owner.release()
      await owner.release()
      expect(release).toHaveBeenCalledTimes(phase === 'release' ? 2 : 1)
      const next = await claim()
      next.assertLive()
    } finally {
      fault.mockRestore()
      release.mockRestore()
    }
  }
)
test('concurrent teardown cannot release the same actual pinned connection twice', async () => {
  const owner = await Brc38StagingOwnershipNode.create(directory, digest, Date.now() + 60000)
  owners.push(owner)
  const db = Reflect.get(owner, 'db') as ReturnType<typeof createKnex>,
    original = db.client.releaseConnection
  let unblock!: () => void
  const gate = new Promise<void>(resolve => {
      unblock = resolve
    }),
    release = jest.spyOn(db.client, 'releaseConnection').mockImplementation(async connection => {
      await original.call(db.client, connection)
      await gate
    }),
    first = owner.release()
  try {
    expect(() => owner.assertLive()).toThrow('Private import ownership is unavailable or expired')
    await expect(owner.release()).rejects.toThrow('Private ownership teardown is already running')
    expect(release).toHaveBeenCalledTimes(1)
  } finally {
    unblock()
    await first
    release.mockRestore()
  }
})
