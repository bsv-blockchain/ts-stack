import createKnex, { type Knex } from 'knex'
import { requirePrivatePath } from './Brc38PrivateFilesystemNode'
import { join } from 'node:path'
import { Brc38ProfileInventoryNode, type Brc38RetiredNativeReadGrant } from './Brc38ProfileInventoryNode'
import {
  readForwardOriginalProfileRow,
  fixedProfile,
  type Row,
  type FixedProfile
} from './Brc38PublishedProfileReceiptNode'
import { readBrc38NativeRetirement, type Brc38NativeRetirementRecord } from './Brc38NativeRetirementNode'
import { assertBrc38ProfilePhysicalIdentity } from './Brc38ProfilePhysicalIdentityNode'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38ProfileInventoryBinding } from './Brc38PublishedProfileNode'

export interface Brc38RetiredNativeReadPolicy {
  readonly expiresAt: number
  readonly maximumReadBytes: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly signal?: AbortSignal
}
export interface Brc38RetiredNativeReadFacts {
  readonly directory: string
  readonly binding: Readonly<{ identityKey: string; chain: 'main' | 'test'; targetStorageIdentityKey: string }>
  readonly wallet: Readonly<{ device: string; inode: string }>
  readonly retirement: Readonly<Brc38NativeRetirementRecord>
  readonly policy: Readonly<Brc38RetiredNativeReadPolicy>
  readonly deadline: number
}
interface Session {
  readonly identity?: object
}
interface Driver {
  NativeProfileSqlite: {
    startRetiredForReadClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: Session; failure?: unknown }>>
    startComposedRetiredForReadClaim(
      executable: string,
      directory: string,
      fixedJson: string,
      binding: string
    ): Promise<Readonly<{ session: Session; failure?: unknown }>>
  }
  nativeKnex(knex: typeof createKnex, client: unknown, session: Session, slot: number): Knex
  nativeTransactionIdentity(k: Knex.Transaction): Readonly<{ token: object; slot: number }> | undefined
  isRetiredReadSession(session: Session): boolean
  drainStartedNativeSession(session: Session): Promise<
    Readonly<{
      failed: boolean
      failure?: unknown
      terminal: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>
    }>
  >
}
let transport: Driver | undefined
function driver(): Driver {
  transport ??= require('./NativeProfileSqlite.cjs') as Driver
  return transport
}
const issuer = Object.freeze({}),
  actors = new WeakSet<Brc38RetiredNativeReadNode>(),
  transactions = new WeakMap<Knex.Transaction, Brc38RetiredNativeReadNode>()
function invalid(): never {
  throw new Error('Retired native read differs from its original inventory, physical owner or lineage')
}

async function loadOriginal(
  directory: string
): Promise<Readonly<{ original: Row; retirement: Readonly<Brc38NativeRetirementRecord> }>> {
  const filename = join(directory, 'profile.sqlite'),
    before = await requirePrivatePath(filename, false)
  if (before.size > 65536n) invalid()
  const k = createKnex({
    client: 'better-sqlite3',
    connection: { filename, options: { readonly: true } },
    useNullAsDefault: true,
    acquireConnectionTimeout: 1000,
    pool: { min: 1, max: 1 }
  })
  let failure: { cause: unknown } | undefined
  const cleanupScope1 = new Brc38CleanupScope(async () => {
    try {
      await k.destroy()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [...(failure === undefined ? [] : [failure.cause]), error_],
        'Original retired catalog loader retains its physical read facade',
        async () => await k.destroy()
      )
    }
  })
  try {
    const value = await k.transaction(async read => {
        const retirement = await readBrc38NativeRetirement(read)
        if (retirement === undefined) invalid()
        return Object.freeze({ original: await readForwardOriginalProfileRow(read), retirement })
      }),
      after = await requirePrivatePath(filename, false)
    if (after.size > 65536n || after.dev !== before.dev || after.ino !== before.ino) invalid()
    return value
  } catch (cause) {
    failure = { cause }
    {
      await cleanupScope1.close()
      throw cause
    }
  } finally {
    await cleanupScope1.close()
  }
}

/** Actual inventory-owned, readonly historical profile reader. It verifies
 * original retired catalog lineage and physical identity after claiming the
 * separate kernel, and retains ONE coherent physical wallet transaction.
 * This is reader lifecycle only: the caller must independently inspect full
 * source schema/rows/bytes and the exact forward target. No writer, ACTIVE
 * provider, publication, semantic verdict or selection is enrolled here. */
export class Brc38RetiredNativeReadNode {
  readonly #io = new Brc38OwnedImportReads()
  #live = true
  #transaction?: Knex.Transaction
  #walletScopeReads?: Brc38OwnedImportReads
  #token?: object
  readonly #root: Brc38ProfileInventoryNode
  readonly #grant: Brc38RetiredNativeReadGrant
  readonly #session: Session
  readonly #catalog: Knex
  readonly #original: Row
  readonly #fixed: FixedProfile
  readonly #retirement: Readonly<Brc38NativeRetirementRecord>
  readonly #policy: Readonly<Brc38RetiredNativeReadPolicy>
  readonly #deadline: number
  readonly #directory: string
  private constructor(
    token: object,
    root: Brc38ProfileInventoryNode,
    grant: Brc38RetiredNativeReadGrant,
    session: Session,
    catalog: Knex,
    original: Row,
    fixed: FixedProfile,
    retirement: Readonly<Brc38NativeRetirementRecord>,
    directory: string,
    policy: Readonly<Brc38RetiredNativeReadPolicy>,
    deadline: number
  ) {
    if (token !== issuer) invalid()
    this.#root = root
    this.#grant = grant
    this.#session = session
    this.#catalog = catalog
    this.#original = original
    this.#fixed = fixed
    this.#retirement = retirement
    this.#directory = directory
    this.#policy = policy
    this.#deadline = deadline
    actors.add(this)
  }
  static capturePolicy(selected: Brc38RetiredNativeReadPolicy): Readonly<Brc38RetiredNativeReadPolicy> {
    const workingAllocation = brc38WorkingAllocation(selected.workingAllocation)
    if (workingAllocation === undefined) invalid()
    const value: Readonly<Brc38RetiredNativeReadPolicy> = Object.freeze({
        expiresAt: selected.expiresAt,
        maximumReadBytes: selected.maximumReadBytes,
        workingAllocation,
        signal: selected.signal
      }),
      lifetime = value.expiresAt - Date.now()
    if (
      !Number.isSafeInteger(value.expiresAt) ||
      lifetime < 1 ||
      lifetime > 3600000 ||
      !Number.isSafeInteger(value.maximumReadBytes) ||
      value.maximumReadBytes < 1 ||
      value.maximumReadBytes > 16384
    )
      invalid()
    value.signal?.throwIfAborted()
    return value
  }
  #available(): void {
    this.#policy.signal?.throwIfAborted()
    if (
      !actors.has(this) ||
      !this.#live ||
      Date.now() >= this.#policy.expiresAt ||
      performance.now() >= this.#deadline ||
      !driver().isRetiredReadSession(this.#session)
    )
      invalid()
    Brc38ProfileInventoryNode.assertRetiredNativeReadGrant(this.#root, this.#grant)
  }
  static isReadTransaction(k: Knex.Transaction): boolean {
    const actor = transactions.get(k),
      identity = transport?.nativeTransactionIdentity(k)
    if (
      actor === undefined ||
      identity?.slot !== 3 ||
      actor.#transaction !== k ||
      actor.#token !== identity.token ||
      k.isCompleted()
    )
      return false
    try {
      actor.#available()
      return true
    } catch {
      return false
    }
  }
  static assertReadOwner(
    actor: Brc38RetiredNativeReadNode,
    read: Knex.Transaction,
    working: Brc38WorkingAllocation,
    expiresAt: number,
    maximumReadBytes: number,
    signal?: AbortSignal
  ): void {
    if (
      !actors.has(actor) ||
      actor.#transaction !== read ||
      transactions.get(read) !== actor ||
      !Brc38RetiredNativeReadNode.isReadTransaction(read) ||
      actor.#policy.workingAllocation !== working ||
      actor.#policy.expiresAt !== expiresAt ||
      actor.#policy.maximumReadBytes !== maximumReadBytes ||
      actor.#policy.signal !== signal
    )
      invalid()
    actor.#available()
  }
  async #verify(): Promise<void> {
    this.#available()
    const current = await Brc38ProfileInventoryNode.readRetiredNativeReadGrant(this.#root, this.#grant)
    if (
      current.directory !== this.#directory ||
      current.bindingSha256 !== this.#fixed.bindingSha256 ||
      JSON.stringify(current.inventory) !== JSON.stringify(this.#fixed.inventory) ||
      JSON.stringify(current.binding) !== JSON.stringify(this.#fixed.binding) ||
      JSON.stringify(current.limits) !== JSON.stringify(this.#fixed.limits) ||
      JSON.stringify(current.admission) !== JSON.stringify(this.#fixed.admission) ||
      current.policy.workingAllocation !== this.#policy.workingAllocation ||
      current.policy.signal !== this.#policy.signal ||
      current.policy.expiresAt !== this.#policy.expiresAt ||
      current.policy.maximumReadBytes !== this.#policy.maximumReadBytes ||
      current.deadline !== this.#deadline
    )
      invalid()
    const retirement = await readBrc38NativeRetirement(this.#catalog),
      original = await readForwardOriginalProfileRow(this.#catalog)
    if (
      JSON.stringify(retirement) !== JSON.stringify(this.#retirement) ||
      JSON.stringify(original) !== JSON.stringify(this.#original)
    )
      invalid()
    await assertBrc38ProfilePhysicalIdentity(this.#directory, this.#fixed.physicalIdentity!, true)
    this.#available()
  }
  /** Statistics/coordinates remain DATA. Original kernel and catalog checks
   * are repeated around this operation; no prior retirement read is admitted. */
  static readRetirement(actor: Brc38RetiredNativeReadNode): Promise<Readonly<Brc38NativeRetirementRecord>> {
    if (!actors.has(actor)) invalid()
    return actor.#io.run(async () => {
      await actor.#verify()
      return actor.#retirement
    })
  }
  /** Fresh original catalog DATA inside this actor's already-owned coherent
   * wallet callback. The nested read is drained by that same callback; it
   * cannot join or renew a reader scope after the callback has settled. */
  static readSourceLineageInWalletScope(
    actor: Brc38RetiredNativeReadNode,
    read: Knex.Transaction
  ): Promise<
    Readonly<{
      inventory: Readonly<Brc38ProfileInventoryBinding>
      fixedSha256: string
      copySha256: string
      copyBytes: number
      retirement: Readonly<Brc38NativeRetirementRecord>
    }>
  > {
    if (
      !actors.has(actor) ||
      actor.#transaction !== read ||
      transactions.get(read) !== actor ||
      !Brc38RetiredNativeReadNode.isReadTransaction(read) ||
      actor.#walletScopeReads === undefined
    )
      invalid()
    return actor.#walletScopeReads.run(async () => {
      await actor.#verify()
      const row = await readForwardOriginalProfileRow(actor.#catalog),
        fixed = fixedProfile(row, actor.#fixed.bindingSha256),
        retirement = await readBrc38NativeRetirement(actor.#catalog)
      if (
        retirement === undefined ||
        !['brc38-published-profile/v2', 'brc38-published-profile/v3'].includes(fixed.protocol) ||
        fixed.inventory === undefined ||
        row.copySha256 === null ||
        row.copyBytes === null ||
        JSON.stringify(row) !== JSON.stringify(actor.#original) ||
        JSON.stringify(retirement) !== JSON.stringify(actor.#retirement) ||
        !Brc38RetiredNativeReadNode.isReadTransaction(read)
      )
        invalid()
      await actor.#verify()
      return Object.freeze({
        inventory: Object.freeze({ ...fixed.inventory }),
        fixedSha256: row.fixedSha256,
        copySha256: row.copySha256,
        copyBytes: row.copyBytes,
        retirement
      })
    })
  }
  static withWalletRead<T>(
    actor: Brc38RetiredNativeReadNode,
    work: (read: Knex.Transaction, facts: Readonly<Brc38RetiredNativeReadFacts>) => Promise<T>
  ): Promise<T> {
    if (!actors.has(actor) || typeof work !== 'function') invalid()
    return actor.#io.run(async () => {
      await actor.#verify()
      const read = actor.#transaction
      if (read === undefined || !Brc38RetiredNativeReadNode.isReadTransaction(read)) invalid()
      const facts: Readonly<Brc38RetiredNativeReadFacts> = Object.freeze({
        directory: actor.#directory,
        binding: Object.freeze({
          identityKey: actor.#fixed.binding.identityKey,
          chain: actor.#fixed.binding.chain,
          targetStorageIdentityKey: actor.#fixed.binding.targetStorageIdentityKey
        }),
        wallet: Object.freeze({ ...actor.#fixed.physicalIdentity!.wallet! }),
        retirement: actor.#retirement,
        policy: actor.#policy,
        deadline: actor.#deadline
      })
      const nested = new Brc38OwnedImportReads()
      if (actor.#walletScopeReads !== undefined) invalid()
      actor.#walletScopeReads = nested
      try {
        const value = await nested.retain(async () => await work(read, facts))
        if (!Brc38RetiredNativeReadNode.isReadTransaction(read)) invalid()
        await actor.#verify()
        return value
      } finally {
        if (actor.#walletScopeReads === nested) actor.#walletScopeReads = undefined
      }
    })
  }
  static async withInventory<T>(
    root: Brc38ProfileInventoryNode,
    grant: Brc38RetiredNativeReadGrant,
    executable: string,
    selected: Brc38RetiredNativeReadPolicy,
    work: (reader: Brc38RetiredNativeReadNode) => Promise<T>
  ): Promise<T> {
    const policy = Brc38RetiredNativeReadNode.capturePolicy(selected),
      data = await Brc38ProfileInventoryNode.readRetiredNativeReadGrant(root, grant)
    if (
      typeof executable !== 'string' ||
      !executable.startsWith('/') ||
      executable.length > 4096 ||
      typeof work !== 'function' ||
      policy.workingAllocation !== data.policy.workingAllocation ||
      policy.signal !== data.policy.signal ||
      policy.expiresAt !== data.policy.expiresAt ||
      policy.maximumReadBytes !== data.policy.maximumReadBytes
    )
      invalid()
    const charge = policy.workingAllocation.claim(1048576)
    let actor: Brc38RetiredNativeReadNode | undefined,
      attempt: Awaited<ReturnType<Driver['NativeProfileSqlite']['startRetiredForReadClaim']>> | undefined,
      catalog: Knex | undefined,
      wallet: Knex | undefined,
      terminalDrained = false,
      failure: { cause: unknown } | undefined,
      retainedLoader: Brc38StagingCleanupError | undefined
    const cleanup = async (): Promise<void> => {
      if (retainedLoader !== undefined) {
        await retainedLoader.retryCleanup()
        retainedLoader = undefined
      }
      const settled = await Promise.allSettled([wallet?.destroy(), catalog?.destroy()]),
        errors = settled.flatMap(value => (value.status === 'rejected' ? [value.reason] : []))
      if (errors.length !== 0)
        throw new AggregateError(errors, 'Retired reader retains its original physical SQL facades')
      if (attempt !== undefined && !terminalDrained) {
        const actual = await driver().drainStartedNativeSession(attempt.session)
        terminalDrained = true
        if (actual.failed) throw actual.failure ?? new Error('Retired reader kernel closed with failure')
      }
    }
    const cleanupScope2 = new Brc38CleanupScope(async () => {
      if (actor !== undefined) actor.#live = false
      try {
        // Loader teardown still owns physical memory. Its concrete retry must
        // finish before this enclosing charge can be released; do not close
        // the allowance merely because no native kernel was started yet.
        if (retainedLoader !== undefined) throw retainedLoader
        await cleanup()
        charge.close()
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          [...(failure === undefined ? [] : [failure.cause]), cause],
          'Retired reader retains its original physical owner and working allocation',
          async () => {
            await cleanup()
            charge.close()
          }
        )
      }
    })
    try {
      const initial = await loadOriginal(data.directory),
        fixed = fixedProfile(initial.original, data.bindingSha256)
      if (
        !['brc38-published-profile/v2', 'brc38-published-profile/v3'].includes(fixed.protocol) ||
        fixed.physicalIdentity?.wallet === undefined ||
        JSON.stringify(fixed.inventory) !== JSON.stringify(data.inventory) ||
        JSON.stringify(fixed.binding) !== JSON.stringify(data.binding) ||
        JSON.stringify(fixed.limits) !== JSON.stringify(data.limits) ||
        JSON.stringify(fixed.admission) !== JSON.stringify(data.admission)
      )
        invalid()
      Brc38ProfileInventoryNode.assertRetiredNativeReadGrant(root, grant)
      attempt =
        fixed.protocol === 'brc38-published-profile/v3'
          ? await driver().NativeProfileSqlite.startComposedRetiredForReadClaim(
              executable,
              data.directory,
              initial.original.fixedJson,
              data.bindingSha256
            )
          : await driver().NativeProfileSqlite.startRetiredForReadClaim(
              executable,
              data.directory,
              initial.original.fixedJson,
              data.bindingSha256
            )
      if (attempt.failure !== undefined) throw attempt.failure
      const client: unknown = require('knex/lib/dialects/sqlite3/index.js')
      catalog = driver().nativeKnex(createKnex, client, attempt.session, 2)
      wallet = driver().nativeKnex(createKnex, client, attempt.session, 3)
      actor = new Brc38RetiredNativeReadNode(
        issuer,
        root,
        grant,
        attempt.session,
        catalog,
        initial.original,
        fixed,
        initial.retirement,
        data.directory,
        policy,
        data.deadline
      )
      Object.freeze(actor)
      await actor.#verify()
      const actual = actor
      return await wallet.transaction(async read => {
        const identity = driver().nativeTransactionIdentity(read)
        if (identity?.slot !== 3) invalid()
        actual.#transaction = read
        actual.#token = identity.token
        transactions.set(read, actual)
        try {
          const value = await actual.#io.retain(async () => {
            await actual.#verify()
            return await work(actual)
          })
          await actual.#verify()
          return value
        } finally {
          transactions.delete(read)
          actual.#transaction = undefined
          actual.#token = undefined
        }
      })
    } catch (cause) {
      failure = { cause }
      if (cause instanceof Brc38StagingCleanupError) retainedLoader = cause
      {
        await cleanupScope2.close()
        throw cause
      }
    } finally {
      await cleanupScope2.close()
    }
  }
}
