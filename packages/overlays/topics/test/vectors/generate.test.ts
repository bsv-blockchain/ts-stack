// Package-local Mandala reject vectors (BRC-162 design spec §8.3), generated from the package
// code. The Go overlay reads mandala-rejects.json, so a changed reason string here is a
// cross-engine change.
//
//   REGENERATE_VECTORS=1 pnpm --filter @bsv/overlay-topics test test/vectors/generate.test.ts
//
// regenerates the file. A plain run is the check mode: it replays every committed case through
// the topic manager and fails when a verdict differs, and it fails when the generator no longer
// builds what is committed. The linkage blobs are frozen snapshots (the SDK's AES-GCM IV is
// random), so the second check ignores `encryptedLinkage` and `encryptedLinkageProof` and the
// first never compares them at all.
//
// File format:
//   verifierPrivateKey  the overlay verifier's scalar: it decrypts every linkage in the file
//   trustedIssuers      the trusted issuer set of every case
//   cases[]
//     topic             tm_mandala (MandalaTopicManager) or tm_mandala_registry (RegistryTopicManager)
//     beef, offChainValues (hex), previousCoins   the identifyAdmissibleOutputs arguments
//     state             what the stores hold before the call: tokens, authorities and owners are
//                       the owner-index rows and the append-only owner journal (createdAt left
//                       out), assetStates the folded admin states; sanctioned is the screening
//                       list, members the membership provider's admitted set (absent: no
//                       provider) and registryTokenId the claimed registry (absent: none)
//     expected          { code, reason } for a refusal, { outputsToAdmit } for an admission
// The engine admitted every outpoint named by previousCoins, so findAdmittedOutput answers for
// exactly those, with the source output's script from the BEEF; it knows no other output. An input
// outside previousCoins is ignored even when the BEEF shows a token-shaped source for it: an
// authority or value coin the engine did not admit grants no authority and counts for no value.
//
// Every key is derived from a fixed scalar, so each is a real compressed secp256k1 point and the
// deploySig signatures are deterministic (RFC 6979). The expected reasons below are literals, not
// the catalog's own output, so the file pins the catalog instead of echoing it.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { jest } from '@jest/globals'
import {
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Transaction,
  UnlockingScript,
  Utils
} from '@bsv/sdk'
import type { ScriptChunk, WalletInterface, WalletProtocol } from '@bsv/sdk'
import type { TopicManager } from '@bsv/overlay'
import { Bsv21Binary, encodeStrictCbor, tokenIdFromString } from '@bsv/templates'
import { defaultAssetState } from '../../src/mandala/AssetStateReducer.js'
import type { AssetAdminState } from '../../src/mandala/AssetStateReducer.js'
import { MANDALA_TOPIC, MandalaTopicManager } from '../../src/mandala/MandalaTopicManager.js'
import type { MandalaStateStore } from '../../src/mandala/MandalaStorageManager.js'
import { deployDigest } from '../../src/mandala/deploySig.js'
import { encodeAdminDetails } from '../../src/mandala/details.js'
import { Reasons, isMandalaReject } from '../../src/mandala/reject.js'
import type { MandalaRejectCode } from '../../src/mandala/reject.js'
import { InMemoryScreeningProvider, encodeEnvelope } from '../../src/mandala/types.js'
import type {
  EngineOutputReader,
  MandalaEnvelope,
  MandalaOwnerRecord,
  MembershipProvider,
  SpecificLinkage
} from '../../src/mandala/types.js'
import type { RegistryStorage } from '../../src/mandala-registry/RegistryStorage.js'
import {
  REGISTRY_TOPIC,
  RegistryTopicManager
} from '../../src/mandala-registry/RegistryTopicManager.js'

const VECTORS_PATH = fileURLToPath(new URL('./mandala-rejects.json', import.meta.url))

const codec = new Bsv21Binary()
const FT: WalletProtocol = [2, 'mandala token']

const hexOf = (bytes: ArrayLike<number>): string => Buffer.from(bytes).toString('hex')
const bytesOf = (hex: string): number[] => Array.from(Buffer.from(hex, 'hex'))
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const utf8 = (text: string): number[] => Utils.toArray(text, 'utf8')

// ---- the cast ----------------------------------------------------------------------------------

interface Party {
  wallet: ProtoWallet
  /** Compressed identity key, lowercase hex. */
  key: string
}

const partyOf = (scalarHex: string): Party => {
  const scalar = PrivateKey.fromString(scalarHex, 'hex')
  return { wallet: new ProtoWallet(scalar), key: scalar.toPublicKey().toString() }
}

/** The overlay's linkage verifier; the Go port needs this scalar to open the linkage blobs. */
const VERIFIER_SCALAR = '0a'.repeat(32)
const overlay = partyOf(VERIFIER_SCALAR)
const issuer = partyOf('66'.repeat(32))
const holder = partyOf('44'.repeat(32))
const receiver = partyOf('22'.repeat(32))
const rogue = partyOf('33'.repeat(32))

// ---- the vector file ---------------------------------------------------------------------------

interface VectorToken {
  txid: string
  outputIndex: number
  tokenId: string
  amount: number
  identityKey: string
}
interface VectorAuthority {
  txid: string
  outputIndex: number
  topic: string
  tokenId: string
  identityKey: string
}
type VectorOwner = Omit<MandalaOwnerRecord, 'createdAt'>

interface VectorState {
  tokens: VectorToken[]
  authorities: VectorAuthority[]
  owners: VectorOwner[]
  assetStates: AssetAdminState[]
  sanctioned?: string[]
  members?: string[]
  registryTokenId?: string
}

type Expected = { code: MandalaRejectCode; reason: string } | { outputsToAdmit: number[] }

interface VectorCase {
  id: string
  topic: string
  beef: string
  offChainValues: string
  previousCoins: number[]
  state: VectorState
  expected: Expected
}

interface Vectors {
  id: 'mandala.rejects'
  version: 1
  verifierPrivateKey: string
  trustedIssuers: string[]
  cases: VectorCase[]
}

const emptyState = (): VectorState => ({
  tokens: [],
  authorities: [],
  owners: [],
  assetStates: []
})

// ---- replay: the stores and the engine the case describes -----------------------------------------

const EPOCH = new Date(0)

interface Located {
  txid: string
  outputIndex: number
}
const at =
  (txid: string, outputIndex: number) =>
  (row: Located): boolean =>
    row.txid === txid && row.outputIndex === outputIndex

const dated = <R extends object>(row: R | undefined): (R & { createdAt: Date }) | null =>
  row === undefined ? null : { ...row, createdAt: EPOCH }

function circulatingSupply(state: VectorState, tokenId: string): bigint {
  const evicted = new Set(
    (state.assetStates.find(s => s.tokenId === tokenId)?.evictedOutpoints ?? []).map(o =>
      o.toLowerCase()
    )
  )
  return state.tokens
    .filter(row => row.tokenId === tokenId && !evicted.has(`${row.txid}.${row.outputIndex}`))
    .reduce((sum, row) => sum + BigInt(row.amount), 0n)
}

/** Updates the row at the outpoint, or adds it; true when it was added. */
function upsert<R extends Located>(rows: R[], row: R): boolean {
  const existing = rows.find(at(row.txid, row.outputIndex))
  if (existing !== undefined) {
    Object.assign(existing, row)
    return false
  }
  rows.push(row)
  return true
}

/** Removes and returns the row at the outpoint. */
function takeRow<R extends Located>(rows: R[], txid: string, outputIndex: number): R | undefined {
  const index = rows.findIndex(at(txid, outputIndex))
  return index === -1 ? undefined : rows.splice(index, 1)[0]
}

/** §4.2a repair: upsert the index row of a journalled output; true when it was inserted. */
function repairRow(state: VectorState, journal: MandalaOwnerRecord): boolean {
  const { txid, outputIndex, tokenId, identityKey } = journal
  if (journal.role === 'value') {
    return upsert(state.tokens, { txid, outputIndex, tokenId, amount: journal.amount, identityKey })
  }
  return upsert(state.authorities, {
    txid,
    outputIndex,
    topic: journal.topic,
    tokenId,
    identityKey
  })
}

/** The first write of an owner journal row wins, as in the Mongo store. */
function recordOwner(state: VectorState, row: MandalaOwnerRecord): void {
  const { createdAt: _createdAt, ...owner } = row
  const exists = state.owners.some(o => at(row.txid, row.outputIndex)(o) && o.topic === row.topic)
  if (!exists) state.owners.push(owner)
}

function storeOver(state: VectorState): MandalaStateStore {
  return {
    getAssetState: async tokenId =>
      state.assetStates.find(s => s.tokenId === tokenId) ?? defaultAssetState(tokenId),
    getTokenRow: async (txid, outputIndex) => dated(state.tokens.find(at(txid, outputIndex))),
    getAuthorityRow: async (txid, outputIndex) =>
      dated(state.authorities.find(at(txid, outputIndex))),
    getOwnerJournal: async (txid, outputIndex, topic) =>
      dated(state.owners.find(o => at(txid, outputIndex)(o) && o.topic === topic)),
    recordOwners: async rows => {
      for (const row of rows) recordOwner(state, row)
    },
    repairOwnerRow: async journal => ({ inserted: repairRow(state, journal) }),
    // The undo of a repair that raced a spend. The engine below never spends a coin between two
    // reads, so no case reaches these; balances are not part of the vector state.
    takeToken: async (txid, outputIndex) => dated(takeRow(state.tokens, txid, outputIndex)),
    takeAuthority: async (txid, outputIndex) =>
      dated(takeRow(state.authorities, txid, outputIndex)),
    adjustBalance: async () => {},
    circulatingSupply: async tokenId => circulatingSupply(state, tokenId)
  }
}

function engineFor(topic: string, beef: number[], previousCoins: number[]): EngineOutputReader {
  const tx = Transaction.fromBEEF(beef)
  const coins = new Map<string, number[]>()
  for (const index of previousCoins) {
    const { sourceTransaction, sourceOutputIndex } = tx.inputs[index]
    const script = sourceTransaction?.outputs[sourceOutputIndex]?.lockingScript
    if (sourceTransaction !== undefined && script !== undefined) {
      coins.set(`${sourceTransaction.id('hex')}.${sourceOutputIndex}`, script.toBinary())
    }
  }
  return {
    findAdmittedOutput: async (txid, outputIndex, forTopic) => {
      const lockingScript = forTopic === topic ? coins.get(`${txid}.${outputIndex}`) : undefined
      return lockingScript === undefined ? null : { lockingScript, satoshis: 1 }
    },
    listUnspentAdmittedOutputs: async () => []
  }
}

const membershipOver = (members: readonly string[] | undefined): MembershipProvider | undefined =>
  members === undefined
    ? undefined
    : { isActive: async () => true, isAdmitted: async key => members.includes(key) }

interface Fixture {
  verifierPrivateKey: string
  trustedIssuers: readonly string[]
}

function managerFor(
  c: Pick<VectorCase, 'topic' | 'beef' | 'previousCoins'>,
  state: VectorState,
  fixture: Fixture,
  repairs: string[]
): TopicManager {
  const shared = {
    verifierWallet: new ProtoWallet(
      PrivateKey.fromString(fixture.verifierPrivateKey, 'hex')
    ) as unknown as WalletInterface,
    trustedIssuers: fixture.trustedIssuers,
    stateStore: storeOver(state),
    engineOutputs: engineFor(c.topic, bytesOf(c.beef), c.previousCoins),
    onOwnerRepair: (outpoint: string) => {
      repairs.push(outpoint)
    }
  }
  if (c.topic === REGISTRY_TOPIC) {
    const registry = { registryTokenId: async () => state.registryTokenId ?? null }
    return new RegistryTopicManager({ ...shared, registry: registry as unknown as RegistryStorage })
  }
  if (c.topic !== MANDALA_TOPIC) throw new Error(`unknown topic ${c.topic}`)
  return new MandalaTopicManager({
    ...shared,
    screeningProvider: new InMemoryScreeningProvider(state.sanctioned ?? []),
    membership: membershipOver(state.members)
  })
}

type Outcome =
  { code: string; reason: string } | { outputsToAdmit: number[]; coinsToRetain: number[] }

/** Runs one case on `state` (which the call may journal into) and reports the verdict. */
async function execute(
  c: Pick<VectorCase, 'topic' | 'beef' | 'offChainValues' | 'previousCoins'>,
  state: VectorState,
  fixture: Fixture,
  repairs: string[] = []
): Promise<Outcome> {
  const manager = managerFor(c, state, fixture, repairs)
  try {
    const { outputsToAdmit, coinsToRetain } = await manager.identifyAdmissibleOutputs(
      bytesOf(c.beef),
      c.previousCoins,
      bytesOf(c.offChainValues),
      'current-tx'
    )
    return { outputsToAdmit, coinsToRetain }
  } catch (error) {
    if (isMandalaReject(error)) return { code: error.code, reason: error.reason }
    throw error
  }
}

/** An admission also retains every previous coin. */
const outcomeOf = (c: VectorCase): Outcome =>
  'code' in c.expected ? c.expected : { ...c.expected, coinsToRetain: c.previousCoins }

// ---- transactions ------------------------------------------------------------------------------

interface TokenOut {
  /** null: a deploy. */
  tokenId: string | null
  amount: bigint
  /** Reveals the linkage; the output is locked to the key `from` derives for `to`. */
  from: Party
  to: string
  payload?: number[]
  /** Replaces the script built from the derived key's hash. */
  lock?: (pubKeyHash: number[]) => LockingScript
  /** The linkage verifier; the overlay unless a case needs a linkage it cannot open. */
  verifier?: string
}

interface OutInfo {
  tokenId: string
  sender: Party
  keyID: string
}

interface Built {
  tx: Transaction
  txid: string
  previousCoins: number[]
  env: MandalaEnvelope
  outs: OutInfo[]
}

interface Spend {
  b: Built
  vout: number
}

let nonce = 0
let keyCounter = 0

// Roots every chain in a funding tx with no inputs, so BEEF needs no proofs.
function funding(): Transaction {
  const source = new Transaction()
  source.lockTime = ++nonce
  source.addOutput({ satoshis: 1000, lockingScript: new P2PKH().lock(Hash.hash160([nonce])) })
  return source
}

/** Token spends first (they are the previous coins), then one funding input. */
function txSpending(spends: readonly Spend[]): Transaction {
  const tx = new Transaction()
  for (const { b, vout } of spends) {
    tx.addInput({
      sourceTransaction: b.tx,
      sourceOutputIndex: vout,
      unlockingScript: new UnlockingScript()
    })
  }
  tx.addInput({
    sourceTransaction: funding(),
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  return tx
}

async function lockOutput(
  out: TokenOut
): Promise<{ script: LockingScript; linkage: SpecificLinkage; keyID: string }> {
  const keyID = `out-${++keyCounter}`
  const { publicKey } = await out.from.wallet.getPublicKey({
    protocolID: FT,
    keyID,
    counterparty: out.to
  })
  const linkage = (await out.from.wallet.revealSpecificKeyLinkage({
    counterparty: out.to,
    verifier: out.verifier ?? overlay.key,
    protocolID: FT,
    keyID
  })) as SpecificLinkage
  const pkh = Hash.hash160(Utils.toArray(publicKey, 'hex'))
  const script = out.lock?.(pkh) ?? codec.lock(out.tokenId, out.amount, pkh, out.payload)
  return { script, linkage, keyID }
}

interface BuildExtras {
  admin?: MandalaEnvelope['admin']
  inputs?: MandalaEnvelope['inputs']
}

async function build(
  spends: readonly Spend[],
  outs: readonly TokenOut[],
  { admin = [], inputs = [] }: BuildExtras = {}
): Promise<Built> {
  const tx = txSpending(spends)
  const outputs: MandalaEnvelope['outputs'] = []
  const keyIDs: string[] = []
  for (const [index, out] of outs.entries()) {
    const { script, linkage, keyID } = await lockOutput(out)
    tx.addOutput({ lockingScript: script, satoshis: 1 })
    outputs.push({ index, linkage })
    keyIDs.push(keyID)
  }
  const txid = tx.id('hex')
  return {
    tx,
    txid,
    previousCoins: spends.map((_, i) => i),
    env: { inputs, outputs, admin },
    outs: outs.map((out, i) => ({
      tokenId: out.tokenId ?? `${txid}_0`,
      sender: out.from,
      keyID: keyIDs[i]
    }))
  }
}

/** A tx with these raw outputs and no linkage. */
function rawTx(outputs: ReadonlyArray<{ script: LockingScript; satoshis?: number }>): Built {
  const tx = txSpending([])
  for (const { script, satoshis } of outputs) {
    tx.addOutput({ lockingScript: script, satoshis: satoshis ?? 1 })
  }
  return {
    tx,
    txid: tx.id('hex'),
    previousCoins: [],
    env: { inputs: [], outputs: [], admin: [] },
    outs: []
  }
}

/** The spender's linkage for a coin: it proves control of the key the sender derived for it. */
async function spendLinkage(
  { b, vout }: Spend,
  owner: Party,
  keyID?: string
): Promise<SpecificLinkage> {
  const info = b.outs[vout]
  return (await owner.wallet.revealSpecificKeyLinkage({
    counterparty: info.sender.key,
    verifier: overlay.key,
    protocolID: FT,
    keyID: keyID ?? info.keyID
  })) as SpecificLinkage
}

async function signDeploy(signer: Party, txid: string): Promise<string> {
  const { signature } = await signer.wallet.createSignature({
    data: deployDigest(txid),
    protocolID: [2, 'mandala deploy'],
    keyID: '1',
    counterparty: 'anyone'
  })
  return Utils.toHex(signature)
}

const DEPLOY_PAYLOAD = encodeStrictCbor({ sym: 'USD', dec: 2, label: 'US Dollar' })
const REGISTRY_PAYLOAD = encodeStrictCbor({ sym: 'KYC', dec: 0, label: 'Mandala registry' })

interface DeployOptions {
  payload?: number[]
  amount?: bigint
  lock?: TokenOut['lock']
  /** Reveals the linkage; the deployer unless a case needs another prover. */
  prover?: Party
}

/** A signed deploy, locked to the deployer's own derived key (spec §5.1a). */
async function deploy(by: Party, options: DeployOptions = {}): Promise<Built> {
  const { amount = 0n, lock, prover = by } = options
  const payload = 'payload' in options ? options.payload : DEPLOY_PAYLOAD
  const b = await build([], [{ tokenId: null, amount, from: prover, to: by.key, payload, lock }])
  return { ...b, env: { ...b.env, deploySig: await signDeploy(by, b.txid) } }
}

const tokenOf = (b: Built): string => `${b.txid}_0`

const commitTo = (details: readonly number[]): number[] =>
  encodeStrictCbor({ adm: Uint8Array.from(Hash.sha256([...details])) })

const valueOut = (
  tokenId: string,
  to: Party | string,
  amount: bigint,
  from = issuer
): TokenOut => ({
  tokenId,
  amount,
  from,
  to: typeof to === 'string' ? to : to.key
})

const authorityOut = (tokenId: string, payload?: number[], to = issuer): TokenOut => ({
  tokenId,
  amount: 0n,
  from: issuer,
  to: to.key,
  payload
})

/** Spends `authority`: `values` first, then one authority output committing `details`. */
async function act(
  authority: Spend,
  tokenId: string,
  details: readonly number[],
  values: ReadonlyArray<[Party | string, bigint]> = []
): Promise<Built> {
  return await build(
    [authority],
    [
      ...values.map(([to, amount]) => valueOut(tokenId, to, amount)),
      authorityOut(tokenId, commitTo(details))
    ],
    { admin: [{ index: values.length, details: hexOf(details) }] }
  )
}

// ---- the world the cases start from -------------------------------------------------------------

interface World {
  /** The signed deploy of token `token`. */
  deploy: Built
  /** Issues 100 to the holder: output 0 is the value coin, output 1 the committed authority. */
  issue: Built
  token: string
  /** The holder's 100 coin and the issuer's authority, both created by `issue`. */
  coin: Spend
  authority: Spend
  /** The holder's 100 split 60 to the receiver and 40 back. */
  split: Built
  afterDeploy: () => VectorState
  afterIssue: () => VectorState
  registry: { deploy: Built; token: string; state: () => VectorState }
}

/** The engine and the lookup after admission: index each owner, drop each spent coin. */
function settle(state: VectorState, topic: string, b: Built, outputsToAdmit: number[]): void {
  for (const index of outputsToAdmit) {
    const owner = state.owners.find(o => at(b.txid, index)(o) && o.topic === topic)
    if (owner !== undefined) repairRow(state, { ...owner, createdAt: EPOCH })
  }
  for (const index of b.previousCoins) {
    const { sourceTransaction, sourceOutputIndex } = b.tx.inputs[index]
    const spent = at(sourceTransaction?.id('hex') ?? '', sourceOutputIndex)
    state.tokens = state.tokens.filter(row => !spent(row))
    state.authorities = state.authorities.filter(row => !spent(row))
  }
}

const SETUP: Fixture = { verifierPrivateKey: VERIFIER_SCALAR, trustedIssuers: [issuer.key] }

/** Admits `b` through the real manager, so the state it leaves is what admission produces. */
async function admitInto(state: VectorState, topic: string, b: Built): Promise<void> {
  const c = { ...caseBytes(b), topic }
  const outcome = await execute(c, state, SETUP)
  if (!('outputsToAdmit' in outcome)) {
    throw new Error(`setup transaction ${b.txid} was refused: ${outcome.code} ${outcome.reason}`)
  }
  settle(state, topic, b, outcome.outputsToAdmit)
}

const caseBytes = (b: Built, offChain: readonly number[] = encodeEnvelope(b.env)) => ({
  beef: hexOf(b.tx.toBEEF()),
  offChainValues: hexOf(offChain),
  previousCoins: b.previousCoins
})

async function buildWorld(): Promise<World> {
  const d = await deploy(issuer)
  const token = tokenOf(d)
  const afterDeploy = emptyState()
  await admitInto(afterDeploy, MANDALA_TOPIC, d)
  const issued = await act({ b: d, vout: 0 }, token, encodeAdminDetails({ kind: 'issue' }), [
    [holder, 100n]
  ])
  const afterIssue = clone(afterDeploy)
  await admitInto(afterIssue, MANDALA_TOPIC, issued)
  const coin = { b: issued, vout: 0 }
  const split = await build(
    [coin],
    [valueOut(token, receiver, 60n, holder), valueOut(token, holder, 40n, holder)]
  )
  const registryDeploy = await deploy(issuer, { payload: REGISTRY_PAYLOAD })
  const registryState = emptyState()
  await admitInto(registryState, REGISTRY_TOPIC, registryDeploy)
  registryState.registryTokenId = tokenOf(registryDeploy)
  return {
    deploy: d,
    issue: issued,
    token,
    coin,
    authority: { b: issued, vout: 1 },
    split,
    afterDeploy: () => clone(afterDeploy),
    afterIssue: () => clone(afterIssue),
    registry: {
      deploy: registryDeploy,
      token: tokenOf(registryDeploy),
      state: () => clone(registryState)
    }
  }
}

// ---- cases -------------------------------------------------------------------------------------

const refused = (code: MandalaRejectCode, reason: string): Expected => ({ code, reason })
const admits = (...outputsToAdmit: number[]): Expected => ({ outputsToAdmit })

interface CaseOptions {
  topic?: string
  /** Raw off-chain bytes in place of the envelope. */
  offChain?: readonly number[]
}

function record(
  id: string,
  b: Built,
  state: VectorState,
  expected: Expected,
  { topic = MANDALA_TOPIC, offChain }: CaseOptions = {}
): VectorCase {
  return { id, topic, ...caseBytes(b, offChain), state, expected }
}

type Group = (w: World) => Promise<VectorCase[]>

// ---- layer A and B: the shape of every token output

const OTHER_TOKEN = `${'ab'.repeat(32)}_0`
const OTHER_ID = tokenIdFromString(OTHER_TOKEN)
const SOME_PKH = Hash.hash160([1, 2, 3])
const idPush: ScriptChunk = { op: 32, data: OTHER_ID }

const tokenScript = (
  id: ScriptChunk,
  amount: ScriptChunk,
  rest: ScriptChunk[] = new P2PKH().lock(SOME_PKH).chunks
): LockingScript => new LockingScript([id, amount, { op: OP.OP_2DROP }, ...rest])

const AMOUNT_PUSH = 'amount must be OP_0, OP_1..OP_16 or a direct push of 1-9 bytes'
const ID_PUSH = 'token id must be a direct 32-byte push'

// A token-shaped script the codec refuses, sitting at output 1 behind a good deploy.
const codecRefusals: Array<[string, LockingScript, string]> = [
  [
    'amount-small-as-data',
    tokenScript(idPush, { op: 1, data: [5] }),
    'amounts 0..16 must use OP_0/OP_1..OP_16'
  ],
  [
    'amount-zero-as-data',
    tokenScript(idPush, { op: 1, data: [0] }),
    'amount is not minimally encoded'
  ],
  ['amount-negative', tokenScript(idPush, { op: 1, data: [0x85] }), 'amount must not be negative'],
  [
    'amount-padded-with-zero',
    tokenScript(idPush, { op: 2, data: [0x11, 0x00] }),
    'amount is not minimally encoded'
  ],
  [
    'amount-above-u64',
    tokenScript(idPush, { op: 9, data: [0, 0, 0, 0, 0, 0, 0, 0, 1] }),
    'amount exceeds 2^64-1'
  ],
  [
    'amount-ten-bytes',
    tokenScript(idPush, { op: 10, data: Array<number>(10).fill(1) }),
    AMOUNT_PUSH
  ],
  ['amount-pushdata1', tokenScript(idPush, { op: OP.OP_PUSHDATA1, data: [0x20] }), AMOUNT_PUSH],
  [
    'token-id-pushdata1',
    tokenScript({ op: OP.OP_PUSHDATA1, data: OTHER_ID }, { op: OP.OP_5 }),
    ID_PUSH
  ],
  [
    'token-id-36-bytes',
    tokenScript({ op: 36, data: [...OTHER_ID, 1, 2, 3, 4] }, { op: OP.OP_5 }),
    ID_PUSH
  ],
  ['token-id-31-bytes', tokenScript({ op: 31, data: OTHER_ID.slice(1) }, { op: OP.OP_5 }), ID_PUSH],
  [
    'token-shaped-garbage',
    new LockingScript([
      { op: 2, data: [0xde, 0xad] },
      { op: 2, data: [0xbe, 0xef] },
      { op: OP.OP_2DROP },
      { op: OP.OP_RETURN }
    ]),
    ID_PUSH
  ],
  [
    'truncated-push-after-prefix',
    LockingScript.fromHex(`20${hexOf(OTHER_ID)}556d4c05aa`),
    'truncated push'
  ]
]

const goodDeploy = (): LockingScript => codec.lock(null, 0n, SOME_PKH)
const goodValue = (): LockingScript => codec.lock(OTHER_TOKEN, 5n, SOME_PKH)

const shapeCases: Group = async () => {
  const cases = codecRefusals.map(([id, bad, detail]) =>
    record(
      id,
      rawTx([{ script: goodDeploy() }, { script: bad }]),
      emptyState(),
      refused(
        'ERR_SHAPE',
        `output 1: token-shaped output is not a valid BRC-162 token output (${detail})`
      )
    )
  )
  const bad = codecRefusals[0][1]
  const cap = codec.lock(OTHER_TOKEN, 2n ** 53n, SOME_PKH)
  const remainder = tokenScript(idPush, { op: OP.OP_5 }, [{ op: OP.OP_1 }])
  cases.push(
    record(
      'deploy-not-at-zero',
      rawTx([{ script: goodValue() }, { script: goodDeploy() }]),
      emptyState(),
      refused('ERR_SHAPE', 'output 1: a deploy must be output 0')
    ),
    record(
      'remainder-not-p2pkh',
      rawTx([{ script: remainder }]),
      emptyState(),
      refused('ERR_SHAPE', 'output 0: token output remainder must be a P2PKH lock')
    ),
    record(
      'two-satoshi-output',
      rawTx([{ script: goodValue(), satoshis: 2 }]),
      emptyState(),
      refused('ERR_SATOSHIS', 'output 0: token output must carry exactly 1 satoshi')
    ),
    record(
      'amount-above-2^53-1',
      rawTx([{ script: cap }]),
      emptyState(),
      refused('ERR_SHAPE', 'output 0: token amount exceeds 2^53-1')
    ),
    // first refusal wins, rule by rule: codec, deploy at zero, P2PKH, 1 satoshi, amount cap
    record(
      'precedence-codec-before-satoshis',
      rawTx([{ script: goodValue(), satoshis: 2 }, { script: bad }]),
      emptyState(),
      refused(
        'ERR_SHAPE',
        'output 1: token-shaped output is not a valid BRC-162 token output (amounts 0..16 must use OP_0/OP_1..OP_16)'
      )
    ),
    record(
      'precedence-satoshis-before-amount-cap',
      rawTx([{ script: cap }, { script: goodValue(), satoshis: 2 }]),
      emptyState(),
      refused('ERR_SATOSHIS', 'output 1: token output must carry exactly 1 satoshi')
    )
  )
  return cases
}

// ---- the off-chain envelope

const envelopeRefusals: Array<[string, readonly number[], string]> = [
  ['envelope-not-utf8', [0xff], 'must be UTF-8 JSON'],
  ['envelope-not-json', utf8('not json'), 'must be UTF-8 JSON'],
  ['envelope-not-an-object', utf8('[]'), 'must be an object'],
  ['envelope-list-not-an-array', utf8('{"outputs":{}}'), 'outputs must be an array'],
  [
    'envelope-duplicate-index',
    utf8('{"outputs":[{"index":0},{"index":0}]}'),
    'outputs must contain unique non-negative integer indices'
  ],
  [
    'envelope-negative-index',
    utf8('{"inputs":[{"index":-1}]}'),
    'inputs must contain unique non-negative integer indices'
  ],
  [
    'envelope-details-not-lowercase-hex',
    utf8('{"admin":[{"index":1,"details":"AB"}]}'),
    'admin details must be lowercase hex'
  ],
  ['envelope-deploysig-not-hex', utf8('{"deploySig":"zz"}'), 'deploySig must be lowercase hex']
]

const envelopeCases: Group = async w =>
  envelopeRefusals.map(([id, offChain, detail]) =>
    record(id, w.deploy, emptyState(), refused('ERR_SHAPE', `Mandala payload ${detail}`), {
      offChain
    })
  )

// ---- who owns each output, and each coin spent

const NO_LINKAGE = 'output 0: token output with no verified linkage'

const linkageCases: Group = async () => {
  const cases: VectorCase[] = []
  // each case reveals a linkage that cannot own the deploy's output 0
  const refuseWith = async (id: string, linkage: SpecificLinkage | undefined): Promise<void> => {
    const b = await deploy(issuer)
    const outputs = linkage === undefined ? [] : [{ index: 0, linkage }]
    cases.push(
      record(id, b, emptyState(), refused('ERR_LINKAGE', NO_LINKAGE), {
        offChain: encodeEnvelope({ ...b.env, outputs })
      })
    )
  }
  const reveal = async (verifier?: string): Promise<SpecificLinkage> =>
    (await lockOutput({ tokenId: null, amount: 0n, from: issuer, to: issuer.key, verifier }))
      .linkage
  await refuseWith('linkage-missing', undefined)
  await refuseWith('linkage-for-another-key', await reveal())
  await refuseWith('linkage-sealed-for-another-verifier', await reveal(rogue.key))
  await refuseWith('linkage-malformed', {} as SpecificLinkage)
  return cases
}

const outpointOf = (s: Spend): string => `${s.b.txid}.${s.vout}`

const inputCases: Group = async w => {
  const cases: VectorCase[] = []
  const pay = async (linkage: SpecificLinkage): Promise<Built> =>
    await build([w.coin], [valueOut(w.token, receiver, 100n, holder)], {
      inputs: [{ index: 0, linkage }]
    })
  const wrongKey = await pay(await spendLinkage(w.coin, holder, 'not-the-key-id'))
  cases.push(
    record(
      'input-linkage-does-not-control-the-coin',
      wrongKey,
      w.afterIssue(),
      refused('ERR_LINKAGE', 'input 0: linkage does not control the coin being spent')
    )
  )
  const named = await pay(await spendLinkage(w.coin, holder))
  const strangerOwns = w.afterIssue()
  strangerOwns.tokens[0].identityKey = rogue.key
  cases.push(
    record(
      'input-linkage-names-another-owner',
      named,
      strangerOwns,
      refused(
        'ERR_LINKAGE',
        `input 0: linkage names ${holder.key} but the coin is owned by ${rogue.key}`
      )
    )
  )
  const unreadable = await pay({} as SpecificLinkage)
  cases.push(
    record(
      'input-linkage-malformed',
      unreadable,
      w.afterIssue(),
      refused('ERR_LINKAGE', 'input 0: linkage does not control the coin being spent')
    )
  )
  // §4.2a: a spend whose owner row is missing is repaired from the journal; with nothing to repair
  // it from, the answer is the infra reject and never a final refusal
  const unavailable = refused(
    'ERR_UNAVAILABLE',
    `owner index unavailable for ${outpointOf(w.coin)}`
  )
  const noRowNoJournal = w.afterIssue()
  noRowNoJournal.tokens = []
  noRowNoJournal.owners = noRowNoJournal.owners.filter(o => !at(w.coin.b.txid, 0)(o))
  cases.push(record('owner-index-row-and-journal-missing', w.split, noRowNoJournal, unavailable))
  const journalDisagrees = w.afterIssue()
  journalDisagrees.tokens = []
  const journal = journalDisagrees.owners.find(o => at(w.coin.b.txid, 0)(o))
  if (journal !== undefined) journal.amount = 99
  cases.push(
    record('owner-index-journal-disagrees-with-the-script', w.split, journalDisagrees, unavailable)
  )
  return cases
}

// ---- deploys (layer C)

const DEPLOY_SIG = 'output 0: deploy requires a valid deploySig over this txid'
const untrusted = (key: string): string => `output 0: owner ${key} is not a trusted issuer`

const deployCases: Group = async w => {
  const cases: VectorCase[] = []
  const unsigned = await deploy(issuer)
  const { deploySig: _dropped, ...withoutSig } = unsigned.env
  cases.push(
    record(
      'deploy-without-deploysig',
      unsigned,
      emptyState(),
      refused('ERR_AUTHORITY', DEPLOY_SIG),
      {
        offChain: encodeEnvelope(withoutSig)
      }
    )
  )
  const other = await deploy(issuer)
  cases.push(
    record(
      'deploysig-over-another-txid',
      other,
      emptyState(),
      refused('ERR_AUTHORITY', DEPLOY_SIG),
      {
        offChain: encodeEnvelope({
          ...other.env,
          deploySig: await signDeploy(issuer, w.deploy.txid)
        })
      }
    )
  )
  // a deploy rebuilt from the issuer's published one: same lock and linkage, new txid
  const replay = txSpending([])
  replay.addOutput({ lockingScript: w.deploy.tx.outputs[0].lockingScript, satoshis: 1 })
  cases.push(
    record(
      'deploy-replayed-with-the-original-signature',
      { ...w.deploy, tx: replay, txid: replay.id('hex') },
      w.afterDeploy(),
      refused('ERR_AUTHORITY', DEPLOY_SIG)
    )
  )
  cases.push(
    record(
      'deploy-fixed-supply',
      await deploy(issuer, { amount: 5n }),
      emptyState(),
      refused('ERR_AUTHORITY', 'output 0: fixed-supply deploys are not allowed')
    ),
    record(
      'deploy-by-untrusted-owner',
      await deploy(rogue),
      emptyState(),
      refused('ERR_UNTRUSTED', untrusted(rogue.key))
    ),
    record(
      'deploy-with-untrusted-linkage-prover',
      await deploy(issuer, { prover: rogue }),
      emptyState(),
      refused('ERR_UNTRUSTED', `output 0: linkage prover ${rogue.key} is not a trusted issuer`)
    ),
    record(
      'authority-handed-to-untrusted-owner',
      await build([w.authority], [authorityOut(w.token, undefined, rogue)]),
      w.afterIssue(),
      refused('ERR_UNTRUSTED', untrusted(rogue.key))
    )
  )
  return cases
}

// ---- deploy payloads (§3.2, §3.5)

const text = (value: string): number[] => [0x60 + value.length, ...utf8(value)]
const payloadError = (detail: string): string =>
  `output 0: deploy payload is not a valid Mandala deploy map (${detail})`
// the payload is pushed with a non-minimal push opcode
const pushedAsData = (payload: number[]) => (pkh: number[]) =>
  new LockingScript([
    { op: OP.OP_0 },
    { op: OP.OP_0 },
    { op: OP.OP_2DROP },
    { op: payload.length, data: payload },
    { op: OP.OP_DROP },
    ...new P2PKH().lock(pkh).chunks
  ])

const payloads: Array<[string, DeployOptions, string]> = [
  ['deploy-payload-missing', { payload: undefined }, 'missing payload'],
  ['deploy-payload-non-canonical-push', { lock: pushedAsData([5]) }, 'non-canonical payload push'],
  [
    'deploy-payload-float',
    { payload: [0xa2, ...text('dec'), 0xf9, 0x3c, 0x00, ...text('sym'), ...text('USD')] },
    'simple value or float not allowed'
  ],
  [
    'deploy-payload-tag',
    { payload: [0xa2, ...text('dec'), 0x02, ...text('sym'), 0xd8, 0x2a, ...text('USD')] },
    'major type 6 not allowed'
  ],
  [
    'deploy-payload-unsorted-keys',
    { payload: [0xa2, ...text('sym'), ...text('USD'), ...text('dec'), 0x02] },
    'map keys unsorted or duplicated'
  ],
  ['deploy-payload-trailing-byte', { payload: [...DEPLOY_PAYLOAD, 0x00] }, 'trailing bytes'],
  [
    'deploy-payload-missing-sym',
    { payload: encodeStrictCbor({ dec: 2, label: 'US Dollar' }) },
    'missing key sym'
  ],
  [
    'deploy-payload-empty-sym',
    { payload: encodeStrictCbor({ sym: '', dec: 2, label: 'US Dollar' }) },
    'sym must be text of 1-32 characters'
  ],
  [
    'deploy-payload-dec-above-18',
    { payload: encodeStrictCbor({ sym: 'USD', dec: 19, label: 'US Dollar' }) },
    'dec must be an integer 0-18'
  ],
  [
    'deploy-payload-missing-label',
    { payload: encodeStrictCbor({ sym: 'USD', dec: 2 }) },
    'missing key label'
  ],
  [
    'deploy-payload-fee-rate-zero',
    { payload: encodeStrictCbor({ sym: 'USD', dec: 2, label: 'US Dollar', feeRatePerKb: 0 }) },
    'feeRatePerKb must be a safe integer >= 1 or null'
  ]
]

const payloadCases: Group = async () => {
  const cases: VectorCase[] = []
  for (const [id, options, detail] of payloads) {
    cases.push(
      record(
        id,
        await deploy(issuer, options),
        emptyState(),
        refused('ERR_SHAPE', payloadError(detail))
      )
    )
  }
  return cases
}

// ---- authority outputs and their committed actions (layer C)

const authorityCases: Group = async w => {
  const { token: t, authority } = w
  const issue = encodeAdminDetails({ kind: 'issue' })
  const other = encodeAdminDetails({ kind: 'issue', bankRef: Array<number>(32).fill(7) })
  const cases: VectorCase[] = []
  const add = (id: string, b: Built, expected: Expected): void => {
    cases.push(record(id, b, w.afterIssue(), expected))
  }
  add(
    'authority-output-without-authority-input',
    await build([], [authorityOut(t)]),
    refused(
      'ERR_AUTHORITY',
      `output 0: authority output without an admitted authority input of token ${t}`
    )
  )
  add(
    'authority-spent-and-not-recreated',
    await build([authority], [valueOut(t, holder, 5n)]),
    refused('ERR_AUTHORITY', `token ${t}: spends an authority but creates none`)
  )
  add(
    'two-committed-authority-outputs',
    await build([authority], [authorityOut(t, commitTo(issue)), authorityOut(t, commitTo(other))], {
      admin: [
        { index: 0, details: hexOf(issue) },
        { index: 1, details: hexOf(other) }
      ]
    }),
    refused(
      'ERR_AUTHORITY',
      `token ${t}: more than one authority output carries an action commitment`
    )
  )
  add(
    'committed-authority-without-details',
    await build([authority], [valueOut(t, holder, 50n), authorityOut(t, commitTo(issue))]),
    refused('ERR_SHAPE', 'output 1: committed authority output has no admin details')
  )
  add(
    'details-for-an-uncommitted-output',
    await build([authority], [authorityOut(t)], { admin: [{ index: 0, details: hexOf(issue) }] }),
    refused('ERR_SHAPE', 'admin entry 0 does not name a committed authority output')
  )
  add(
    'details-do-not-match-the-commitment',
    await build([authority], [valueOut(t, holder, 50n), authorityOut(t, commitTo(issue))], {
      admin: [{ index: 1, details: hexOf(other) }]
    }),
    refused('ERR_AUTHORITY', 'output 1: admin details do not match the payload commitment')
  )
  return cases
}

// ---- admin details (§3.3, §3.5): a committed output whose details are not a valid action

const KEY_BYTES = Utils.toArray(holder.key, 'hex')

const schemaRefusals: Array<[string, number[], string]> = [
  [
    'details-tag',
    [0xa1, ...text('kind'), 0xd8, 0x2a, ...text('issue')],
    'major type 6 not allowed'
  ],
  [
    'details-float',
    [0xa2, ...text('kind'), ...text('setFeeRate'), ...text('feeRatePerKb'), 0xf9, 0x3c, 0x00],
    'simple value or float not allowed'
  ],
  [
    'details-unsorted-keys',
    [
      0xa2,
      ...text('identityKey'),
      0x58,
      0x21,
      ...KEY_BYTES,
      ...text('kind'),
      ...text('blockIdentity')
    ],
    'map keys unsorted or duplicated'
  ],
  [
    'details-non-minimal-header',
    [0xa1, ...text('kind'), 0x78, 0x05, ...utf8('pause')],
    'non-minimal header'
  ],
  ['details-trailing-byte', [...encodeAdminDetails({ kind: 'pause' }), 0x00], 'trailing bytes'],
  ['details-missing-kind', encodeStrictCbor({ reason: 'x' }), 'missing key kind'],
  ['details-unknown-kind', encodeStrictCbor({ kind: 'mint' }), 'kind mint is not allowed'],
  [
    'details-registry-kind-on-the-mandala-topic',
    encodeAdminDetails({ kind: 'admitIdentity', identityKey: holder.key }),
    'kind admitIdentity is not allowed'
  ],
  ['details-unknown-key', encodeStrictCbor({ kind: 'pause', extra: 1 }), 'unknown key extra'],
  ['details-missing-key', encodeStrictCbor({ kind: 'blockIdentity' }), 'missing key identityKey'],
  [
    'details-key-of-32-bytes',
    encodeStrictCbor({ kind: 'blockIdentity', identityKey: new Uint8Array(32) }),
    'identityKey must be a 33-byte compressed public key'
  ]
]

const detailsCases: Group = async w => {
  const cases: VectorCase[] = []
  for (const [id, details, detail] of schemaRefusals) {
    const b = await build([w.authority], [authorityOut(w.token, commitTo(details))], {
      admin: [{ index: 0, details: hexOf(details) }]
    })
    cases.push(
      record(
        id,
        b,
        w.afterIssue(),
        refused('ERR_SHAPE', `output 0: admin details violate the schema (${detail})`)
      )
    )
  }
  return cases
}

// ---- supply deltas and caps (layer C)

const deltaCases: Group = async w => {
  const { token: t, authority, coin } = w
  const cases: VectorCase[] = []
  const add = (id: string, b: Built, expected: Expected): void => {
    cases.push(record(id, b, w.afterIssue(), expected))
  }
  const rule = async (
    id: string,
    kind: 'issue' | 'redeem' | 'pause',
    values: bigint[],
    expectation: string
  ): Promise<void> => {
    const b = await act(
      authority,
      t,
      encodeAdminDetails({ kind }),
      values.map(amount => [holder, amount])
    )
    add(id, b, refused('ERR_CONSERVATION', `token ${t}: ${kind} requires delta ${expectation}`))
  }
  add(
    'unlabelled-mint',
    await build([authority], [valueOut(t, holder, 50n), authorityOut(t)]),
    refused('ERR_CONSERVATION', `token ${t}: plain authority requires delta = 0 but delta is 50`)
  )
  await rule('issue-without-a-positive-delta', 'issue', [], '> 0 but delta is 0')
  await rule('redeem-without-a-negative-delta', 'redeem', [], '< 0 but delta is 0')
  await rule('redeem-with-a-positive-delta', 'redeem', [10n], '< 0 but delta is 10')
  await rule('pause-with-a-delta', 'pause', [10n], '= 0 but delta is 10')
  const holderOut = (amount: bigint): TokenOut => valueOut(t, holder, amount, holder)
  add(
    'holder-implicit-burn',
    await build([coin], [holderOut(60n)]),
    refused('ERR_CONSERVATION', `token ${t}: value in 100 != value out 60 without an authority`)
  )
  add(
    'holder-overspend',
    await build([coin], [holderOut(150n)]),
    refused('ERR_CONSERVATION', `token ${t}: value in 100 != value out 150 without an authority`)
  )
  add(
    'value-out-of-nothing',
    await build([], [holderOut(5n)]),
    refused('ERR_CONSERVATION', `token ${t}: value in 0 != value out 5 without an authority`)
  )
  return cases
}

const MAX_SAFE = 2n ** 53n - 1n

const capCases: Group = async w => {
  const { token: t, authority } = w
  const issue = encodeAdminDetails({ kind: 'issue' })
  const sum = await act(authority, t, issue, [
    [holder, MAX_SAFE],
    [receiver, 1n]
  ])
  // the circulating supply is already one short of the cap
  const nearCap = w.afterIssue()
  nearCap.tokens.push({
    txid: 'cc'.repeat(32),
    outputIndex: 0,
    tokenId: t,
    amount: Number(MAX_SAFE) - 100,
    identityKey: holder.key
  })
  return [
    record(
      'value-sum-above-2^53-1',
      sum,
      w.afterIssue(),
      refused('ERR_SHAPE', `token ${t}: value sum exceeds 2^53-1`)
    ),
    record(
      'circulating-supply-above-2^53-1',
      await act(authority, t, issue, [[holder, 1n]]),
      nearCap,
      refused('ERR_SHAPE', `token ${t}: circulating supply would exceed 2^53-1`)
    )
  ]
}

// ---- reissue of a frozen coin (spec §3.3)

const FROZEN_COIN = `${'dd'.repeat(32)}.0`

const reissueCases: Group = async w => {
  const { token: t, authority, coin } = w
  const details = encodeAdminDetails({
    kind: 'reissue',
    outpoint: FROZEN_COIN,
    recipient: receiver.key
  })
  const frozen = (): VectorState => {
    const state = w.afterIssue()
    state.assetStates.push({
      ...defaultAssetState(t),
      frozenOutpoints: [{ outpoint: FROZEN_COIN, amount: 100, owner: holder.key }]
    })
    return state
  }
  const refuse = (detail: string): Expected => refused('ERR_SHAPE', `token ${t}: reissue ${detail}`)
  const withValueInput = await build(
    [authority, coin],
    [valueOut(t, receiver, 200n), authorityOut(t, commitTo(details))],
    { admin: [{ index: 1, details: hexOf(details) }] }
  )
  return [
    record(
      'reissue-of-an-unfrozen-outpoint',
      await act(authority, t, details, [[receiver, 100n]]),
      w.afterIssue(),
      refuse('target is not frozen')
    ),
    record(
      'reissue-with-the-wrong-amount',
      await act(authority, t, details, [[receiver, 99n]]),
      frozen(),
      refuse('amount does not match the frozen row')
    ),
    record(
      'reissue-spending-value-inputs',
      withValueInput,
      frozen(),
      refuse('must not spend value inputs')
    ),
    record(
      'reissue-to-the-wrong-recipient',
      await act(authority, t, details, [[holder, 100n]]),
      frozen(),
      refuse('outputs must go to the recipient')
    )
  ]
}

// ---- issuer controls (layer D)

const controlCases: Group = async w => {
  const { token: t, split } = w
  const coin = outpointOf(w.coin)
  const state = (
    patch: Partial<AssetAdminState>,
    extra: Partial<VectorState> = {}
  ): VectorState => ({
    ...w.afterIssue(),
    assetStates: [{ ...defaultAssetState(t), ...patch }],
    ...extra
  })
  const frozenCoin = [{ outpoint: coin, amount: 100, owner: holder.key }]
  const paused = { isPaused: true }
  const table: Array<[string, VectorState, Expected]> = [
    [
      'input-frozen',
      state({ frozenOutpoints: frozenCoin }),
      refused('ERR_FROZEN', `input 0: coin ${coin} is frozen`)
    ],
    [
      'input-evicted-by-a-reissue',
      state({ evictedOutpoints: [coin] }),
      refused('ERR_FROZEN', `input 0: coin ${coin} was evicted by a reissue`)
    ],
    [
      'frozen-input-before-paused',
      state({ ...paused, frozenOutpoints: frozenCoin }),
      refused('ERR_FROZEN', `input 0: coin ${coin} is frozen`)
    ],
    ['token-paused', state(paused), refused('ERR_PAUSED', `token ${t} is paused`)],
    [
      'identity-blocked',
      state({ blockedIdentities: [holder.key] }),
      refused('ERR_ACCESS', `token ${t}: ${holder.key} is blocked (denylist)`)
    ],
    [
      'identity-not-allowlisted',
      state({ accessMode: 'allowlist', allowedIdentities: [holder.key] }),
      refused('ERR_ACCESS', `token ${t}: ${receiver.key} is not allowlisted (allowlist)`)
    ],
    [
      'identity-sanctioned',
      state({}, { sanctioned: [receiver.key] }),
      refused('ERR_SANCTIONED', `identity ${receiver.key} is sanctioned`)
    ],
    [
      'identity-not-an-admitted-member',
      state({}, { members: [holder.key] }),
      refused('ERR_MEMBERSHIP', `identity ${receiver.key} is not an admitted registry member`)
    ]
  ]
  return table.map(([id, caseState, expected]) => record(id, split, caseState, expected))
}

// ---- the registry topic (spec §5.4)

const registryCases: Group = async w => {
  const { deploy: registryDeploy, token } = w.registry
  const opts = { topic: REGISTRY_TOPIC }
  const spend: Spend = { b: registryDeploy, vout: 0 }
  const admit = encodeAdminDetails({ kind: 'admitIdentity', identityKey: holder.key })
  const second = await deploy(issuer, { payload: REGISTRY_PAYLOAD })
  return [
    record(
      'registry-second-deploy',
      second,
      w.registry.state(),
      refused(
        'ERR_SHAPE',
        'tm_mandala_registry: registration chain already exists; register is genesis-only'
      ),
      opts
    ),
    record(
      'registry-value-output',
      await act(spend, token, admit, [[holder, 10n]]),
      w.registry.state(),
      refused('ERR_SHAPE', 'output 0: tm_mandala_registry does not admit value outputs'),
      opts
    ),
    record(
      'registry-mandala-kind',
      await act(spend, token, encodeAdminDetails({ kind: 'issue' })),
      w.registry.state(),
      refused(
        'ERR_SHAPE',
        'output 0: admin details violate the schema (kind issue is not allowed)'
      ),
      opts
    )
  ]
}

// ---- inputs the engine did not admit (the unanchored-prior class)
// The BEEF shows a token-shaped source, but previousCoins names none, so the input is ignored.

const unadmitted = (b: Built): Built => ({ ...b, previousCoins: [] })

const unadmittedInputCases: Group = async w => {
  const { token: t, authority, coin, registry } = w
  const opts = { topic: REGISTRY_TOPIC }
  const spendsRegistry = await act(
    { b: registry.deploy, vout: 0 },
    registry.token,
    encodeAdminDetails({ kind: 'admitIdentity', identityKey: holder.key })
  )
  return [
    record(
      'authority-input-not-admitted',
      unadmitted(await build([authority], [authorityOut(t)])),
      w.afterIssue(),
      refused(
        'ERR_AUTHORITY',
        `output 0: authority output without an admitted authority input of token ${t}`
      )
    ),
    record(
      'value-input-not-admitted',
      unadmitted(await build([coin], [valueOut(t, holder, 100n, holder)])),
      w.afterIssue(),
      refused('ERR_CONSERVATION', `token ${t}: value in 0 != value out 100 without an authority`)
    ),
    record(
      'registry-authority-input-not-admitted',
      unadmitted(spendsRegistry),
      registry.state(),
      refused(
        'ERR_AUTHORITY',
        `output 0: authority output without an admitted authority input of token ${registry.token}`
      ),
      opts
    )
  ]
}

// ---- admissions

const admitCases: Group = async w => {
  // the holder's coin has no index row: the spend repairs it from the owner journal (§4.2a)
  const lostRow = w.afterIssue()
  lostRow.tokens = []
  return [
    record('admit-signed-deploy', w.deploy, emptyState(), admits(0)),
    record('admit-issue-from-the-deploy-authority', w.issue, w.afterDeploy(), admits(0, 1)),
    record('admit-transfer-repairing-the-owner-row', w.split, lostRow, admits(0, 1))
  ]
}

// ---- revocation (proposed §4.3 rule 1 amendment): an authority input's owner must be trusted.
// Appended last, so the cases before it keep their bytes.

const revocationCases: Group = async w => {
  const { token: t, authority } = w
  const issue = encodeAdminDetails({ kind: 'issue' })
  // A key removed from the trusted set keeps no authority: the authority coin it still holds
  // cannot be spent, even into a trusted issuer's output that commits an action (retryable,
  // never persisted, lifted by re-trusting the key).
  const detrusted = w.afterIssue()
  for (const row of [...detrusted.authorities, ...detrusted.owners]) {
    if (at(authority.b.txid, authority.vout)(row)) row.identityKey = rogue.key
  }
  return [
    record(
      'authority-input-owned-by-an-untrusted-key',
      await build([authority], [valueOut(t, holder, 50n), authorityOut(t, commitTo(issue))], {
        admin: [{ index: 1, details: hexOf(issue) }]
      }),
      detrusted,
      refused('ERR_UNTRUSTED', `input 0: authority owner ${rogue.key} is not a trusted issuer`)
    )
  ]
}

// ---- the file ----------------------------------------------------------------------------------

const GROUPS: Group[] = [
  shapeCases,
  envelopeCases,
  linkageCases,
  inputCases,
  deployCases,
  payloadCases,
  authorityCases,
  detailsCases,
  deltaCases,
  capCases,
  reissueCases,
  controlCases,
  registryCases,
  unadmittedInputCases,
  admitCases,
  revocationCases
]

async function buildVectors(): Promise<Vectors> {
  nonce = 0
  keyCounter = 0
  const world = await buildWorld()
  const cases: VectorCase[] = []
  for (const group of GROUPS) cases.push(...(await group(world)))
  return {
    id: 'mandala.rejects',
    version: 1,
    verifierPrivateKey: VERIFIER_SCALAR,
    trustedIssuers: [issuer.key],
    cases
  }
}

const serialize = (vectors: Vectors): string => `${JSON.stringify(vectors, null, 2)}\n`

// ---- tests -------------------------------------------------------------------------------------

const SLOW = 300_000
const REFUSALS: MandalaRejectCode[] = [
  'ERR_SHAPE',
  'ERR_SATOSHIS',
  'ERR_LINKAGE',
  'ERR_CONSERVATION',
  'ERR_AUTHORITY',
  'ERR_UNTRUSTED',
  'ERR_PAUSED',
  'ERR_FROZEN',
  'ERR_ACCESS',
  'ERR_SANCTIONED',
  'ERR_MEMBERSHIP',
  'ERR_UNAVAILABLE'
]

const committed = (): Vectors => JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as Vectors
const fixtureOf = (v: Vectors): Fixture => ({
  verifierPrivateKey: v.verifierPrivateKey,
  trustedIssuers: v.trustedIssuers
})
const caseNamed = (v: Vectors, id: string): VectorCase => {
  const found = v.cases.find(c => c.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}

async function mismatches(v: Vectors): Promise<string[]> {
  const found: string[] = []
  for (const c of v.cases) {
    const outcome = await execute(c, clone(c.state), fixtureOf(v))
    if (!isDeepStrictEqual(outcome, outcomeOf(c))) {
      found.push(
        `${c.id}: expected ${JSON.stringify(outcomeOf(c))} but got ${JSON.stringify(outcome)}`
      )
    }
  }
  return found
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** The envelope with the random AES-GCM ciphertexts taken out, or the bytes when it is not JSON. */
function withoutCiphertext(hex: string): unknown {
  let doc: unknown
  try {
    doc = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'))
  } catch {
    return hex
  }
  const envelope = asRecord(doc)
  for (const list of [envelope?.inputs, envelope?.outputs]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const linkage = asRecord(asRecord(entry)?.linkage)
      delete linkage?.encryptedLinkage
      delete linkage?.encryptedLinkageProof
    }
  }
  return doc
}

const frozenParts = (v: Vectors): unknown => ({
  ...v,
  cases: v.cases.map(c => ({ ...c, offChainValues: withoutCiphertext(c.offChainValues) }))
})

describe('Mandala reject vectors', () => {
  let generated: Vectors

  beforeAll(async () => {
    generated = await buildVectors()
    if (process.env.REGENERATE_VECTORS === '1') writeFileSync(VECTORS_PATH, serialize(generated))
  }, SLOW)

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('has the shape the Go port reads', () => {
    const v = committed()
    expect(v.id).toBe('mandala.rejects')
    expect(v.version).toBe(1)
    expect(v.trustedIssuers).toEqual([issuer.key])
    expect(partyOf(v.verifierPrivateKey).key).toBe(overlay.key)
    for (const c of v.cases) {
      expect([MANDALA_TOPIC, REGISTRY_TOPIC]).toContain(c.topic)
      expect(c.beef).toMatch(/^([0-9a-f]{2})+$/)
      expect(c.offChainValues).toMatch(/^([0-9a-f]{2})*$/)
      expect(Object.keys(c.state).slice(0, 4)).toEqual([
        'tokens',
        'authorities',
        'owners',
        'assetStates'
      ])
    }
  })

  it('has at least 40 cases, unique ids, every refusal code and three admissions', () => {
    const v = committed()
    expect(v.cases.length).toBeGreaterThanOrEqual(40)
    expect(new Set(v.cases.map(c => c.id)).size).toBe(v.cases.length)
    const codes = new Set(v.cases.flatMap(c => ('code' in c.expected ? [c.expected.code] : [])))
    expect([...codes].sort()).toEqual([...REFUSALS].sort())
    expect(v.cases.filter(c => 'outputsToAdmit' in c.expected)).toHaveLength(3)
  })

  it(
    'replays every committed case to its expected verdict',
    async () => {
      expect(await mismatches(committed())).toEqual([])
    },
    SLOW
  )

  it(
    'exercises every catalog row except the storeUnavailable variants',
    async () => {
      const catalog = Reasons as unknown as Record<string, (...args: never[]) => unknown>
      const spies = Object.keys(catalog)
        .filter(name => name !== 'storeUnavailable' && name !== 'storeWriteUnavailable')
        .map(name => ({ name, spy: jest.spyOn(catalog, name) }))
      await mismatches(committed())
      expect(
        spies.filter(({ spy }) => spy.mock.calls.length === 0).map(({ name }) => name)
      ).toEqual([])
    },
    SLOW
  )

  it(
    'journals the owner of every admitted output',
    async () => {
      const v = committed()
      for (const c of v.cases.filter(x => 'outputsToAdmit' in x.expected)) {
        const state = clone(c.state)
        await execute(c, state, fixtureOf(v))
        const txid = Transaction.fromBEEF(bytesOf(c.beef)).id('hex')
        const indices = 'outputsToAdmit' in c.expected ? c.expected.outputsToAdmit : []
        const journaled = state.owners.filter(o => o.txid === txid).map(o => o.outputIndex)
        expect(journaled).toEqual(indices)
      }
    },
    SLOW
  )

  it(
    'repairs the missing owner row inline when the transfer is admitted',
    async () => {
      const v = committed()
      const c = caseNamed(v, 'admit-transfer-repairing-the-owner-row')
      const lost = c.state.owners.find(o => o.role === 'value')
      if (lost === undefined) throw new Error('the case journals no value output')
      expect(c.state.tokens).toEqual([])
      const state = clone(c.state)
      const repairs: string[] = []
      await execute(c, state, fixtureOf(v), repairs)
      expect(repairs).toEqual([`${lost.txid}.${lost.outputIndex}`])
      expect(state.tokens).toEqual([
        {
          txid: lost.txid,
          outputIndex: lost.outputIndex,
          tokenId: lost.tokenId,
          amount: lost.amount,
          identityKey: lost.identityKey
        }
      ])
    },
    SLOW
  )

  it('is what the generator builds now, linkage ciphertext aside', () => {
    expect(frozenParts(JSON.parse(serialize(generated)) as Vectors)).toEqual(
      frozenParts(committed())
    )
  })
})
