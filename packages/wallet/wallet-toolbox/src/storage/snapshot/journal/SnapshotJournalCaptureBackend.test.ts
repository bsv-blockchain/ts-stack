import { knex, type Knex } from 'knex'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Duplex } from 'node:stream'
import { createHash } from 'node:crypto'
import {
  prepareSnapshotJournalCaptureBackend,
  bindSnapshotJournalCaptureBackend,
  closeSnapshotJournalCapturePool
} from './SnapshotJournalCaptureBackend'
import { withSnapshotJournalConnections, SnapshotJournalConnectionCleanupError } from './SnapshotJournalConnections'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
function sqlite(filename: string) {
  return knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 }
  })
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-capture-backend-'))
  const filename = join(directory, 'wallet.sqlite')
  const writer = sqlite(filename),
    reader = sqlite(filename)
  await writer.raw('PRAGMA journal_mode = WAL')
  return {
    directory,
    filename,
    writer,
    reader,
    close: async () => {
      await Promise.allSettled([writer.destroy(), reader.destroy()])
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('fresh independent SQLite pools bind one existing file and physically close both reserved native connections', async () => {
  const f = await fixture()
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(f.writer.client.config)
    const connections: Array<{ open: boolean }> = []
    const digest = await withSnapshotJournalConnections(
      f.writer,
      f.reader,
      () => undefined,
      async (write, read) => {
        connections.push(write as { open: boolean }, read as { open: boolean })
        return await bindSnapshotJournalCaptureBackend(f.writer, write, f.reader, read, expected)
      },
      closeSnapshotJournalCapturePool
    )
    expect(digest).toBe(
      createHash('sha256')
        .update('snapshot-journal-backend-v1\n')
        .update(JSON.stringify(['sqlite', expected.kind === 'sqlite' ? expected.file : undefined]))
        .digest('hex')
    )
    expect(connections).toHaveLength(2)
    expect(connections.map(value => value.open)).toEqual([false, false])
    expect(f.writer.client.pool).toBeUndefined()
    expect(f.reader.client.pool).toBeUndefined()
  } finally {
    await f.close()
  }
})

test('a replaced SQLite pathname after preparation refuses the source before its barrier callback', async () => {
  const f = await fixture()
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(f.writer.client.config)
    await f.writer.destroy()
    await rename(f.filename, join(f.directory, 'original.sqlite'))
    await writeFile(f.filename, '')
    const writer = sqlite(f.filename)
    const barrier = jest.fn(async () => undefined)
    await expect(
      withSnapshotJournalConnections(
        writer,
        f.reader,
        () => undefined,
        async (write, read) => {
          await bindSnapshotJournalCaptureBackend(writer, write, f.reader, read, expected)
          await barrier()
        },
        closeSnapshotJournalCapturePool
      )
    ).rejects.toThrow('changed')
    expect(barrier).not.toHaveBeenCalled()
  } finally {
    await f.close()
  }
})

test('different SQLite reader and writer files refuse even when configured within the same directory', async () => {
  const f = await fixture(),
    other = sqlite(join(f.directory, 'other.sqlite'))
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(f.writer.client.config)
    await expect(
      withSnapshotJournalConnections(
        f.writer,
        other,
        () => undefined,
        async (write, read) => {
          return await bindSnapshotJournalCaptureBackend(f.writer, write, other, read, expected)
        },
        closeSnapshotJournalCapturePool
      )
    ).rejects.toThrow('changed')
  } finally {
    await other.destroy()
    await f.close()
  }
})

test.each([
  { client: 'better-sqlite3', connection: { filename: ':memory:' } },
  { client: 'better-sqlite3', connection: { filename: 'file:shared?mode=memory' } },
  { client: 'mysql2', connection: async () => ({ database: 'wallet' }) },
  { client: 'mysql2', connection: { database: 'wallet' }, connectionPool: {} },
  { client: 'pg', connection: { database: 'wallet' } },
  { client: 'mysql', connection: { database: 'wallet' } },
  { client: 'mysql2', connection: { database: 7 } },
  { client: 'better-sqlite3', connection: { filename: '' } },
  { client: 'better-sqlite3', connection: { filename: 1 } },
  { client: 'mysql2', connection: 'synthetic' },
  { client: 'mysql2', connection: null }
])('unsupported backend configuration refuses before constructing an owned pool: %#', async config => {
  await expect(prepareSnapshotJournalCaptureBackend(config as Knex.Config)).rejects.toThrow('unavailable')
})

let nativeConnectionId = 0
function mysqlIdentity(
  serverUuid: unknown,
  databaseName: unknown,
  connectionId: unknown = String(++nativeConnectionId),
  rows?: unknown[]
) {
  const owner = knex({
    client: 'mysql2',
    connection: { database: 'synthetic' },
    pool: { min: 0, max: 1 }
  })
  const query = owner.raw('SELECT 1')
  query.connection = jest.fn().mockReturnValue(Promise.resolve([rows ?? [{ serverUuid, databaseName, connectionId }]]))
  jest.spyOn(owner.client, 'raw').mockReturnValue(query)
  return owner
}
const uuid = 'aabbccdd-1234-4321-aabb-112233445566'

test('MySQL binds the actual server and database returned by both exact reserved connections', async () => {
  const writer = mysqlIdentity(uuid.toUpperCase(), 'synthetic'),
    reader = mysqlIdentity(uuid, 'synthetic')
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(writer.client.config)
    const writerConnection = {},
      readerConnection = {}
    expect(await bindSnapshotJournalCaptureBackend(writer, writerConnection, reader, readerConnection, expected)).toBe(
      createHash('sha256')
        .update('snapshot-journal-backend-v1\n')
        .update(JSON.stringify(['mysql', { serverUuid: uuid, database: 'synthetic' }]))
        .digest('hex')
    )
    const sql =
      'SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName, CAST(CONNECTION_ID() AS CHAR) AS connectionId'
    expect(writer.client.raw).toHaveBeenCalledWith(sql)
    expect(reader.client.raw).toHaveBeenCalledWith(sql)
    expect(writer.client.raw(sql).connection).toHaveBeenCalledWith(writerConnection)
    expect(reader.client.raw(sql).connection).toHaveBeenCalledWith(readerConnection)
  } finally {
    await writer.destroy()
    await reader.destroy()
    jest.restoreAllMocks()
  }
})

test.each([
  ['different server', 'ffeeddcc-1234-4321-aabb-112233445566', 'synthetic'],
  ['different database', uuid, 'other'],
  ['invalid uuid', 'g'.repeat(36), 'synthetic'],
  ['missing uuid', undefined, 'synthetic'],
  ['uuid prefix', 'x' + uuid, 'synthetic'],
  ['uuid suffix', uuid + 'x', 'synthetic'],
  ['nonstring database', uuid, 7],
  ['empty database', uuid, ''],
  ['oversized database', uuid, 'é'.repeat(129)]
])('MySQL actual identity refuses %s', async (_label, serverUuid, databaseName) => {
  const writer = mysqlIdentity(uuid, 'synthetic'),
    reader = mysqlIdentity(serverUuid, databaseName)
  try {
    await expect(bindSnapshotJournalCaptureBackend(writer, {}, reader, {}, { kind: 'mysql' })).rejects.toThrow(
      'changed'
    )
  } finally {
    await writer.destroy()
    await reader.destroy()
    jest.restoreAllMocks()
  }
})

test('graceful MySQL quit does not establish physical cleanup until the socket close event', async () => {
  const owner = knex({
    client: 'mysql2',
    connection: { database: 'synthetic' },
    pool: { min: 0, max: 1 }
  })
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
    }
  })
  const entered = gate(),
    allow = gate()
  jest.spyOn(owner.client, 'destroy').mockImplementation(async () => {
    entered.resolve()
    await allow.promise
  })
  jest.spyOn(owner.client, 'releaseConnection').mockResolvedValue(undefined)
  let closed = false
  try {
    const cleanup = closeSnapshotJournalCapturePool(owner, { stream }).then(() => {
      closed = true
    })
    await entered.promise
    allow.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(stream.listenerCount('close')).toBe(1)
    stream.destroy()
    await cleanup
    expect(stream.closed).toBe(true)
    expect(closed).toBe(true)
    expect(stream.listenerCount('close')).toBe(0)
  } finally {
    allow.resolve()
    stream.destroy()
    jest.restoreAllMocks()
    await owner.destroy()
  }
})

test('physical cleanup refusal is typed and retains both source and native release failures', async () => {
  const f = await fixture()
  const release = f.writer.client.releaseConnection.bind(f.writer.client)
  let held: unknown
  jest.spyOn(f.writer.client, 'releaseConnection').mockRejectedValue(new Error('release failed'))
  try {
    const operation = withSnapshotJournalConnections(
      f.writer,
      f.reader,
      () => undefined,
      async write => {
        held = write
        throw new Error('source failed')
      },
      async (owner, connection) => {
        if (owner === f.writer) {
          await owner.client.releaseConnection(connection)
        } else await closeSnapshotJournalCapturePool(owner, connection)
      }
    )
    await expect(operation).rejects.toBeInstanceOf(SnapshotJournalConnectionCleanupError)
    await expect(operation).rejects.toMatchObject({
      cause: {
        errors: [
          expect.objectContaining({ message: 'source failed' }),
          expect.objectContaining({ message: 'release failed' })
        ]
      }
    })
  } finally {
    jest.restoreAllMocks()
    if (held !== undefined) await release(held)
    await f.close()
  }
})

test.each(['0', '01', 1, '18446744073709551616', '12x', 'x12', '1x'])(
  'MySQL refuses invalid actual native connection identity %p',
  async id => {
    const writer = mysqlIdentity(uuid, 'synthetic', id),
      reader = mysqlIdentity(uuid, 'synthetic')
    try {
      const expected = await prepareSnapshotJournalCaptureBackend(writer.client.config)
      await expect(bindSnapshotJournalCaptureBackend(writer, {}, reader, {}, expected)).rejects.toThrow('changed')
    } finally {
      await writer.destroy()
      await reader.destroy()
      jest.restoreAllMocks()
    }
  }
)

test('distinct pool objects cannot publish two handles addressing the same native MySQL connection', async () => {
  const writer = mysqlIdentity(uuid, 'synthetic', '42'),
    reader = mysqlIdentity(uuid, 'synthetic', '42')
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(writer.client.config)
    await expect(bindSnapshotJournalCaptureBackend(writer, {}, reader, {}, expected)).rejects.toThrow('changed')
  } finally {
    await writer.destroy()
    await reader.destroy()
    jest.restoreAllMocks()
  }
})

test('backend preparation rejects a directory even when its pathname exists', async () => {
  const f = await fixture()
  try {
    await expect(
      prepareSnapshotJournalCaptureBackend({ client: 'better-sqlite3', connection: { filename: f.directory } })
    ).rejects.toThrow('unavailable')
  } finally {
    await f.close()
  }
})

test.each([
  { rows: [] },
  {
    rows: [
      { serverUuid: uuid, databaseName: 'synthetic', connectionId: '1' },
      { serverUuid: uuid, databaseName: 'synthetic', connectionId: '2' }
    ]
  }
])('MySQL refuses a non-singleton native identity result %#', async ({ rows }) => {
  const writer = mysqlIdentity(uuid, 'synthetic', '3', rows),
    reader = mysqlIdentity(uuid, 'synthetic', '4')
  try {
    await expect(bindSnapshotJournalCaptureBackend(writer, {}, reader, {}, { kind: 'mysql' })).rejects.toThrow(
      'changed'
    )
  } finally {
    jest.restoreAllMocks()
    await Promise.all([writer.destroy(), reader.destroy()])
  }
})

test('MySQL accepts exact 256 UTF8 database bytes and the unsigned64 connection boundary', async () => {
  const database = 'é'.repeat(128)
  const writer = mysqlIdentity(uuid, database, '18446744073709551615'),
    reader = mysqlIdentity(uuid, database, '1')
  try {
    expect(await bindSnapshotJournalCaptureBackend(writer, {}, reader, {}, { kind: 'mysql' })).toBe(
      createHash('sha256')
        .update('snapshot-journal-backend-v1\n')
        .update(JSON.stringify(['mysql', { serverUuid: uuid, database }]))
        .digest('hex')
    )
  } finally {
    jest.restoreAllMocks()
    await Promise.all([writer.destroy(), reader.destroy()])
  }
})

test('native pool destruction failures retain every cause and remove the close listener', async () => {
  const owner = mysqlIdentity(uuid, 'synthetic')
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback()
    }
  })
  const destroyFailure = new Error('destroy failed'),
    releaseFailure = new Error('release failed')
  jest.spyOn(owner.client, 'destroy').mockRejectedValue(destroyFailure)
  jest.spyOn(owner.client, 'releaseConnection').mockRejectedValue(releaseFailure)
  try {
    await expect(closeSnapshotJournalCapturePool(owner, { stream })).rejects.toMatchObject({
      message: 'Snapshot capture pool did not close',
      errors: [destroyFailure, releaseFailure]
    })
    expect(stream.listenerCount('close')).toBe(0)
  } finally {
    stream.destroy()
    jest.restoreAllMocks()
    await owner.destroy()
  }
})

test.each(['better-sqlite3', 'mysql2'])(
  'successful pool calls cannot claim an unclosed %s native handle',
  async client => {
    const owner = knex({
      client,
      connection: client === 'better-sqlite3' ? { filename: ':memory:' } : { database: 'synthetic' },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
    jest.spyOn(owner.client, 'destroy').mockResolvedValue(undefined)
    jest.spyOn(owner.client, 'releaseConnection').mockResolvedValue(undefined)
    try {
      await expect(closeSnapshotJournalCapturePool(owner, { open: true })).rejects.toThrow(
        'Snapshot capture native connection did not close'
      )
    } finally {
      jest.restoreAllMocks()
      await owner.destroy()
    }
  }
)

test('fresh native connection IDs do not change the durable backend binding', async () => {
  const pools = [
    mysqlIdentity(uuid, 'synthetic', '1'),
    mysqlIdentity(uuid, 'synthetic', '2'),
    mysqlIdentity(uuid, 'synthetic', '3'),
    mysqlIdentity(uuid, 'synthetic', '4')
  ]
  try {
    const expected = await prepareSnapshotJournalCaptureBackend(pools[0].client.config)
    expect(await bindSnapshotJournalCaptureBackend(pools[0], {}, pools[1], {}, expected)).toBe(
      await bindSnapshotJournalCaptureBackend(pools[2], {}, pools[3], {}, expected)
    )
  } finally {
    await Promise.all(pools.map(pool => pool.destroy()))
    jest.restoreAllMocks()
  }
})
