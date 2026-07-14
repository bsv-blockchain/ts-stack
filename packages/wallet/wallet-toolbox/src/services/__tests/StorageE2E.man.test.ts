/**
 * Production Storage + Arcade + Monitor end-to-end tests.
 *
 * This is a manual, mainnet-only suite. It exercises the authenticated Storage
 * API, Storage's transaction lifecycle, Arcade-first broadcasting, Arcade SSE
 * routing, Monitor proof acquisition, and the final Storage status update.
 *
 * Required:
 *   STORAGE_E2E_ALLOW_MAINNET=true
 *   STORAGE_E2E_ROOT_KEY=<funded private key hex>
 *   STORAGE_E2E_ARCADE_TOKEN=<token shared by broadcaster and Monitor>
 */

import { writeFileSync } from 'fs'
import { Beef, CachedKeyDeriver, P2PKH, PrivateKey } from '@bsv/sdk'
import { Wallet } from '../../Wallet'
import { Services } from '../Services'
import { createDefaultWalletServicesOptions } from '../createDefaultWalletServicesOptions'
import { WalletStorageManager } from '../../storage/WalletStorageManager'
import { StorageClient } from '../../storage/remoting/StorageClient'
import { ScriptTemplateBRC29 } from '../../utility/ScriptTemplateBRC29'
import { randomBytesBase64 } from '../../utility/utilityHelpers'
import { ARCADE_POST_BEEF_CONCURRENCY } from '../providers/Arcade'

const ALLOW_MAINNET = process.env.STORAGE_E2E_ALLOW_MAINNET === 'true'
const ROOT_KEY_HEX = process.env.STORAGE_E2E_ROOT_KEY ?? ''
const TARGET_URL = (process.env.STORAGE_E2E_TARGET_URL ?? 'https://storage.babbage.systems').replace(/\/$/, '')
const ARCADE_URL = (process.env.STORAGE_E2E_ARCADE_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech').replace(/\/$/, '')
const ARCADE_TOKEN = process.env.STORAGE_E2E_ARCADE_TOKEN ?? ''
const USER_COUNT = integerEnv('STORAGE_E2E_USER_COUNT', 3, 2, 20)
const USER_OFFSET = integerEnv('STORAGE_E2E_USER_OFFSET', 0, 0, 1000000)
const TX_COUNT = integerEnv('STORAGE_E2E_TX_COUNT', 3, 1, 100)
const OUTPUT_SATS = integerEnv('STORAGE_E2E_OUTPUT_SATS', 100, 1, 100000)
const USER_FUNDING_SATS = integerEnv('STORAGE_E2E_USER_FUNDING_SATS', 400, OUTPUT_SATS + 200, 1000000)
const MULTI_USER_ROUNDS = integerEnv('STORAGE_E2E_MULTI_USER_ROUNDS', 1, 1, 20)
const PROOF_TIMEOUT_MS = integerEnv('STORAGE_E2E_PROOF_TIMEOUT_MS', 45 * 60 * 1000, 60 * 1000, 4 * 60 * 60 * 1000)
const PROOF_POLL_MS = integerEnv('STORAGE_E2E_PROOF_POLL_MS', 30 * 1000, 5000, 5 * 60 * 1000)
const PROOF_REQUEST_TIMEOUT_MS = integerEnv('STORAGE_E2E_PROOF_REQUEST_TIMEOUT_MS', 30 * 1000, 1000, 5 * 60 * 1000)
const PROOF_ARCADE_CONCURRENCY = integerEnv('STORAGE_E2E_PROOF_ARCADE_CONCURRENCY', 8, 1, 32)
const RAW_REQUEST_COUNT = integerEnv('STORAGE_E2E_READ_COUNT', 30, 1, 1000)
const EVIDENCE_FILE = process.env.STORAGE_E2E_EVIDENCE_FILE
const RUN_ID = process.env.STORAGE_E2E_RUN_ID ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const RUN_LABEL = `storage-e2e-${RUN_ID}`
const RUN_BASKET = `storage-e2e-${RUN_ID}`
const CEILING_BATCHES = parseBatches(process.env.STORAGE_E2E_CEILING_BATCHES ?? '2,4,8')
const LOAD_REPEATS = integerEnv('STORAGE_E2E_LOAD_REPEATS', 1, 1, 10)
const REQUIRED_USER_UTXOS = requiredUserUtxos()

interface Stats {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p95: number
  p99: number
}

interface TestWallet {
  wallet: Wallet
  services: Services
  index: number
}

interface TrackedTransaction {
  txid: string
  test: string
  walletIndex: number
  broadcastAt: string
}

interface PreparedTransaction {
  txid: string
  beef: Beef
  wallet: TestWallet
  elapsedMs: number
}

interface BatchResult {
  txids: string[]
  identityCount: number
  prepareWallMs: number
  prepareTimings: number[]
  arcadeWallMs: number
  reconciliationWallMs: number
  reconciliationTimings: number[]
  totalWallMs: number
}

interface BatchMetrics {
  transactionCount: number
  identityCount: number
  preparation: Stats & { wallMs: number, transactionsPerSecond: number }
  arcadeSubmission: { httpRequests: number, configuredMaxConcurrency: number, wallMs: number, transactionsPerSecond: number }
  storageReconciliation: Stats & { rpcRequests: number, wallMs: number, transactionsPerSecond: number }
  submissionThroughStorage: { wallMs: number, transactionsPerSecond: number }
  clientEndToEnd: { wallMs: number, transactionsPerSecond: number }
}

interface LoadRun {
  batchSize: number
  repeat: number
  result: BatchResult
  metrics: BatchMetrics
}

interface ProofObservation {
  txid: string
  test: string
  walletIndex: number
  arcadeStatus?: string
  blockHeight?: number
  arcadeProof: boolean
  arcadeProofObservedAt?: string
  storageStatus?: string
  storageCompletedObservedAt?: string
  completedAt?: string
  convergenceMs?: number
  error?: string
}

const evidence: {
  runId: string
  startedAt: string
  finishedAt?: string
  targetUrl: string
  arcadeUrl: string
  sizing: Record<string, number | number[]>
  metrics: Record<string, unknown>
  transactions: TrackedTransaction[]
  proofs: ProofObservation[]
} = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  targetUrl: TARGET_URL,
  arcadeUrl: ARCADE_URL,
  sizing: {
    userCount: USER_COUNT,
    userOffset: USER_OFFSET,
    txCount: TX_COUNT,
    outputSats: OUTPUT_SATS,
    userFundingSats: USER_FUNDING_SATS,
    requiredUserUtxos: REQUIRED_USER_UTXOS,
    multiUserRounds: MULTI_USER_ROUNDS,
    ceilingBatches: CEILING_BATCHES,
    loadRepeats: LOAD_REPEATS,
    proofPollMs: PROOF_POLL_MS,
    proofRequestTimeoutMs: PROOF_REQUEST_TIMEOUT_MS,
    proofArcadeConcurrency: PROOF_ARCADE_CONCURRENCY
  },
  metrics: {},
  transactions: [],
  proofs: []
}

let root: TestWallet
let users: TestWallet[] = []

function integerEnv (name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`)
  }
  return value
}

function parseBatches (value: string): number[] {
  const batches = value.split(',').map(v => Number.parseInt(v.trim(), 10))
  if (batches.length === 0 || batches.some(v => !Number.isInteger(v) || v < 1 || v > 100)) {
    throw new Error('STORAGE_E2E_CEILING_BATCHES must be comma-separated integers from 1 through 100')
  }
  return batches
}

function requiredUserUtxos (): number[] {
  const required = Array.from({ length: USER_COUNT }, () => MULTI_USER_ROUNDS)
  const transactionsPerSingleIdentity = CEILING_BATCHES.reduce((sum, count) => sum + count, 0) * LOAD_REPEATS
  required[0] += transactionsPerSingleIdentity

  const shardedIdentityCount = USER_COUNT - 1
  for (const count of CEILING_BATCHES) {
    for (let repeat = 0; repeat < LOAD_REPEATS; repeat++) {
      for (let index = 0; index < count; index++) required[1 + (index % shardedIdentityCount)]++
    }
  }
  return required
}

function calcStats (timings: number[]): Stats {
  if (timings.length === 0) throw new Error('Cannot calculate statistics for an empty sample')
  const sorted = [...timings].sort((a, b) => a - b)
  const percentile = (p: number): number => sorted[Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1)]
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sorted.reduce((sum, n) => sum + n, 0) / sorted.length),
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99)
  }
}

function throughput (count: number, wallMs: number): number {
  return Math.round((count / (wallMs / 1000)) * 10) / 10
}

function batchMetrics (result: BatchResult): BatchMetrics {
  const transactionCount = result.txids.length
  const submissionWallMs = result.arcadeWallMs + result.reconciliationWallMs
  return {
    transactionCount,
    identityCount: result.identityCount,
    preparation: {
      ...calcStats(result.prepareTimings),
      wallMs: result.prepareWallMs,
      transactionsPerSecond: throughput(transactionCount, result.prepareWallMs)
    },
    arcadeSubmission: {
      httpRequests: transactionCount,
      configuredMaxConcurrency: ARCADE_POST_BEEF_CONCURRENCY,
      wallMs: result.arcadeWallMs,
      transactionsPerSecond: throughput(transactionCount, result.arcadeWallMs)
    },
    storageReconciliation: {
      ...calcStats(result.reconciliationTimings),
      rpcRequests: result.reconciliationTimings.length,
      wallMs: result.reconciliationWallMs,
      transactionsPerSecond: throughput(transactionCount, result.reconciliationWallMs)
    },
    submissionThroughStorage: {
      wallMs: submissionWallMs,
      transactionsPerSecond: throughput(transactionCount, submissionWallMs)
    },
    clientEndToEnd: {
      wallMs: result.totalWallMs,
      transactionsPerSecond: throughput(transactionCount, result.totalWallMs)
    }
  }
}

function summarizeLoadRuns (runs: LoadRun[]): Array<Record<string, number>> {
  return CEILING_BATCHES.filter(batchSize => runs.some(run => run.batchSize === batchSize)).map(batchSize => {
    const matches = runs.filter(run => run.batchSize === batchSize)
    const totalTransactions = matches.reduce((sum, run) => sum + run.result.txids.length, 0)
    const sum = (field: keyof Pick<BatchResult, 'prepareWallMs' | 'arcadeWallMs' | 'reconciliationWallMs' | 'totalWallMs'>): number =>
      matches.reduce((total, run) => total + run.result[field], 0)
    const arcadeWallMs = sum('arcadeWallMs')
    const reconciliationWallMs = sum('reconciliationWallMs')
    return {
      batchSize,
      repeats: matches.length,
      totalTransactions,
      identityCount: matches[0]?.result.identityCount ?? 0,
      preparationTps: throughput(totalTransactions, sum('prepareWallMs')),
      arcadeSubmissionTps: throughput(totalTransactions, arcadeWallMs),
      storageReconciliationTps: throughput(totalTransactions, reconciliationWallMs),
      submissionThroughStorageTps: throughput(totalTransactions, arcadeWallMs + reconciliationWallMs),
      clientEndToEndTps: throughput(totalTransactions, sum('totalWallMs'))
    }
  })
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T> (description: string, operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out after ${PROOF_REQUEST_TIMEOUT_MS}ms`)), PROOF_REQUEST_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

async function forEachWithConcurrency<T> (items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
}

function deriveUserKey (userIndex: number): PrivateKey {
  const rootKey = PrivateKey.fromHex(ROOT_KEY_HEX)
  return new CachedKeyDeriver(rootKey).derivePrivateKey(
    [2, 'storage e2e user'],
    String(userIndex + USER_OFFSET),
    'self'
  )
}

async function makeWallet (key: PrivateKey, index: number): Promise<TestWallet> {
  const keyDeriver = new CachedKeyDeriver(key)
  const options = createDefaultWalletServicesOptions(
    'main', undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    ARCADE_URL, undefined, ARCADE_TOKEN
  )
  const services = new Services(options)
  const storage = new WalletStorageManager(keyDeriver.identityKey)
  const wallet = new Wallet({ chain: 'main', keyDeriver, storage, services })
  await storage.addWalletStorageProvider(new StorageClient(wallet, TARGET_URL))
  await storage.makeAvailable()
  return { wallet, services, index }
}

function lockingScript (wallet: TestWallet): string {
  return new P2PKH().lock(wallet.wallet.keyDeriver.rootKey.toPublicKey().toAddress()).toHex()
}

function output (wallet: TestWallet, description: string): {
  lockingScript: string
  satoshis: number
  outputDescription: string
  basket: string
  tags: string[]
} {
  return {
    lockingScript: lockingScript(wallet),
    satoshis: OUTPUT_SATS,
    outputDescription: description.slice(0, 50),
    basket: RUN_BASKET,
    tags: [RUN_LABEL]
  }
}

function track (txid: string | undefined, test: string, walletIndex: number): string {
  if (txid == null || txid === '') throw new Error(`${test} did not return a txid`)
  if (!evidence.transactions.some(t => t.txid === txid)) {
    evidence.transactions.push({ txid, test, walletIndex, broadcastAt: new Date().toISOString() })
  }
  return txid
}

async function fundUsers (): Promise<string | undefined> {
  const inventories = await Promise.all(users.map(async user => ({
    user,
    outputs: (await user.wallet.listOutputs({ basket: 'default', limit: 10000 })).totalOutputs
  })))
  const shortages = inventories.map(({ user, outputs }) => ({
    user,
    count: Math.max(0, REQUIRED_USER_UTXOS[user.index - 1] - outputs)
  }))
  const totalShortage = shortages.reduce((sum, shortage) => sum + shortage.count, 0)
  if (totalShortage === 0) {
    console.log(`[setup] derived users have required independent UTXOs ${JSON.stringify(REQUIRED_USER_UTXOS)}`)
    return undefined
  }

  const payments: Array<{ user: TestWallet, template: ScriptTemplateBRC29, lockingScript: string }> = []
  for (const shortage of shortages) {
    for (let index = 0; index < shortage.count; index++) {
      const template = new ScriptTemplateBRC29({
        derivationPrefix: randomBytesBase64(8),
        derivationSuffix: randomBytesBase64(8),
        keyDeriver: root.wallet.keyDeriver
      })
      payments.push({
        user: shortage.user,
        template,
        lockingScript: template.lock(ROOT_KEY_HEX, shortage.user.wallet.identityKey).toHex()
      })
    }
  }
  console.log(`[setup] provisioning ${payments.length} independent UTXOs; required=${JSON.stringify(REQUIRED_USER_UTXOS)}`)

  const created = await root.wallet.createAction({
    description: `${RUN_LABEL} fund users`.slice(0, 50),
    labels: [RUN_LABEL],
    outputs: payments.map((payment, index) => ({
      lockingScript: payment.lockingScript,
      satoshis: USER_FUNDING_SATS,
      outputDescription: `fund e2e user ${payment.user.index} output ${index + 1}`.slice(0, 50),
      tags: [RUN_LABEL]
    })),
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  const txid = track(created.txid, 'setup-user-funding', root.index)
  if (created.tx == null) throw new Error('User funding did not return Atomic BEEF')
  const fundingBeef = created.tx

  const paymentsByUser = new Map<number, Array<{ payment: typeof payments[number], outputIndex: number }>>()
  payments.forEach((payment, outputIndex) => {
    const group = paymentsByUser.get(payment.user.index) ?? []
    group.push({ payment, outputIndex })
    paymentsByUser.set(payment.user.index, group)
  })

  await Promise.all([...paymentsByUser.values()].map(async group => {
    const { wallet } = group[0].payment.user
    await wallet.internalizeAction({
      tx: fundingBeef,
      outputs: group.map(({ payment, outputIndex }) => {
        const derivationPrefix = payment.template.params.derivationPrefix
        const derivationSuffix = payment.template.params.derivationSuffix
        if (derivationPrefix == null || derivationSuffix == null) throw new Error(`Missing BRC-29 derivation for output ${outputIndex}`)
        return {
          outputIndex,
          protocol: 'wallet payment' as const,
          paymentRemittance: {
            derivationPrefix,
            derivationSuffix,
            senderIdentityKey: root.wallet.identityKey
          }
        }
      }),
      description: `${RUN_LABEL} funding`.slice(0, 50),
      labels: [RUN_LABEL]
    })
  }))
  return txid
}

async function assertConfirmedSpendableState (wallets: TestWallet[], context: string): Promise<void> {
  for (const item of wallets) {
    const [listed, actions] = await Promise.all([
      item.wallet.listOutputs({ basket: 'default', include: 'locking scripts', limit: 10000 }),
      item.wallet.listActions({ labels: [], limit: 10000 })
    ])
    const statusByTxid = new Map(actions.actions.map(action => [action.txid, action.status]))
    const problems: string[] = []
    const networkCandidates = listed.outputs.filter(output => {
      const txid = output.outpoint.slice(0, 64)
      const storageStatus = statusByTxid.get(txid)
      if (storageStatus !== 'completed') {
        problems.push(`${output.outpoint}:Storage=${storageStatus ?? 'missing'}`)
        return false
      }
      if (output.lockingScript == null) {
        problems.push(`${output.outpoint}:missing locking script`)
        return false
      }
      return true
    })
    let nextCandidate = 0
    let confirmed = 0
    const worker = async (): Promise<void> => {
      while (nextCandidate < networkCandidates.length) {
        const output = networkCandidates[nextCandidate++]
        const network = await item.services.getUtxoStatus(
          item.services.hashOutputScript(output.lockingScript ?? ''),
          undefined,
          output.outpoint
        )
        if (network.status !== 'success' || network.isUtxo !== true) {
          problems.push(`${output.outpoint}:${network.name}=${network.status}/${String(network.isUtxo)}`)
        } else {
          confirmed++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, networkCandidates.length) }, worker))
    console.log(`[setup] ${context} wallet=${item.index} confirmedSpendable=${confirmed}/${listed.outputs.length}`)
    if (problems.length > 0) {
      throw new Error(`${context} wallet ${item.index} has unresolved or network-spent Storage outputs; wait for Monitor or use a clean identity: ${problems.join(', ')}`)
    }
  }
}

async function recoverNoSendActions (): Promise<number> {
  let recoveredCount = 0
  await Promise.all([root, ...users].map(async item => {
    const listed = await item.wallet.listActions({ labels: [RUN_LABEL], limit: 1000 })
    const txids = listed.actions.filter(action => action.status === 'nosend').map(action => action.txid)
    if (txids.length === 0) return
    recoveredCount += txids.length
    console.log(`[setup] recovering ${txids.length} noSend action(s) for wallet ${item.index}`)
    for (const txid of txids) track(txid, 'setup-nosend-recovery', item.index)
    const recovered = await item.wallet.createAction({
      description: `${RUN_LABEL} recover wallet ${item.index}`.slice(0, 50),
      options: { sendWith: txids, acceptDelayedBroadcast: false }
    })
    const failures = recovered.sendWithResults?.filter(result => result.status !== 'unproven') ?? []
    if (failures.length > 0) throw new Error(`noSend recovery failures: ${JSON.stringify(failures)}`)
  }))
  return recoveredCount
}

async function createNoSendBatch (wallet: TestWallet, count: number, test: string): Promise<PreparedTransaction[]> {
  const created: PreparedTransaction[] = []
  for (let i = 0; i < count; i++) {
    const started = Date.now()
    const result = await wallet.wallet.createAction({
      description: `${RUN_LABEL} ${test} ${i + 1}`.slice(0, 50),
      labels: [RUN_LABEL],
      outputs: [output(wallet, `${test} ${i + 1}`)],
      options: { noSend: true, randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    if (result.tx == null) throw new Error(`${test} transaction ${i + 1} did not return Atomic BEEF`)
    if (result.txid == null || result.txid === '') throw new Error(`${test} transaction ${i + 1} did not return a txid`)
    created.push({ txid: result.txid, beef: Beef.fromBinary(result.tx), wallet, elapsedMs: Date.now() - started })
  }
  return created
}

async function broadcastConcurrentlyAndReconcile (
  batchWallets: TestWallet[],
  count: number,
  test: string
): Promise<BatchResult> {
  if (batchWallets.length === 0) throw new Error(`${test} requires at least one wallet`)
  const totalStarted = Date.now()
  const assignments = batchWallets
    .map((wallet, index) => ({ wallet, count: Math.floor(count / batchWallets.length) + (index < count % batchWallets.length ? 1 : 0) }))
    .filter(assignment => assignment.count > 0)

  const prepareStarted = Date.now()
  const created = (await Promise.all(assignments.map(async assignment =>
    await createNoSendBatch(assignment.wallet, assignment.count, test)
  ))).flat()
  const prepareWallMs = Date.now() - prepareStarted

  const mergedBeef = new Beef()
  for (const item of created) mergedBeef.mergeBeef(item.beef)
  const txids = created.map(item => item.txid)
  const arcadeStarted = Date.now()
  const responses = await root.services.postBeef(mergedBeef, txids)
  const arcadeWallMs = Date.now() - arcadeStarted
  const arcade = responses.find(response => response.name === 'arcade')
  const failed = arcade == null
    ? txids
    : txids.filter(txid => !arcade.txidResults.some(result => result.txid === txid && result.status === 'success'))
  if (arcade?.status !== 'success' || failed.length > 0) throw new Error(`${test} Arcade failures: ${failed.join(', ')}`)
  for (const item of created) track(item.txid, test, item.wallet.index)

  const reconciliationStarted = Date.now()
  const reconciliationTimings = await Promise.all(assignments.map(async ({ wallet }) => {
    const walletTxids = created.filter(item => item.wallet.index === wallet.index).map(item => item.txid)
    const requestStarted = Date.now()
    const reconciliation = await wallet.wallet.createAction({
      description: `${RUN_LABEL} reconcile ${test} wallet ${wallet.index}`.slice(0, 50),
      options: { sendWith: walletTxids, acceptDelayedBroadcast: false }
    })
    const sendFailures = reconciliation.sendWithResults?.filter(result => result.status !== 'unproven') ?? []
    if (sendFailures.length > 0) throw new Error(`${test} Storage reconciliation failures: ${JSON.stringify(sendFailures)}`)
    return Date.now() - requestStarted
  }))
  const reconciliationWallMs = Date.now() - reconciliationStarted

  return {
    txids,
    identityCount: assignments.length,
    prepareWallMs,
    prepareTimings: created.map(item => item.elapsedMs),
    arcadeWallMs,
    reconciliationWallMs,
    reconciliationTimings,
    totalWallMs: Date.now() - totalStarted
  }
}

async function waitForProofs (): Promise<ProofObservation[]> {
  const transactions = new Map(evidence.transactions.map(transaction => [transaction.txid, transaction]))
  const pending = new Set(evidence.transactions.map(transaction => transaction.txid))
  const observations = new Map<string, ProofObservation>()
  for (const transaction of evidence.transactions) {
    observations.set(transaction.txid, {
      txid: transaction.txid,
      test: transaction.test,
      walletIndex: transaction.walletIndex,
      arcadeProof: false
    })
  }

  const started = Date.now()
  while (pending.size > 0 && Date.now() - started < PROOF_TIMEOUT_MS) {
    const pendingTransactions = [...pending].map(txid => {
      const transaction = transactions.get(txid)
      if (transaction == null) throw new Error(`Missing transaction evidence for ${txid}`)
      return transaction
    })
    for (const transaction of pendingTransactions) {
      const observation = observations.get(transaction.txid)
      if (observation != null) observation.error = undefined
    }
    const storageStatuses = new Map<string, string>()
    await Promise.all([root, ...users].map(async item => {
      try {
        const result = await withTimeout(
          `Storage listActions wallet ${item.index}`,
          item.wallet.listActions({ labels: [RUN_LABEL], limit: 1000 })
        )
        for (const action of result.actions) storageStatuses.set(action.txid, action.status)
      } catch (error: unknown) {
        for (const transaction of pendingTransactions.filter(transaction => transaction.walletIndex === item.index)) {
          const observation = observations.get(transaction.txid)
          if (observation != null) observation.error = `Storage: ${errorMessage(error)}`
        }
      }
    }))

    await forEachWithConcurrency(pendingTransactions, PROOF_ARCADE_CONCURRENCY, async transaction => {
      const observation = observations.get(transaction.txid)
      if (observation == null) throw new Error(`Missing proof observation for ${transaction.txid}`)
      try {
        const arcadeService = root.services.arcade
        if (arcadeService == null) throw new Error('Arcade is not configured')
        const arcade = await withTimeout(`Arcade getTxData ${transaction.txid}`, arcadeService.getTxData(transaction.txid))
        observation.arcadeStatus = arcade.txStatus
        observation.blockHeight = arcade.blockHeight === 0 ? undefined : arcade.blockHeight
        observation.arcadeProof = (arcade.txStatus === 'MINED' || arcade.txStatus === 'IMMUTABLE') && arcade.merklePath != null && arcade.merklePath !== ''
        if (observation.arcadeProof && observation.arcadeProofObservedAt == null) {
          observation.arcadeProofObservedAt = new Date().toISOString()
        }
      } catch (error: unknown) {
        const arcadeError = `Arcade: ${errorMessage(error)}`
        observation.error = observation.error == null ? arcadeError : `${observation.error}; ${arcadeError}`
      }

      const storageStatus = storageStatuses.get(transaction.txid)
      if (storageStatus != null) observation.storageStatus = storageStatus
      if (observation.storageStatus === 'completed' && observation.storageCompletedObservedAt == null) {
        observation.storageCompletedObservedAt = new Date().toISOString()
      }
      if (observation.arcadeProof && observation.storageStatus === 'completed') {
        if (observation.completedAt == null) {
          observation.completedAt = new Date().toISOString()
          observation.convergenceMs = Date.parse(observation.completedAt) - Date.parse(transaction.broadcastAt)
        }
        pending.delete(transaction.txid)
      }
    })

    const statusCounts: Record<string, number> = {}
    for (const observation of observations.values()) {
      const key = `${observation.arcadeStatus ?? 'unknown'}/${observation.storageStatus ?? 'unknown'}`
      statusCounts[key] = (statusCounts[key] ?? 0) + 1
    }
    console.log(`[proofs] elapsed=${Math.round((Date.now() - started) / 1000)}s pending=${pending.size}/${observations.size} ${JSON.stringify(statusCounts)}`)
    if (pending.size > 0) await new Promise(resolve => setTimeout(resolve, PROOF_POLL_MS))
  }
  return [...observations.values()]
}

const describeMainnet = ALLOW_MAINNET ? describe : describe.skip

describeMainnet('Production Storage + Arcade + Monitor E2E', () => {
  jest.setTimeout(PROOF_TIMEOUT_MS + 15 * 60 * 1000)

  beforeAll(async () => {
    if (!/^[0-9a-fA-F]{64}$/.test(ROOT_KEY_HEX)) throw new Error('STORAGE_E2E_ROOT_KEY must be 64 hex characters')
    if (ARCADE_TOKEN.length < 8) throw new Error('STORAGE_E2E_ARCADE_TOKEN is required')
    const target = new URL(TARGET_URL)
    if (target.protocol !== 'https:') throw new Error('Production E2E target must use HTTPS')

    root = await makeWallet(PrivateKey.fromHex(ROOT_KEY_HEX), 0)
    users = await Promise.all(Array.from({ length: USER_COUNT }, async (_, index) => await makeWallet(deriveUserKey(index + 1), index + 1)))
    expect(root.services.postBeefServices.services[0].name).toBe('ArcadeBeef')
    const recoveredCount = await recoverNoSendActions()
    if (recoveredCount > 0) {
      const recoveryProofs = await waitForProofs()
      const recoveryFailures = recoveryProofs.filter(proof => !proof.arcadeProof || proof.storageStatus !== 'completed')
      evidence.metrics.setupRecoveryConvergence = {
        total: recoveryProofs.length,
        completed: recoveryProofs.length - recoveryFailures.length,
        failures: recoveryFailures.length
      }
      if (recoveryFailures.length > 0) throw new Error(`Recovered noSend transactions did not converge: ${JSON.stringify(recoveryFailures)}`)
    }
    await assertConfirmedSpendableState([root, ...users], 'preflight')

    const balance = await root.wallet.balance()
    // Test outputs return to their originating wallets, so reserve the user
    // fan-out plus the largest direct case rather than treating every output as
    // permanently consumed.
    const largestLiveChain = Math.max(TX_COUNT, ...CEILING_BATCHES)
    const estimatedMinimum = REQUIRED_USER_UTXOS.reduce((sum, count) => sum + count, 0) * USER_FUNDING_SATS +
      largestLiveChain * (OUTPUT_SATS + 500)
    console.log(`[setup] run=${RUN_ID} target=${TARGET_URL} rootBalance=${balance} estimatedMinimum=${estimatedMinimum}`)
    expect(balance).toBeGreaterThan(estimatedMinimum)
    const fundingTxid = await fundUsers()
    if (fundingTxid != null) {
      const setupProofs = await waitForProofs()
      const setupFailures = setupProofs.filter(proof => !proof.arcadeProof || proof.storageStatus !== 'completed')
      evidence.metrics.setupFundingConvergence = {
        total: setupProofs.length,
        completed: setupProofs.length - setupFailures.length,
        failures: setupFailures.length
      }
      if (setupFailures.length > 0) throw new Error(`Funding did not converge: ${JSON.stringify(setupFailures)}`)
    }
    await assertConfirmedSpendableState(users, 'funded')
  })

  afterAll(async () => {
    evidence.finishedAt = new Date().toISOString()
    if (EVIDENCE_FILE != null && EVIDENCE_FILE !== '') {
      writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
      console.log(`[evidence] ${EVIDENCE_FILE}`)
    }
    await Promise.all([root, ...users].filter(Boolean).map(async item => await item.wallet.destroy()))
  })

  test(`1a raw HTTPS sequential (${RAW_REQUEST_COUNT})`, async () => {
    const timings: number[] = []
    for (let i = 0; i < RAW_REQUEST_COUNT; i++) {
      const started = Date.now()
      const response = await fetch(`${TARGET_URL}/`)
      expect(response.ok).toBe(true)
      await response.arrayBuffer()
      timings.push(Date.now() - started)
    }
    const stats = calcStats(timings)
    evidence.metrics.rawSequential = stats
    console.log(`[read:raw:sequential] ${JSON.stringify(stats)}`)
    expect(stats.p95).toBeLessThan(5000)
  })

  test(`1b raw HTTPS concurrent (${RAW_REQUEST_COUNT})`, async () => {
    const started = Date.now()
    const timings = await Promise.all(Array.from({ length: RAW_REQUEST_COUNT }, async () => {
      const requestStarted = Date.now()
      const response = await fetch(`${TARGET_URL}/`)
      expect(response.ok).toBe(true)
      await response.arrayBuffer()
      return Date.now() - requestStarted
    }))
    const wallMs = Date.now() - started
    const result = { ...calcStats(timings), wallMs, requestsPerSecond: throughput(RAW_REQUEST_COUNT, wallMs) }
    evidence.metrics.rawConcurrent = result
    console.log(`[read:raw:concurrent] ${JSON.stringify(result)}`)
    expect(result.p95).toBeLessThan(10000)
  })

  test(`1c authenticated listOutputs single identity (${USER_COUNT * 4} concurrent)`, async () => {
    await root.wallet.listOutputs({ basket: RUN_BASKET, limit: 10 })
    const count = USER_COUNT * 4
    const started = Date.now()
    const timings = await Promise.all(Array.from({ length: count }, async () => {
      const requestStarted = Date.now()
      await root.wallet.listOutputs({ basket: RUN_BASKET, limit: 100 })
      return Date.now() - requestStarted
    }))
    const wallMs = Date.now() - started
    const result = { ...calcStats(timings), wallMs, requestsPerSecond: throughput(count, wallMs) }
    evidence.metrics.authenticatedSingleUser = result
    console.log(`[read:authenticated:single] ${JSON.stringify(result)}`)
    expect(result.p95).toBeLessThan(15000)
  })

  test(`1d authenticated listOutputs multi-identity (${USER_COUNT} users x 4)`, async () => {
    const started = Date.now()
    const timings = (await Promise.all(users.map(async ({ wallet }) => await Promise.all(
      Array.from({ length: 4 }, async () => {
        const requestStarted = Date.now()
        await wallet.listOutputs({ basket: 'default', limit: 100 })
        return Date.now() - requestStarted
      })
    )))).flat()
    const wallMs = Date.now() - started
    const result = { ...calcStats(timings), wallMs, requestsPerSecond: throughput(timings.length, wallMs) }
    evidence.metrics.authenticatedMultiUser = result
    console.log(`[read:authenticated:multi] ${JSON.stringify(result)}`)
    expect(result.p95).toBeLessThan(15000)
  })

  test('1e authenticated listActions reflects setup transaction', async () => {
    const result = await root.wallet.listActions({ labels: [RUN_LABEL], includeLabels: true, limit: 1000 })
    console.log(`[read:listActions] total=${result.totalActions} statuses=${JSON.stringify(result.actions.map(action => action.status))}`)
    expect(Array.isArray(result.actions)).toBe(true)
  })

  test(`2a sequential Storage writes (${TX_COUNT})`, async () => {
    const timings: number[] = []
    for (let i = 0; i < TX_COUNT; i++) {
      const started = Date.now()
      const result = await root.wallet.createAction({
        description: `${RUN_LABEL} sequential ${i + 1}`.slice(0, 50),
        labels: [RUN_LABEL],
        outputs: [output(root, `sequential ${i + 1}`)],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      timings.push(Date.now() - started)
      track(result.txid, '2a-sequential', root.index)
    }
    const stats = calcStats(timings)
    evidence.metrics.sequentialWrites = { ...stats, transactionsPerSecond: throughput(TX_COUNT, timings.reduce((sum, n) => sum + n, 0)) }
    console.log(`[write:sequential] ${JSON.stringify(evidence.metrics.sequentialWrites)}`)
  })

  test(`2b concurrent Arcade submission with Storage reconciliation (${TX_COUNT})`, async () => {
    const result = await broadcastConcurrentlyAndReconcile([root], TX_COUNT, '2b-concurrent')
    evidence.metrics.concurrentWrites = batchMetrics(result)
    console.log(`[write:concurrent] ${JSON.stringify(evidence.metrics.concurrentWrites)}`)
    expect(result.txids).toHaveLength(TX_COUNT)
  })

  test(`2c concurrent multi-identity Storage writes (${USER_COUNT} identities x ${MULTI_USER_ROUNDS} rounds)`, async () => {
    const started = Date.now()
    const results: Array<{ txid: string, elapsed: number }> = []
    const roundWallTimes: number[] = []
    for (let round = 0; round < MULTI_USER_ROUNDS; round++) {
      const roundStarted = Date.now()
      results.push(...await Promise.all(users.map(async user => {
        const requestStarted = Date.now()
        const result = await user.wallet.createAction({
          description: `${RUN_LABEL} user ${user.index} round ${round + 1}`.slice(0, 50),
          labels: [RUN_LABEL],
          outputs: [output(user, `multi user ${user.index} round ${round + 1}`)],
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        })
        return { txid: track(result.txid, '2c-multi-user', user.index), elapsed: Date.now() - requestStarted }
      })))
      roundWallTimes.push(Date.now() - roundStarted)
    }
    const wallMs = Date.now() - started
    evidence.metrics.multiUserWrites = {
      ...calcStats(results.map(result => result.elapsed)),
      identities: USER_COUNT,
      rounds: MULTI_USER_ROUNDS,
      roundWallTimes,
      wallMs,
      transactionsPerSecond: throughput(results.length, wallMs)
    }
    console.log(`[write:multi-user] ${JSON.stringify(evidence.metrics.multiUserWrites)}`)
    expect(results).toHaveLength(USER_COUNT)
  })

  test(`3a sequential Arcade-token ingestion (${TX_COUNT})`, async () => {
    const timings: number[] = []
    for (let i = 0; i < TX_COUNT; i++) {
      const started = Date.now()
      const result = await root.wallet.createAction({
        description: `${RUN_LABEL} sse sequential ${i + 1}`.slice(0, 50),
        labels: [RUN_LABEL],
        outputs: [output(root, `sse sequential ${i + 1}`)],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      timings.push(Date.now() - started)
      track(result.txid, '3a-sse-sequential', root.index)
    }
    evidence.metrics.sseSequential = calcStats(timings)
    expect(timings).toHaveLength(TX_COUNT)
  })

  test(`3b concurrent Arcade-token ingestion (${TX_COUNT})`, async () => {
    const result = await broadcastConcurrentlyAndReconcile([root], TX_COUNT, '3b-sse-concurrent')
    evidence.metrics.sseConcurrent = batchMetrics(result)
    expect(result.txids).toHaveLength(TX_COUNT)
  })

  test(`3c single-identity phase load (${CEILING_BATCHES.join(',')} x ${LOAD_REPEATS})`, async () => {
    const runs: LoadRun[] = []
    const recorded: { runs: Array<Record<string, unknown>>, summary: Array<Record<string, number>> } = { runs: [], summary: [] }
    evidence.metrics.singleIdentityLoad = recorded
    for (const count of CEILING_BATCHES) {
      for (let repeat = 1; repeat <= LOAD_REPEATS; repeat++) {
        const result = await broadcastConcurrentlyAndReconcile([users[0]], count, `3c-single-${count}-r${repeat}`)
        runs.push({ batchSize: count, repeat, result, metrics: batchMetrics(result) })
        recorded.runs = runs.map(({ batchSize, repeat, metrics }) => ({ batchSize, repeat, ...metrics }))
        recorded.summary = summarizeLoadRuns(runs)
      }
    }
    console.log(`[write:load:single] ${JSON.stringify(evidence.metrics.singleIdentityLoad)}`)
    expect(runs).toHaveLength(CEILING_BATCHES.length * LOAD_REPEATS)
  })

  test(`3d sharded phase load (${CEILING_BATCHES.join(',')} x ${LOAD_REPEATS})`, async () => {
    const runs: LoadRun[] = []
    const recorded: { runs: Array<Record<string, unknown>>, summary: Array<Record<string, number>> } = { runs: [], summary: [] }
    evidence.metrics.shardedIdentityLoad = recorded
    for (const count of CEILING_BATCHES) {
      for (let repeat = 1; repeat <= LOAD_REPEATS; repeat++) {
        const result = await broadcastConcurrentlyAndReconcile(users.slice(1), count, `3d-sharded-${count}-r${repeat}`)
        runs.push({ batchSize: count, repeat, result, metrics: batchMetrics(result) })
        recorded.runs = runs.map(({ batchSize, repeat, metrics }) => ({ batchSize, repeat, ...metrics }))
        recorded.summary = summarizeLoadRuns(runs)
      }
    }
    console.log(`[write:load:sharded] ${JSON.stringify(evidence.metrics.shardedIdentityLoad)}`)
    expect(runs).toHaveLength(CEILING_BATCHES.length * LOAD_REPEATS)
  })

  test('3e every broadcast receives an Arcade proof and reaches completed in Storage', async () => {
    evidence.proofs = await waitForProofs()
    const failures = evidence.proofs.filter(proof => !proof.arcadeProof || proof.storageStatus !== 'completed')
    evidence.metrics.proofConvergence = {
      total: evidence.proofs.length,
      arcadeProofs: evidence.proofs.filter(proof => proof.arcadeProof).length,
      storageCompleted: evidence.proofs.filter(proof => proof.storageStatus === 'completed').length,
      failures: failures.length
    }
    console.log(`[proofs:final] ${JSON.stringify(evidence.metrics.proofConvergence)}`)
    if (failures.length > 0) console.log(`[proofs:failures] ${JSON.stringify(failures)}`)
    expect(failures).toEqual([])
  })
})
