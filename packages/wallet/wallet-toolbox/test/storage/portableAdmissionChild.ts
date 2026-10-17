import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import {
  Brc38StagingAdmissionNode,
  type Brc38StagingCapacity
} from '../../src/storage/portable/Brc38StagingAdmissionNode'
import { KnexBrc38StagingStore, type KnexBrc38StagingLimits } from '../../src/storage/portable/KnexBrc38StagingStore'
import { resumeBinding } from '../../src/storage/portable/Brc38ResumeFixture'
import { Client } from 'knex'

function queryTargets(connection: unknown, request: unknown, filename: string): boolean {
  if (
    typeof connection !== 'object' ||
    connection === null ||
    !('name' in connection) ||
    typeof connection.name !== 'string'
  )
    return false
  let sql: unknown = request
  if (typeof request === 'object' && request !== null && 'sql' in request) sql = request.sql
  return basename(connection.name) === filename && typeof sql === 'string' && sql.trim().toUpperCase() === 'COMMIT;'
}

/** Synthetic test child only. No arbitrary PID or production path is accepted
 * by the parent: it kills and awaits only the ChildProcess it just registered. */
async function run(): Promise<void> {
  const args = process.argv.slice(2),
    directory = args.at(0),
    capacityText = args.at(1),
    limitsText = args.at(2),
    phase = args.at(3)
  if (
    directory === undefined ||
    capacityText === undefined ||
    limitsText === undefined ||
    !['reserved', 'created', 'ready', 'retired', 'deleted', 'owner-uncommitted', 'schema-uncommitted'].includes(
      phase ?? ''
    ) ||
    process.send === undefined
  )
    throw new Error('Owned admission child requires its synthetic fixture and IPC')
  const capacity = JSON.parse(capacityText) as Brc38StagingCapacity
  const limits = JSON.parse(limitsText) as KnexBrc38StagingLimits
  const root = await Brc38StagingAdmissionNode.reopen(directory, capacity)
  let id = ''
  const query = Client.prototype.query
  Client.prototype.query = function (connection: unknown, request: unknown): unknown {
    if (
      (phase === 'owner-uncommitted' && queryTargets(connection, request, 'brc38-owner.sqlite')) ||
      (phase === 'schema-uncommitted' && queryTargets(connection, request, 'stage.sqlite'))
    ) {
      process.send?.({ id })
      // Test-owned child only: stop immediately before the real SQL commit.
      // The parent kills and awaits this registered child within three seconds.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)
    }
    return query.call(this, connection, request)
  }
  async function held(selected: string): Promise<never> {
    process.send?.({ id: selected })
    return await new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Owned admission fixture hold expired')), 10000)
    })
  }
  const create = KnexBrc38StagingStore.createOwnedAt
  KnexBrc38StagingStore.createOwnedAt = async (...args) => {
    id = basename(args[0])
    if (phase === 'reserved') return await held(id)
    const store = await create.apply(KnexBrc38StagingStore, args)
    if (phase === 'created') return await held(id)
    return store
  }
  const remove = fs.rm
  fs.rm = async (path, ...args) => {
    if (String(path).endsWith('.retired') && phase === 'retired') return await held(id)
    await remove(path, ...args)
    if (String(path).endsWith('.retired') && phase === 'deleted') return await held(id)
  }
  try {
    const reservation = await root.admit(limits, resumeBinding())
    if (phase === 'ready') await held(reservation.id)
    await root.discard(reservation, new Error('synthetic fixture finish'))
  } finally {
    KnexBrc38StagingStore.createOwnedAt = create
    fs.rm = remove
    Client.prototype.query = query
    await root.close()
  }
}
if (require.main === module) {
  void run().catch(() => {
    process.exitCode = 1
    process.disconnect?.()
  })
}
