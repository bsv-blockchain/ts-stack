import { requireKnexPrimaryCopies } from './KnexPrimaryHandoffCopies'
import {
  canonicalPrimaryHandoffPlan,
  primaryHandoffIdentity as identity,
  primaryHandoffOperation as operation
} from './PrimaryHandoffPlan'
export { canonicalPrimaryHandoffPlan } from './PrimaryHandoffPlan'
import type { Knex } from 'knex'
import type { StorageKnex } from './StorageKnex'
import type { AuthId } from '../sdk/WalletStorage.interfaces'
import type {
  PrimaryHandoffControl,
  PrimaryHandoffPlan,
  PrimaryHandoffStatus,
  PrimaryHandoffControlOptions
} from './PrimaryHandoffControl'
import { WERR_INVALID_OPERATION, WERR_NOT_ACTIVE, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'
import {
  PRIMARY_HANDOFF_KEY,
  PRIMARY_HANDOFF_COPIES,
  PRIMARY_HANDOFF_MIGRATION,
  PRIMARY_HANDOFF_TABLE,
  verifyPrimaryHandoffSchema
} from './schema/primaryHandoffMigration'

const fields = {
  operationId: 32,
  localStorageIdentityKey: 130,
  targetStorageIdentityKey: 130,
  side: 6,
  phase: 16,
  sourceEpoch: 19,
  localEpoch: 19,
  plan: 8192,
  roleGateFrom: 130,
  roleGateTo: 130,
  roleGateEpoch: 19
} as const
function invalid(message = 'Primary handoff intent is invalid or conflicts with pending control'): never {
  throw new WERR_INVALID_OPERATION(message)
}
interface Role {
  activeStorage: string | null
  epoch: string
}
/** Bound to one actual provider/root. Every method owns a short real SQL
 * transaction and authenticates the actual user; caller isActive is ignored. */
export async function createKnexPrimaryHandoffControl(
  storage: StorageKnex,
  options: PrimaryHandoffControlOptions = {}
): Promise<PrimaryHandoffControl | undefined> {
  const signal = options.signal
  signal?.throwIfAborted()
  const root = storage.knex,
    local = storage.getSettings().storageIdentityKey
  const migrations = root.client.config.migrations?.tableName ?? 'knex_migrations'
  const installed = await root.schema.hasTable(PRIMARY_HANDOFF_TABLE)
  const stamps = await root(migrations).where('name', PRIMARY_HANDOFF_MIGRATION).select('name').limit(2)
  if (!installed && stamps.length === 0) return undefined
  if (!installed || stamps.length !== 1) invalid('Primary handoff migration is incomplete')
  await verifyPrimaryHandoffSchema(root)
  const mysql = String(root.client.config.client).includes('mysql')
  const readRole = async (k: Knex, auth: AuthId): Promise<Role> => {
    const users: Array<{ identityKey: string; activeStorage: string | null }> = await k('users')
      .where({ userId: auth.userId })
      .select(
        k.raw('substr(??,1,131) AS ??', ['identityKey', 'identityKey']),
        k.raw('substr(??,1,131) AS ??', ['activeStorage', 'activeStorage'])
      )
      .limit(2)
    const settings: Array<{ storageIdentityKey: string; chain: string }> = await k('settings')
      .select(k.raw('substr(??,1,131) AS ??', ['storageIdentityKey', 'storageIdentityKey']), 'chain')
      .limit(2)
    const epochs: Array<{ epoch: string }> = await k('snapshot_sync_primary_epochs')
      .where({ userId: auth.userId })
      .select(k.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
      .limit(2)
    if (
      users.length !== 1 ||
      users[0].identityKey.toLowerCase() !== auth.identityKey.toLowerCase() ||
      settings.length !== 1 ||
      settings[0].storageIdentityKey !== local ||
      settings[0].chain !== storage.chain ||
      epochs.length > 1
    )
      throw new WERR_UNAUTHORIZED()
    const activeStorage = users[0].activeStorage
    if (activeStorage !== null) identity(activeStorage)
    return { activeStorage, epoch: snapshotJournalRevision(epochs[0]?.epoch ?? '0') }
  }
  const read = async (k: Knex, userId: number): Promise<Record<string, unknown> | undefined> => {
    const rows: Array<Record<string, unknown>> = await k(PRIMARY_HANDOFF_TABLE)
      .where({ userId, sourceKey: PRIMARY_HANDOFF_KEY })
      .select(
        'version',
        ...Object.entries(fields).map(([key, size]) => k.raw('substr(??,1,?) AS ??', [key, size + 1, key]))
      )
      .limit(2)
    if (rows.length > 1) invalid()
    return rows[0]
  }
  const decode = (row: Record<string, unknown>, role: Role): PrimaryHandoffStatus => {
    if (
      row.version !== 1 ||
      row.localStorageIdentityKey !== local ||
      row.localEpoch !== role.epoch ||
      row.roleGateFrom !== null ||
      row.roleGateTo !== null ||
      row.roleGateEpoch !== null ||
      !['source', 'target', 'backup'].includes(String(row.side)) ||
      !['prepared', 'retired', 'activated', 'complete', 'cancelled'].includes(String(row.phase))
    )
      invalid()
    const target = identity(row.targetStorageIdentityKey)
    let plan: PrimaryHandoffPlan | undefined
    if (row.plan !== null) {
      if (typeof row.plan !== 'string' || row.plan.length > 8192) invalid()
      try {
        plan = canonicalPrimaryHandoffPlan(JSON.parse(row.plan))
      } catch {
        invalid()
      }
      if (
        JSON.stringify(plan) !== row.plan ||
        plan.operationId !== row.operationId ||
        plan.targetStorageIdentityKey !== target
      )
        invalid()
    }
    const side = row.side as PrimaryHandoffStatus['side'],
      phase = row.phase as PrimaryHandoffStatus['phase']
    const sourceEpoch = row.sourceEpoch === null ? undefined : snapshotJournalRevision(row.sourceEpoch)
    if (side === 'source') {
      if (
        target === local ||
        sourceEpoch === undefined ||
        !['prepared', 'retired', 'complete', 'cancelled'].includes(phase) ||
        (phase === 'prepared' || phase === 'cancelled'
          ? role.activeStorage !== local || role.epoch !== sourceEpoch
          : role.activeStorage !== target || BigInt(role.epoch) !== BigInt(sourceEpoch) + 1n || plan === undefined)
      )
        invalid()
      if (plan != null && plan.sources.find(source => source.storageIdentityKey === local)?.epoch !== sourceEpoch)
        invalid()
    } else if (side === 'backup') {
      if (
        target === local ||
        phase !== 'complete' ||
        sourceEpoch !== undefined ||
        plan === undefined ||
        role.activeStorage !== target
      )
        invalid()
    } else if (
      target !== local ||
      !['prepared', 'activated', 'complete', 'cancelled'].includes(phase) ||
      sourceEpoch !== undefined ||
      plan === undefined ||
      (phase === 'activated' || phase === 'complete'
        ? role.activeStorage !== local
        : !plan.sources.some(source => source.storageIdentityKey === role.activeStorage))
    )
      invalid()
    return {
      version: 1,
      operationId: operation(row.operationId),
      localStorageIdentityKey: local,
      targetStorageIdentityKey: target,
      side,
      phase,
      localEpoch: role.epoch,
      ...(sourceEpoch === undefined ? {} : { sourceEpoch }),
      ...(plan === undefined ? {} : { plan })
    }
  }
  const transaction = async <T>(
    auth: AuthId,
    body: (k: Knex.Transaction, role: Role, auth: AuthId) => Promise<T>,
    journal = true
  ): Promise<T> => {
    const actor: AuthId = { userId: auth.userId, identityKey: auth.identityKey }
    signal?.throwIfAborted()
    if (storage.knex !== root || !(await storage.supportsPrimaryWriteFences()))
      invalid('Primary control provider is unavailable or changed')
    if (
      !Number.isSafeInteger(actor.userId) ||
      actor.userId! < 1 ||
      typeof actor.identityKey !== 'string' ||
      !actor.identityKey ||
      actor.identityKey.length > 130
    )
      throw new WERR_UNAUTHORIZED()
    const apply = async (token: unknown): Promise<T> => {
      const k = token as Knex.Transaction
      if (!k.isTransaction || k.isCompleted() || storage.toDb(k) !== k) invalid()
      if (mysql) {
        if ((await k('users').where({ userId: actor.userId }).select('userId').limit(2).forUpdate()).length !== 1)
          throw new WERR_UNAUTHORIZED()
        await k('snapshot_sync_primary_epochs').where({ userId: actor.userId }).select('userId').limit(2).forUpdate()
        await k('settings').select('storageIdentityKey').limit(2).forShare()
      } else if (
        (await k('users')
          .where({ userId: actor.userId })
          .update({ userId: k.ref('userId') })) !== 1
      )
        throw new WERR_UNAUTHORIZED()
      await verifyPrimaryHandoffSchema(k)
      const role = await readRole(k, actor)
      const result = await body(k, role, actor)
      await verifyPrimaryHandoffSchema(k)
      const saved = await read(k, actor.userId!)
      if (saved != null) decode(saved, await readRole(k, actor))
      return result
    }
    return journal
      ? await storage.runSnapshotJournalWriter(async token => await apply(token), undefined, signal)
      : await storage.transaction(async token => await apply(token))
  }
  const insert = async (
    k: Knex,
    auth: AuthId,
    operationId: string,
    target: string,
    side: PrimaryHandoffStatus['side'],
    role: Role,
    plan?: PrimaryHandoffPlan
  ) => {
    await k(PRIMARY_HANDOFF_TABLE).insert({
      userId: auth.userId,
      sourceKey: PRIMARY_HANDOFF_KEY,
      version: 1,
      operationId,
      localStorageIdentityKey: local,
      targetStorageIdentityKey: target,
      side,
      phase: 'prepared',
      sourceEpoch: side === 'source' ? role.epoch : null,
      localEpoch: role.epoch,
      plan: plan === undefined ? null : JSON.stringify(plan),
      roleGateFrom: null,
      roleGateTo: null,
      roleGateEpoch: null
    })
  }
  const changeRole = async (k: Knex, auth: AuthId, before: Role, next: string): Promise<Role> => {
    if (before.activeStorage === next) return before
    if (before.activeStorage === null) invalid()
    if (
      (await k(PRIMARY_HANDOFF_TABLE)
        .where({ userId: auth.userId, sourceKey: PRIMARY_HANDOFF_KEY })
        .update({ roleGateFrom: before.activeStorage, roleGateTo: next, roleGateEpoch: before.epoch })) !== 1
    )
      invalid()
    if ((await storage.updateUser(auth.userId!, { activeStorage: next }, k)) !== 1) invalid()
    const after = await readRole(k, auth)
    if (after.activeStorage !== next || BigInt(after.epoch) !== BigInt(before.epoch) + 1n) invalid()
    return after
  }
  const replaceFinished = async (
    k: Knex,
    auth: AuthId,
    current: PrimaryHandoffStatus,
    nextId: string
  ): Promise<boolean> => {
    if (!['complete', 'cancelled'].includes(current.phase) || current.operationId === nextId) return false
    await k(PRIMARY_HANDOFF_COPIES).where({ userId: auth.userId }).delete()
    if (
      (await k(PRIMARY_HANDOFF_TABLE)
        .where({
          userId: auth.userId,
          sourceKey: PRIMARY_HANDOFF_KEY,
          operationId: current.operationId,
          phase: current.phase
        })
        .delete()) !== 1
    )
      invalid()
    return true
  }
  const matching = (current: PrimaryHandoffStatus, plan: PrimaryHandoffPlan, side: 'source' | 'target') => {
    if (
      current.side !== side ||
      current.operationId !== plan.operationId ||
      current.targetStorageIdentityKey !== plan.targetStorageIdentityKey ||
      JSON.stringify(current.plan) !== JSON.stringify(plan)
    )
      invalid()
  }
  const finish = async (auth: AuthId, input: PrimaryHandoffPlan, side: 'source' | 'target') => {
    const plan = canonicalPrimaryHandoffPlan(input)
    return await transaction(auth, async (k, role, actor) => {
      const row = await read(k, actor.userId!)
      if (row === undefined) invalid()
      const current = decode(row, role)
      matching(current, plan, side)
      if (current.phase === 'complete') return current
      if (current.phase !== (side === 'source' ? 'retired' : 'activated')) invalid()
      await k(PRIMARY_HANDOFF_TABLE)
        .where({ userId: actor.userId, sourceKey: PRIMARY_HANDOFF_KEY })
        .update({ phase: 'complete' })
      return decode((await read(k, actor.userId!))!, role)
    })
  }
  const status = async (auth: AuthId) =>
    await transaction(auth, async (k, role, auth) => {
      const row = await read(k, auth.userId!)
      return row == null ? undefined : decode(row, role)
    })
  return {
    status,
    prepareSource: async (auth, id, targetInput) => {
      const operationId = operation(id),
        target = identity(targetInput)
      if (target === local) invalid()
      return await transaction(auth, async (k, role, auth) => {
        const row = await read(k, auth.userId!)
        if (row != null) {
          const current = decode(row, role)
          if (!(await replaceFinished(k, auth, current, operationId))) {
            if (
              current.side !== 'source' ||
              current.operationId !== operationId ||
              current.targetStorageIdentityKey !== target ||
              current.phase === 'cancelled'
            )
              invalid()
            return { storageIdentityKey: local, epoch: current.sourceEpoch! }
          }
        }
        if (role.activeStorage !== local)
          throw new WERR_NOT_ACTIVE('Only the actual current primary may prepare retirement')
        await insert(k, auth, operationId, target, 'source', role)
        return { storageIdentityKey: local, epoch: role.epoch }
      })
    },
    prepareTarget: async (auth, input) => {
      const plan = canonicalPrimaryHandoffPlan(input)
      if (plan.targetStorageIdentityKey !== local) invalid()
      return await transaction(auth, async (k, role, auth) => {
        const row = await read(k, auth.userId!)
        if (row != null) {
          const current = decode(row, role)
          if (!(await replaceFinished(k, auth, current, plan.operationId))) {
            matching(current, plan, 'target')
            if (current.phase === 'cancelled') invalid()
            return current
          }
        }
        if (
          role.activeStorage !== local &&
          !plan.sources.some(source => source.storageIdentityKey === role.activeStorage)
        )
          invalid()
        await insert(k, auth, plan.operationId, local, 'target', role, plan)
        const parked = await changeRole(k, auth, role, plan.sources[0].storageIdentityKey)
        await k(PRIMARY_HANDOFF_TABLE)
          .where({ userId: auth.userId, sourceKey: PRIMARY_HANDOFF_KEY })
          .update({ localEpoch: parked.epoch })
        return decode((await read(k, auth.userId!))!, parked)
      })
    },
    retireSource: async (auth, input) => {
      const plan = canonicalPrimaryHandoffPlan(input)
      return await transaction(auth, async (k, role, auth) => {
        const row = await read(k, auth.userId!)
        if (row == null) invalid()
        const current = decode(row, role)
        if (
          current.side !== 'source' ||
          current.operationId !== plan.operationId ||
          current.targetStorageIdentityKey !== plan.targetStorageIdentityKey ||
          plan.sources.find(source => source.storageIdentityKey === local)?.epoch !== current.sourceEpoch ||
          (current.plan !== undefined && JSON.stringify(current.plan) !== JSON.stringify(plan))
        )
          invalid()
        if (current.phase === 'retired' || current.phase === 'complete') return current
        if (current.phase !== 'prepared') invalid()
        const after = await changeRole(k, auth, role, plan.targetStorageIdentityKey)
        await k(PRIMARY_HANDOFF_TABLE)
          .where({ userId: auth.userId, sourceKey: PRIMARY_HANDOFF_KEY })
          .update({ plan: JSON.stringify(plan), phase: 'retired', localEpoch: after.epoch })
        return decode((await read(k, auth.userId!))!, after)
      })
    },
    activateTarget: async (auth, input) => {
      const plan = canonicalPrimaryHandoffPlan(input)
      return await transaction(
        auth,
        async (k, role, actor) => {
          const row = await read(k, actor.userId!)
          if (row === undefined) invalid()
          const current = decode(row, role)
          matching(current, plan, 'target')
          if (current.phase === 'activated' || current.phase === 'complete') return current
          if (current.phase !== 'prepared') invalid()
          const final = await requireKnexPrimaryCopies(storage, k, actor.userId!, actor.identityKey, plan)
          const after = await changeRole(k, actor, role, local)
          await k(PRIMARY_HANDOFF_TABLE)
            .where({ userId: actor.userId, sourceKey: PRIMARY_HANDOFF_KEY })
            .update({ phase: 'activated', localEpoch: after.epoch })
          await final.receipts.recordPrimarySelection(k, final.binding, final.checkpoint, local)
          return decode((await read(k, actor.userId!))!, after)
        },
        true
      )
    },
    followTarget: async (auth, input) => {
      const plan = canonicalPrimaryHandoffPlan(input)
      if (plan.targetStorageIdentityKey === local) invalid()
      return await transaction(auth, async (k, role, actor) => {
        const row = await read(k, actor.userId!)
        if (row !== undefined) {
          const current = decode(row, role)
          if (
            current.side === 'backup' &&
            current.phase === 'complete' &&
            JSON.stringify(current.plan) === JSON.stringify(plan)
          )
            return current
          if (!(await replaceFinished(k, actor, current, plan.operationId))) invalid()
        }
        // Every genuinely writable participant must prepare, retire and copy
        // as a declared source. A backup follow can never skip that sequence.
        if (
          role.activeStorage === local ||
          (role.activeStorage !== plan.targetStorageIdentityKey &&
            !plan.sources.some(source => source.storageIdentityKey === role.activeStorage))
        )
          invalid()
        await insert(k, actor, plan.operationId, plan.targetStorageIdentityKey, 'backup', role, plan)
        const after = await changeRole(k, actor, role, plan.targetStorageIdentityKey)
        await k(PRIMARY_HANDOFF_TABLE)
          .where({ userId: actor.userId, sourceKey: PRIMARY_HANDOFF_KEY })
          .update({ phase: 'complete', localEpoch: after.epoch })
        return decode((await read(k, actor.userId!))!, after)
      })
    },
    completeSource: async (auth, plan) => await finish(auth, plan, 'source'),
    completeTarget: async (auth, plan) => await finish(auth, plan, 'target'),
    cancel: async (auth, id) => {
      const operationId = operation(id)
      return await transaction(auth, async (k, role, actor) => {
        const row = await read(k, actor.userId!)
        if (row === undefined) invalid()
        const current = decode(row, role)
        if (current.operationId !== operationId) invalid()
        if (current.phase === 'cancelled') return current
        if (current.phase !== 'prepared') invalid('A retired or activated primary must recover forward')
        await k(PRIMARY_HANDOFF_TABLE)
          .where({ userId: actor.userId, sourceKey: PRIMARY_HANDOFF_KEY })
          .update({ phase: 'cancelled' })
        return decode((await read(k, actor.userId!))!, role)
      })
    }
  }
}
