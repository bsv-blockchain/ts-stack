// Layer B of the BRC-162 migration (spec §4.2, §4.2a): who owns each token
// output and each spent token input. Every token output is a canonical 1-sat
// P2PKH token output whose owner is proven by a specific key linkage. Every
// spent token input is owned by its stored owner row, which is an index: when
// it is missing or disagrees with the source script it is repaired from the
// append-only owner journal, and when nothing can repair it the answer is the
// infra reject (ERR_UNAVAILABLE), never a final refusal.
import { PublicKey } from '@bsv/sdk'
import type { LockingScript, Transaction, WalletInterface } from '@bsv/sdk'
import { Bsv21Binary } from '@bsv/templates'
import type { Bsv21Role } from '@bsv/templates'
import type { Brc162Input, Brc162Output, InvalidTokenOutput } from '../brc162/ledger.js'
import type { MandalaStateStore } from './MandalaStorageManager.js'
import { eachInOrder } from './inOrder.js'
import { Reasons } from './reject.js'
import type { MandalaReject } from './reject.js'
import type {
  EngineOutputReader,
  MandalaEnvelope,
  MandalaOwnerRecord,
  SpecificLinkage
} from './types.js'
import { verifyInputKeyLinkage, verifyKeyLinkage } from './verifyKeyLinkage.js'

/** The Mandala amount policy cap, 2^53-1 (spec §3.4). */
export const MAX_SAFE = 9007199254740991n

export interface VerifiedOwner {
  index: number
  tokenId: string
  role: Bsv21Role
  amount: bigint
  /** The linked identity: compressed public key, lowercase hex. */
  identityKey: string
  /** The linkage revealer: compressed public key, lowercase hex. */
  prover: string
}

export interface InputOwnerDeps {
  store: MandalaStateStore
  engine: EngineOutputReader
  verifierWallet: WalletInterface
  topic: string
  /**
   * §4.2a rule 3: told the outpoint of every inline repair after its upsert
   * succeeds; `inserted` is false when an existing row was corrected (no
   * balance credit). Required, so no caller can skip the repair log.
   */
  onRepair: (outpoint: string, inserted: boolean) => void
}

const COMPRESSED_KEY = /^0[23][0-9a-f]{64}$/

// Linkage fields are echoed metadata a submitter can respell (uppercase,
// uncompressed) without changing the derived key, so every identity a linkage
// names is reduced to the one compressed lowercase form the controls compare.
const canonicalKey = (key: string): string => PublicKey.fromString(key).toString()

const sameBytes = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

const isIdentity = (value: unknown): value is string =>
  typeof value === 'string' && COMPRESSED_KEY.test(value)

const sameAmount = (stored: number, amount: bigint): boolean =>
  Number.isSafeInteger(stored) && BigInt(stored) === amount

// ---- token outputs ----

type OutputRule = (output: Brc162Output) => boolean

function rejectFirst(
  outputs: readonly Brc162Output[],
  fails: OutputRule,
  reason: (index: number) => MandalaReject
): void {
  const failing = outputs.find(fails)
  if (failing !== undefined) throw reason(failing.index)
}

// Layer A lists refused token-shaped outputs in index order.
function requireNoInvalidOutputs(invalid: readonly InvalidTokenOutput[]): void {
  const first = invalid[0]
  if (first !== undefined) throw Reasons.invalidTokenOutput(first.index, first.detail)
}

// A deploy names its token by its own outpoint, which only vout 0 can do; a
// deploy anywhere else is a spec-invalid role (BRC-162), so it is a shape error.
const requireDeployAtZero = (outputs: readonly Brc162Output[]): void =>
  rejectFirst(outputs, o => o.role === 'deploy' && o.index !== 0, Reasons.deployNotAtZero)

const requireP2pkhRemainder = (outputs: readonly Brc162Output[]): void =>
  rejectFirst(outputs, o => o.restPubKeyHash === undefined, Reasons.nonP2pkhRemainder)

const requireOneSat = (outputs: readonly Brc162Output[]): void =>
  rejectFirst(outputs, o => o.satoshis !== 1, Reasons.oneSat)

const requireSafeAmounts = (outputs: readonly Brc162Output[]): void =>
  rejectFirst(outputs, o => o.amount > MAX_SAFE, Reasons.amountCap)

/**
 * Shape policy for every token output. Rule-major: each rule runs over all
 * outputs (index order) before the next, so the reason does not depend on
 * which output carries which defect. Order: codec refusals, deploy at vout 0,
 * P2PKH remainder, 1 satoshi, amount cap.
 */
export function requireValidTokenOutputs(
  invalid: readonly InvalidTokenOutput[],
  outputs: readonly Brc162Output[]
): void {
  requireNoInvalidOutputs(invalid)
  requireDeployAtZero(outputs)
  requireP2pkhRemainder(outputs)
  requireOneSat(outputs)
  requireSafeAmounts(outputs)
}

interface LinkedIdentity {
  identityKey: string
  prover: string
}

// undefined: no linkage, a linkage of any malformed shape, a linkage this
// overlay cannot decrypt, or one whose derived key is not the output's key.
async function linkedIdentity(
  linkage: SpecificLinkage | undefined,
  verifierWallet: WalletInterface,
  pubKeyHash: number[] | undefined
): Promise<LinkedIdentity | undefined> {
  if (linkage === undefined || pubKeyHash === undefined) return undefined
  try {
    const verified = await verifyKeyLinkage(linkage, verifierWallet)
    if (!sameBytes(verified.pubKeyHash, pubKeyHash)) return undefined
    return { identityKey: canonicalKey(verified.identityKey), prover: canonicalKey(linkage.prover) }
  } catch {
    return undefined
  }
}

/**
 * The owner of every token output (all roles), in index order: the linkage at
 * its index must derive the remainder's pkh. Anything else is `noLinkage`.
 */
export async function verifyOutputOwners(
  outputs: readonly Brc162Output[],
  env: MandalaEnvelope,
  verifierWallet: WalletInterface
): Promise<VerifiedOwner[]> {
  const owners: VerifiedOwner[] = []
  await eachInOrder(outputs, async output => {
    const linkage = env.outputs.find(entry => entry.index === output.index)?.linkage
    const linked = await linkedIdentity(linkage, verifierWallet, output.restPubKeyHash)
    if (linked === undefined) throw Reasons.noLinkage(output.index)
    const { index, tokenId, role, amount } = output
    owners.push({ index, tokenId, role, amount, ...linked })
  })
  return owners
}

// ---- token inputs ----

interface SourceOutput {
  txid: string
  vout: number
  script: number[]
  role: Bsv21Role
  pubKeyHash?: number[]
}

// Layer A only lists inputs whose source output decodes as a token output.
function sourceOf(tx: Transaction, input: Brc162Input): SourceOutput {
  const spend = tx.inputs[input.index]
  const lockingScript: LockingScript | undefined =
    spend?.sourceTransaction?.outputs[spend.sourceOutputIndex]?.lockingScript
  if (lockingScript === undefined) {
    throw new Error(`input ${input.index}: no source output for a classified token input`)
  }
  const decoded = Bsv21Binary.decode(lockingScript)
  const [txid] = input.outpoint.split('.')
  return {
    txid,
    vout: spend.sourceOutputIndex,
    script: lockingScript.toBinary(),
    role: decoded.role,
    pubKeyHash: decoded.restPubKeyHash
  }
}

// Every read and write of the owner index is an infra dependency: a throw is a
// retryable ERR_UNAVAILABLE, never persisted, with the store's error as cause.
async function fromIndex<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (cause) {
    throw Reasons.storeUnavailable('the owner index', cause)
  }
}

async function toIndex<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (cause) {
    throw Reasons.storeWriteUnavailable('the owner index', cause)
  }
}

/** The store calls that undo a repair: take the row back, and debit what its insert credited. */
export type RepairUndoStore = Pick<
  MandalaStateStore,
  'takeToken' | 'takeAuthority' | 'adjustBalance'
>

/**
 * Takes back a row a repair inserted for a coin the engine has since spent, exactly as the
 * lookup's spend does: a value row debits its owner only when this call is the one that removed
 * it, so the lookup's own spend and this undo debit once between them, in whichever order they
 * run. Shared by the inline repair and the reconciler (spec §4.2a rules 3 and 5).
 */
export async function takeBackRepair(
  store: RepairUndoStore,
  txid: string,
  outputIndex: number,
  role: Bsv21Role
): Promise<void> {
  if (role !== 'value') {
    await store.takeAuthority(txid, outputIndex)
    return
  }
  const row = await store.takeToken(txid, outputIndex)
  if (row !== null) await store.adjustBalance(row.identityKey, -row.amount)
}

interface IndexRow {
  tokenId: string
  identityKey: string
  amount?: number
}

const rowAgrees = (row: IndexRow | null, input: Brc162Input): row is IndexRow =>
  row !== null &&
  row.tokenId === input.tokenId &&
  isIdentity(row.identityKey) &&
  (input.role !== 'value' || (row.amount !== undefined && sameAmount(row.amount, input.amount)))

async function storedOwner(
  input: Brc162Input,
  source: SourceOutput,
  store: MandalaStateStore
): Promise<string | undefined> {
  const row: IndexRow | null = await fromIndex(async () =>
    input.role === 'value'
      ? await store.getTokenRow(source.txid, source.vout)
      : await store.getAuthorityRow(source.txid, source.vout)
  )
  return rowAgrees(row, input) ? row.identityKey : undefined
}

// The journal row is compared with the source script itself: a genesis deploy
// journals as role 'deploy', which is what its script decodes to, while layer
// A reads the spent deploy as an authority input.
const journalAgrees = (
  journal: MandalaOwnerRecord,
  input: Brc162Input,
  source: SourceOutput
): boolean =>
  journal.tokenId === input.tokenId &&
  journal.role === source.role &&
  sameAmount(journal.amount, input.amount) &&
  isIdentity(journal.identityKey)

// The engine's own copy of the source output, read once more after a repair insert.
const stillAdmitted = async (
  source: SourceOutput,
  { engine, topic }: InputOwnerDeps
): Promise<{ lockingScript: number[] } | null> =>
  await fromIndex(async () => await engine.findAdmittedOutput(source.txid, source.vout, topic))

/**
 * §4.2a rule 3: rebuild a missing or wrong row from the journal, provided the
 * engine admitted this exact output on this topic. The repair is an idempotent
 * upsert that credits a balance only on insert, and it is logged with its
 * outpoint.
 *
 * The engine can spend the coin between the read above and the insert (a
 * concurrent double spend in another engine process: it marks the coin spent,
 * and the lookup takes that spend's own repaired row). A row inserted after that
 * would be a phantom no spend ever takes, so an insert is checked against the
 * engine once more and taken back if the coin is gone, and this spend is
 * answered as unrepairable. A correction needs no check: the row it corrected
 * is still there for that spend to take.
 */
async function repairedOwner(
  input: Brc162Input,
  source: SourceOutput,
  deps: InputOwnerDeps
): Promise<string> {
  const { store, engine, topic } = deps
  const journal = await fromIndex(
    async () => await store.getOwnerJournal(source.txid, source.vout, topic)
  )
  const admitted = await fromIndex(
    async () => await engine.findAdmittedOutput(source.txid, source.vout, topic)
  )
  if (
    journal === null ||
    admitted === null ||
    !journalAgrees(journal, input, source) ||
    !sameBytes(admitted.lockingScript, source.script)
  ) {
    throw Reasons.ownerIndexUnavailable(input.outpoint)
  }
  const { inserted } = await toIndex(async () => await store.repairOwnerRow(journal))
  if (inserted && (await stillAdmitted(source, deps)) === null) {
    await toIndex(async () => {
      await takeBackRepair(store, source.txid, source.vout, journal.role)
    })
    throw Reasons.ownerIndexUnavailable(input.outpoint)
  }
  deps.onRepair(input.outpoint, inserted)
  return journal.identityKey
}

// undefined: a malformed linkage, one this overlay cannot decrypt, or one
// whose key (prover + L·G) does not lock the coin.
async function linkedProver(
  linkage: SpecificLinkage,
  verifierWallet: WalletInterface,
  pubKeyHash: number[] | undefined
): Promise<string | undefined> {
  try {
    const verified = await verifyInputKeyLinkage(linkage, verifierWallet)
    if (pubKeyHash === undefined || !sameBytes(verified.pubKeyHash, pubKeyHash)) return undefined
    return canonicalKey(verified.identityKey)
  } catch {
    return undefined
  }
}

// An input linkage is optional; when present it is a proof that must agree
// with the owner, and a failure is a payload defect (final ERR_LINKAGE).
async function requireInputLinkage(
  input: Brc162Input,
  source: SourceOutput,
  owner: string,
  env: MandalaEnvelope,
  verifierWallet: WalletInterface
): Promise<void> {
  const entry = env.inputs.find(e => e.index === input.index)
  if (entry === undefined) return
  const prover = await linkedProver(entry.linkage, verifierWallet, source.pubKeyHash)
  if (prover === undefined) throw Reasons.inputLinkageControl(input.index)
  // Both sides are canonical (a stored owner must be), so this exact compare
  // is the case-insensitive identity compare.
  if (prover !== owner) throw Reasons.inputLinkageOwner(input.index, prover, owner)
}

/**
 * Input index → owner identity for every token input, in input order. The
 * owner is decided (and repaired) before its linkage is judged, so an index
 * fault is always ERR_UNAVAILABLE and never ERR_LINKAGE.
 */
export async function resolveInputOwners(
  inputs: readonly Brc162Input[],
  tx: Transaction,
  env: MandalaEnvelope,
  deps: InputOwnerDeps
): Promise<Map<number, string>> {
  const owners = new Map<number, string>()
  await eachInOrder(inputs, async input => {
    const source = sourceOf(tx, input)
    const owner =
      (await storedOwner(input, source, deps.store)) ?? (await repairedOwner(input, source, deps))
    await requireInputLinkage(input, source, owner, env, deps.verifierWallet)
    owners.set(input.index, owner)
  })
  return owners
}
