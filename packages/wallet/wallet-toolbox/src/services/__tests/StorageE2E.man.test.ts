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

const ALLOW_MAINNET = process.env.STORAGE_E2E_ALLOW_MAINNET === 'true'
const ROOT_KEY_HEX = process.env.STORAGE_E2E_ROOT_KEY ?? ''
const TARGET_URL = (process.env.STORAGE_E2E_TARGET_URL ?? 'https://storage.babbage.systems').replace(/\/$/, '')
const ARCADE_URL = (process.env.STORAGE_E2E_ARCADE_URL ?? 'https://arcade-v2-us-1.bsvblockchain.tech').replace(/\/$/, '')
const ARCADE_TOKEN = process.env.STORAGE_E2E_ARCADE_TOKEN ?? ''
const USER_COUNT = integerEnv('STORAGE_E2E_USER_COUNT', 3, 2, 20)
const TX_COUNT = integerEnv('STORAGE_E2E_TX_COUNT', 3, 1, 100)
const OUTPUT_SATS = integerEnv('STORAGE_E2E_OUTPUT_SATS', 100, 1, 100000)
const USER_FUNDING_SATS = integerEnv('STORAGE_E2E_USER_FUNDING_SATS', 2000, OUTPUT_SATS + 500, 1000000)
const PROOF_TIMEOUT_MS = integerEnv('STORAGE_E2E_PROOF_TIMEOUT_MS', 45 * 60 * 1000, 60 * 1000, 4 * 60 * 60 * 1000)
const PROOF_POLL_MS = integerEnv('STORAGE_E2E_PROOF_POLL_MS', 30 * 1000, 5000, 5 * 60 * 1000)
const RAW_REQUEST_COUNT = integerEnv('STORAGE_E2E_READ_COUNT', 30, 1, 1000)
const EVIDENCE_FILE = process.env.STORAGE_E2E_EVIDENCE_FILE
const RUN_ID = process.env.STORAGE_E2E_RUN_ID ?? new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
const RUN_LABEL = `storage-e2e-${RUN_ID}`
const RUN_BASKET = `storage-e2e-${RUN_ID}`
const CEILING_BATCHES = parseBatches(process.env.STORAGE_E2E_CEILING_BATCHES ?? '2,4,8')

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

interface ProofObservation {
  txid: string
  test: string
  walletIndex: number
  arcadeStatus?: string
  blockHeight?: number
  arcadeProof: boolean
  storageStatus?: string
  completedAt?: string
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
    txCount: TX_COUNT,
    outputSats: OUTPUT_SATS,
    userFundingSats: USER_FUNDING_SATS,
    ceilingBatches: CEILING_BATCHES
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

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function deriveUserKey (userIndex: number): PrivateKey {
  const rootKey = PrivateKey.fromHex(ROOT_KEY_HEX)
  return new CachedKeyDeriver(rootKey).derivePrivateKey(
    [2, 'storage e2e user'],
    String(userIndex),
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
  const balances = await Promise.all(users.map(async user => ({ user, balance: await user.wallet.balance() })))
  const recipients = balances.filter(({ balance }) => balance < USER_FUNDING_SATS)
  if (recipients.length === 0) {
    console.log(`[setup] all ${users.length} derived users already have at least ${USER_FUNDING_SATS} sats`)
    return undefined
  }

  const payments = recipients.map(({ user }) => {
    const { wallet } = user
    const template = new ScriptTemplateBRC29({
      derivationPrefix: randomBytesBase64(8),
      derivationSuffix: randomBytesBase64(8),
      keyDeriver: root.wallet.keyDeriver
    })
    return {
      template,
      lockingScript: template.lock(ROOT_KEY_HEX, wallet.identityKey).toHex()
    }
  })

  const created = await root.wallet.createAction({
    description: `${RUN_LABEL} fund users`.slice(0, 50),
    labels: [RUN_LABEL],
    outputs: payments.map((payment, index) => ({
      lockingScript: payment.lockingScript,
      satoshis: USER_FUNDING_SATS,
      outputDescription: `fund e2e user ${index}`,
      tags: [RUN_LABEL]
    })),
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  const txid = track(created.txid, 'setup-user-funding', root.index)
  if (created.tx == null) throw new Error('User funding did not return Atomic BEEF')
  const fundingBeef = created.tx

  await Promise.all(recipients.map(async ({ user: { wallet } }, index) => {
    const payment = payments[index]
    const derivationPrefix = payment.template.params.derivationPrefix
    const derivationSuffix = payment.template.params.derivationSuffix
    if (derivationPrefix == null || derivationSuffix == null) throw new Error(`Missing BRC-29 derivation for user ${index}`)
    await wallet.internalizeAction({
      tx: fundingBeef,
      outputs: [{
        outputIndex: index,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix,
          derivationSuffix,
          senderIdentityKey: root.wallet.identityKey
        }
      }],
      description: `${RUN_LABEL} funding`.slice(0, 50),
      labels: [RUN_LABEL]
    })
  }))
  return txid
}

async function createNoSendBatch (wallet: TestWallet, count: number, test: string): Promise<Array<{ txid: string, beef: Beef }>> {
  const created: Array<{ txid: string, beef: Beef }> = []
  for (let i = 0; i < count; i++) {
    const result = await wallet.wallet.createAction({
      description: `${RUN_LABEL} ${test} ${i + 1}`.slice(0, 50),
      labels: [RUN_LABEL],
      outputs: [output(wallet, `${test} ${i + 1}`)],
      options: { noSend: true, randomizeOutputs: false, acceptDelayedBroadcast: false }
    })
    if (result.tx == null) throw new Error(`${test} transaction ${i + 1} did not return Atomic BEEF`)
    created.push({ txid: track(result.txid, test, wallet.index), beef: Beef.fromBinary(result.tx) })
  }
  return created
}

async function broadcastConcurrentlyAndReconcile (
  wallet: TestWallet,
  count: number,
  test: string
): Promise<{ txids: string[], wallMs: number, timings: number[] }> {
  const created = await createNoSendBatch(wallet, count, test)
  const started = Date.now()
  const results = await Promise.all(created.map(async ({ txid, beef }) => {
    const requestStarted = Date.now()
    const responses = await wallet.services.postBeef(beef, [txid])
    const arcade = responses.find(response => response.name === 'arcade')
    return {
      txid,
      elapsed: Date.now() - requestStarted,
      ok: arcade?.status === 'success' && arcade.txidResults.some(result => result.txid === txid && result.status === 'success')
    }
  }))
  const wallMs = Date.now() - started
  const failed = results.filter(result => !result.ok)
  if (failed.length > 0) throw new Error(`${test} Arcade failures: ${failed.map(result => result.txid).join(', ')}`)

  const reconciliation = await wallet.wallet.createAction({
    description: `${RUN_LABEL} reconcile ${test}`.slice(0, 50),
    options: { sendWith: created.map(item => item.txid), acceptDelayedBroadcast: false }
  })
  const sendFailures = reconciliation.sendWithResults?.filter(result => result.status !== 'unproven') ?? []
  if (sendFailures.length > 0) throw new Error(`${test} Storage reconciliation failures: ${JSON.stringify(sendFailures)}`)
  return { txids: created.map(item => item.txid), wallMs, timings: results.map(result => result.elapsed) }
}

async function actionStatus (tracked: TrackedTransaction): Promise<string | undefined> {
  const wallet = tracked.walletIndex === root.index ? root : users.find(user => user.index === tracked.walletIndex)
  if (wallet == null) return undefined
  const result = await wallet.wallet.listActions({ labels: [RUN_LABEL], limit: 1000 })
  return result.actions.find(action => action.txid === tracked.txid)?.status
}

async function waitForProofs (): Promise<ProofObservation[]> {
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
    for (const txid of [...pending]) {
      const transaction = evidence.transactions.find(item => item.txid === txid)
      const observation = observations.get(txid)
      if (transaction == null || observation == null) throw new Error(`Missing evidence for ${txid}`)
      try {
        const arcadeService = root.services.arcade
        if (arcadeService == null) throw new Error('Arcade is not configured')
        const arcade = await arcadeService.getTxData(txid)
        observation.arcadeStatus = arcade.txStatus
        observation.blockHeight = arcade.blockHeight === 0 ? undefined : arcade.blockHeight
        observation.arcadeProof = (arcade.txStatus === 'MINED' || arcade.txStatus === 'IMMUTABLE') && arcade.merklePath != null && arcade.merklePath !== ''
      } catch (error: unknown) {
        observation.error = `Arcade: ${errorMessage(error)}`
      }
      try {
        observation.storageStatus = await actionStatus(transaction)
      } catch (error: unknown) {
        observation.error = `Storage: ${errorMessage(error)}`
      }
      if (observation.arcadeProof && observation.storageStatus === 'completed') {
        observation.completedAt = new Date().toISOString()
        pending.delete(txid)
      }
    }

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

    const balance = await root.wallet.balance()
    const estimatedMinimum = USER_COUNT * USER_FUNDING_SATS + (TX_COUNT * 5 + CEILING_BATCHES.reduce((sum, n) => sum + n, 0)) * (OUTPUT_SATS + 500)
    console.log(`[setup] run=${RUN_ID} target=${TARGET_URL} rootBalance=${balance} estimatedMinimum=${estimatedMinimum}`)
    expect(balance).toBeGreaterThan(estimatedMinimum)
    await fundUsers()
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
    const result = await broadcastConcurrentlyAndReconcile(root, TX_COUNT, '2b-concurrent')
    evidence.metrics.concurrentWrites = {
      ...calcStats(result.timings),
      wallMs: result.wallMs,
      transactionsPerSecond: throughput(result.txids.length, result.wallMs)
    }
    console.log(`[write:concurrent] ${JSON.stringify(evidence.metrics.concurrentWrites)}`)
    expect(result.txids).toHaveLength(TX_COUNT)
  })

  test(`2c concurrent multi-identity Storage writes (${USER_COUNT})`, async () => {
    const started = Date.now()
    const results = await Promise.all(users.map(async user => {
      const requestStarted = Date.now()
      const result = await user.wallet.createAction({
        description: `${RUN_LABEL} user ${user.index}`.slice(0, 50),
        labels: [RUN_LABEL],
        outputs: [output(user, `multi user ${user.index}`)],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return { txid: track(result.txid, '2c-multi-user', user.index), elapsed: Date.now() - requestStarted }
    }))
    const wallMs = Date.now() - started
    evidence.metrics.multiUserWrites = {
      ...calcStats(results.map(result => result.elapsed)),
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
    const result = await broadcastConcurrentlyAndReconcile(root, TX_COUNT, '3b-sse-concurrent')
    evidence.metrics.sseConcurrent = {
      ...calcStats(result.timings),
      wallMs: result.wallMs,
      transactionsPerSecond: throughput(result.txids.length, result.wallMs)
    }
    expect(result.txids).toHaveLength(TX_COUNT)
  })

  test(`3c bounded concurrent ceiling batches (${CEILING_BATCHES.join(',')})`, async () => {
    const batches: Array<Record<string, number>> = []
    for (const count of CEILING_BATCHES) {
      const result = await broadcastConcurrentlyAndReconcile(root, count, `3c-ceiling-${count}`)
      batches.push({ count, wallMs: result.wallMs, transactionsPerSecond: throughput(count, result.wallMs), p95: calcStats(result.timings).p95 })
    }
    evidence.metrics.ceilingBatches = batches
    console.log(`[write:ceiling] ${JSON.stringify(batches)}`)
    expect(batches).toHaveLength(CEILING_BATCHES.length)
  })

  test('3d every broadcast receives an Arcade proof and reaches completed in Storage', async () => {
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
