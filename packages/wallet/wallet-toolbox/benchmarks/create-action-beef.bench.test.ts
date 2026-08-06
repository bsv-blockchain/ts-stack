import { Beef, MerklePath, Script, Telemetry, type TelemetryEvent, Transaction, Utils, Validation } from '@bsv/sdk'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { _tu, TestWalletNoSetup, TestWalletOnly } from '../test/utils/TestUtilsWalletStorage'
import { KnexSessionManager } from '../src/storage/remoting/KnexSessionManager'
import { StorageServer, WalletStorageServerOptions } from '../src/storage/remoting/StorageServer'
import { StorageKnex } from '../src/storage/StorageKnex'
import { managedChangeOutputFields } from '../src/storage/methods/managedChange'
import {
  TableOutput,
  TableOutputBasket,
  TableProvenTx,
  TableTransaction
} from '../src/storage/schema/tables'
import { ScriptTemplateBRC29 } from '../src/utility/ScriptTemplateBRC29'
import { BdkVerifier } from '@bsv/verifast'

interface Measurement {
  candidateCount: number
  selectedInputCount: number
  distinctSourceCount: number
  elapsedMs: number
  queryCount: number
  databaseTransactions: number
  databaseMs: number
  resultBeefBytes: number
  phaseMs?: Record<string, number>
}

interface MeasurementSummary {
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  p50DatabaseMs: number
  p95DatabaseMs: number
  maxQueryCount: number
  maxDatabaseTransactions: number
  phaseP50Ms: Record<string, number>
  phaseP95Ms: Record<string, number>
}

interface BenchmarkContext {
  ctx: TestWalletNoSetup
  basket: TableOutputBasket
  storageEvents: TelemetryEvent[]
}

interface QueryProbe {
  stop: () => { queryCount: number, databaseTransactions: number, databaseMs: number }
}

function makeSourceTransaction (
  index: number,
  satoshis: number,
  lockingScript: Script
): Transaction {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex(`04${index.toString(16).padStart(8, '0')}`),
    sequence: 0xffffffff
  })
  transaction.addOutput({ satoshis, lockingScript })
  return transaction
}

function makeBenchmarkMerklePaths (txids: string[], height: number, seed: number): MerklePath[] {
  const sharedLevels = Math.log2(txids.length)
  if (!Number.isInteger(sharedLevels)) throw new Error('benchmark proof group must be a power of two')
  const path = Array.from({ length: 24 }, (_, level) => {
    const siblingHash = (BigInt(seed + 1) * 10_000n + BigInt(level + 1))
      .toString(16)
      .padStart(64, '0')
      .slice(-64)
    if (level === 0) return txids.map((hash, offset) => ({ offset, hash, txid: true }))
    if (level < sharedLevels) return []
    return [{ offset: 1, hash: siblingHash }]
  })
  const compound = new MerklePath(height, path)
  return txids.map(txid => compound.extract([txid]))
}

async function createBenchmarkContext (): Promise<BenchmarkContext> {
  const databaseName = process.env.WALLET_TOOLBOX_BENCH_MYSQL_DATABASE ?? 'createActionBeefBench'
  const ctx = process.env.WALLET_TOOLBOX_BENCH_MYSQL === 'true'
    ? await _tu.createLegacyWalletMySQLCopy(databaseName, 'legacy')
    : await _tu.createLegacyWalletSQLiteCopy(databaseName, 'legacy')
  const storageEvents: TelemetryEvent[] = []
  Reflect.set(ctx.activeStorage, 'telemetry', new Telemetry({
    sink: { capture: event => storageEvents.push({ ...event }) }
  }))
  ctx.activeStorage.feeModel = { model: 'sat/kb', value: 100 }
  const basket = (await ctx.activeStorage.findOutputBaskets({
    partial: { userId: ctx.userId, name: 'default' }
  }))[0] as TableOutputBasket
  await ctx.activeStorage.updateOutputBasket(basket.basketId, {
    numberOfDesiredUTXOs: 0,
    minimumDesiredUTXOValue: 1
  })
  return { ctx, basket, storageEvents }
}

function collectPhaseDurations (events: TelemetryEvent[], firstEvent: number): Record<string, number> {
  const phaseMs: Record<string, number> = {}
  for (const event of events.slice(firstEvent)) {
    if (event.type !== 'span' || event.durationMs == null) continue
    const rpcMethod = event.attributes?.['rpc.method']
    const name = typeof rpcMethod === 'string' ? `${event.name}.${rpcMethod}` : event.name
    phaseMs[name] = (phaseMs[name] ?? 0) + event.durationMs
  }
  return phaseMs
}

async function replaceFundingCandidatesWithDistinctProvenSources (
  setup: BenchmarkContext,
  candidateCount: number,
  outputSatoshis: number,
  generation: number,
  signableManagedOutputs = false
): Promise<string[]> {
  const { ctx, basket } = setup
  const sourceTxids: string[] = []
  const changeKeys = ctx.wallet.getClientChangeKeyPair()
  const derivationPrefix = `beef-benchmark-prefix-${generation}`
  const prepared = Array.from({ length: candidateCount }, (_, index) => {
    const uniqueIndex = generation * candidateCount + index
    const derivationSuffix = `beef-benchmark-${uniqueIndex}`
    const lockingScript = signableManagedOutputs
      ? new ScriptTemplateBRC29({
        derivationPrefix,
        derivationSuffix,
        keyDeriver: ctx.keyDeriver
      }).lock(changeKeys.privateKey, changeKeys.publicKey)
      : Script.fromHex('51')
    const source = makeSourceTransaction(uniqueIndex, outputSatoshis, lockingScript)
    return {
      uniqueIndex,
      derivationSuffix,
      lockingScript,
      source,
      rawTx: source.toBinary(),
      txid: source.id('hex'),
      merklePath: undefined as MerklePath | undefined
    }
  })
  const proofGroupSize = 8
  for (let offset = 0; offset < prepared.length; offset += proofGroupSize) {
    const group = prepared.slice(offset, offset + proofGroupSize)
    const paths = makeBenchmarkMerklePaths(
      group.map(source => source.txid),
      800_000 + generation * Math.ceil(candidateCount / proofGroupSize) + offset / proofGroupSize,
      generation * candidateCount + offset
    )
    for (let index = 0; index < group.length; index++) group[index].merklePath = paths[index]
  }

  // Benchmark fixture setup is deliberately one transaction. In particular,
  // do not spend hundreds of PXC commits preparing an unmeasured sample.
  await ctx.activeStorage.transaction(async trx => {
    const existing = await ctx.activeStorage.findOutputs({
      partial: { userId: ctx.userId, basketId: basket.basketId, spendable: true },
      noScript: true,
      trx
    })
    for (const output of existing) {
      await ctx.activeStorage.updateOutput(output.outputId, { spendable: false }, trx)
    }

    for (const preparedSource of prepared) {
      const { derivationSuffix, lockingScript, source, rawTx, txid } = preparedSource
      const merklePath = preparedSource.merklePath!
      const now = new Date()
      const proven: TableProvenTx = {
        created_at: now,
        updated_at: now,
        provenTxId: 0,
        txid,
        height: merklePath.blockHeight,
        index: 0,
        merklePath: merklePath.toBinary(),
        rawTx,
        blockHash: txid,
        merkleRoot: merklePath.computeRoot(txid)
      }
      proven.provenTxId = await ctx.activeStorage.insertProvenTx(proven, trx)
      const transaction: TableTransaction = {
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: ctx.userId,
        provenTxId: proven.provenTxId,
        status: 'completed',
        reference: Utils.toBase64(Utils.toArray(txid, 'hex').slice(0, 12)),
        isOutgoing: true,
        satoshis: outputSatoshis,
        description: 'proof-bearing funding benchmark source',
        version: source.version,
        lockTime: source.lockTime,
        txid,
        rawTx
      }
      transaction.transactionId = await ctx.activeStorage.insertTransaction(transaction, trx)
      const output: TableOutput = {
        outputId: 0,
        userId: ctx.userId,
        transactionId: transaction.transactionId,
        basketId: basket.basketId,
        spendable: true,
        spentBy: undefined,
        satoshis: outputSatoshis,
        vout: 0,
        txid,
        lockingScript: lockingScript.toBinary(),
        scriptLength: lockingScript.length,
        derivationPrefix,
        derivationSuffix,
        outputDescription: 'proof-bearing funding candidate',
        ...managedChangeOutputFields,
        created_at: now,
        updated_at: now
      }
      await ctx.activeStorage.insertOutput(output, trx)
      sourceTxids.push(txid)
    }
  })
  return sourceTxids
}

function createActionArgs (satoshis = 150_000) {
  return Validation.validateCreateActionArgs({
    outputs: [{
      satoshis,
      lockingScript: '51',
      outputDescription: 'proof-bearing benchmark output'
    }],
    description: 'createAction proof-bearing fragmented funding benchmark',
    options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: false }
  })
}

function startQueryProbe (setup: BenchmarkContext): QueryProbe {
  let queryCount = 0
  let databaseTransactions = 0
  let databaseMs = 0
  const started = new Map<string, { at: number, operation: string }>()
  const countQuery = (query: { sql?: string, __knexQueryUid?: string }): void => {
    queryCount++
    if (/^begin\b/i.test(query.sql?.trim() ?? '')) databaseTransactions++
    if (query.__knexQueryUid != null) {
      const sql = query.sql?.trim().toLowerCase() ?? ''
      const table = /(?:from|into|update)\s+[`"]?([a-z_]+)/.exec(sql)?.[1] ?? 'transaction'
      const operation = `${sql.split(/\s+/, 1)[0] || 'unknown'} ${table}`
      started.set(query.__knexQueryUid, { at: performance.now(), operation })
    }
    if (process.env.WALLET_TOOLBOX_BENCH_QUERIES === 'true') {
      process.stdout.write(`${String(query.sql).replace(/\s+/g, ' ').trim()}\n`)
    }
  }
  const finishQuery = (_response: unknown, query: { __knexQueryUid?: string }): void => {
    const uid = query.__knexQueryUid
    if (uid == null) return
    const start = started.get(uid)
    if (start != null) {
      const elapsed = performance.now() - start.at
      databaseMs += elapsed
      if (process.env.WALLET_TOOLBOX_BENCH_QUERIES === 'true') {
        process.stdout.write(`${start.operation}: ${elapsed.toFixed(3)} ms\n`)
      }
    }
    started.delete(uid)
  }
  setup.ctx.activeStorage.knex.on('query', countQuery)
  setup.ctx.activeStorage.knex.on('query-response', finishQuery)
  return {
    stop: () => {
      setup.ctx.activeStorage.knex.off('query', countQuery)
      setup.ctx.activeStorage.knex.off('query-response', finishQuery)
      return { queryCount, databaseTransactions, databaseMs }
    }
  }
}

async function measureStorageCreateAction (
  setup: BenchmarkContext,
  candidateCount: number
): Promise<Measurement> {
  const firstEvent = setup.storageEvents.length
  const probe = startQueryProbe(setup)
  const start = performance.now()
  const result = await setup.ctx.activeStorage.createAction(
    { userId: setup.ctx.userId },
    createActionArgs()
  )
  const elapsedMs = performance.now() - start
  const query = probe.stop()
  return {
    candidateCount,
    selectedInputCount: result.inputs.length,
    distinctSourceCount: new Set(result.inputs.map(input => input.sourceTxid)).size,
    elapsedMs,
    ...query,
    resultBeefBytes: result.inputBeef?.length ?? 0,
    phaseMs: collectPhaseDurations(setup.storageEvents, firstEvent)
  }
}

async function createRemoteClient (
  setup: BenchmarkContext
): Promise<{
  client: TestWalletOnly
  server: StorageServer
  verifier: BdkVerifier
  verifyDigestBatch: jest.SpiedFunction<BdkVerifier['verifyDigestBatch']>
  events: TelemetryEvent[]
  serverEvents: TelemetryEvent[]
}> {
  const events: TelemetryEvent[] = []
  const serverEvents: TelemetryEvent[] = []
  const telemetry = { sink: { capture: (event: Readonly<TelemetryEvent>) => events.push({ ...event }) } }
  const serverTelemetry = {
    sink: { capture: (event: Readonly<TelemetryEvent>) => serverEvents.push({ ...event }) }
  }
  // Jest VM modules create a separate typed-array realm for worker replies;
  // use the same packed WASM batch lane without worker fan-out here.
  const verifier = new BdkVerifier({ batchWorkers: 1 })
  await verifier.preload()
  const verifyDigestBatch = jest.spyOn(verifier, 'verifyDigestBatch')
  const options: WalletStorageServerOptions = {
    port: 0,
    wallet: setup.ctx.wallet,
    monetize: false,
    logRpcRequests: false,
    sessionManager: new KnexSessionManager(setup.ctx.activeStorage.knex),
    adminIdentityKeys: [],
    telemetry: serverTelemetry,
    calculateRequestPrice: async () => 0
  }
  const server = new StorageServer(setup.ctx.activeStorage, options)
  server.start()
  if (!server.server.listening) await once(server.server, 'listening')
  const address = server.server.address()
  if (address == null || typeof address === 'string') throw new Error('benchmark storage server did not bind')
  const client = await _tu.createTestWalletWithStorageClient({
    rootKeyHex: setup.ctx.rootKey.toHex(),
    endpointUrl: `http://localhost:${address.port}`,
    chain: setup.ctx.chain,
    actionBatchMode: 'legacy',
    telemetry,
    scriptVerifier: verifier
  })
  await client.storage.getAuth(true)
  events.length = 0
  serverEvents.length = 0
  return { client, server, verifier, verifyDigestBatch, events, serverEvents }
}

async function measureRemoteWalletCreateAction (
  setup: BenchmarkContext,
  client: TestWalletOnly,
  events: TelemetryEvent[],
  serverEvents: TelemetryEvent[],
  candidateCount: number
): Promise<Measurement> {
  const firstEvent = events.length
  const firstServerEvent = serverEvents.length
  const firstStorageEvent = setup.storageEvents.length
  const probe = startQueryProbe(setup)
  const start = performance.now()
  const result = await client.wallet.createAction({
    outputs: [{
      satoshis: 150_000,
      lockingScript: '51',
      outputDescription: 'proof-bearing benchmark output'
    }],
    description: 'authenticated remote proof-bearing fragmented funding benchmark',
    options: { noSend: true, randomizeOutputs: false, returnTXIDOnly: false }
  })
  const elapsedMs = performance.now() - start
  const query = probe.stop()
  if (result.tx == null || result.txid == null) throw new Error('remote benchmark did not return an atomic BEEF')
  const resultBeef = Beef.fromBinary(result.tx)
  const transaction = resultBeef.findTxid(result.txid)?.tx
  if (transaction == null) throw new Error('remote benchmark result transaction is missing')
  const phaseMs = collectPhaseDurations(events, firstEvent)
  const serverPhaseMs = collectPhaseDurations(serverEvents, firstServerEvent)
  for (const [name, durationMs] of Object.entries(serverPhaseMs)) {
    phaseMs[`server.${name}`] = durationMs
  }
  const storagePhaseMs = collectPhaseDurations(setup.storageEvents, firstStorageEvent)
  for (const [name, durationMs] of Object.entries(storagePhaseMs)) {
    phaseMs[`server.storage.${name}`] = durationMs
  }
  return {
    candidateCount,
    selectedInputCount: transaction.inputs.length,
    distinctSourceCount: new Set(transaction.inputs.map(input => input.sourceTXID)).size,
    elapsedMs,
    ...query,
    resultBeefBytes: result.tx?.length ?? 0,
    phaseMs
  }
}

function percentile (values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)]
}

function summarize (measurements: Measurement[]): MeasurementSummary {
  const elapsed = measurements.map(measurement => measurement.elapsedMs)
  const database = measurements.map(measurement => measurement.databaseMs)
  const phaseNames = new Set(measurements.flatMap(measurement => Object.keys(measurement.phaseMs ?? {})))
  const phaseP50Ms: Record<string, number> = {}
  const phaseP95Ms: Record<string, number> = {}
  for (const phase of phaseNames) {
    const values = measurements.map(measurement => measurement.phaseMs?.[phase] ?? 0)
    phaseP50Ms[phase] = percentile(values, 0.5)
    phaseP95Ms[phase] = percentile(values, 0.95)
  }
  return {
    samples: measurements.length,
    p50Ms: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: Math.max(...elapsed),
    p50DatabaseMs: percentile(database, 0.5),
    p95DatabaseMs: percentile(database, 0.95),
    maxQueryCount: Math.max(...measurements.map(measurement => measurement.queryCount)),
    maxDatabaseTransactions: Math.max(...measurements.map(measurement => measurement.databaseTransactions)),
    phaseP50Ms,
    phaseP95Ms
  }
}

describe('createAction proof-bearing fragmented funding benchmark', () => {
  jest.setTimeout(600_000)

  test('builds deterministic same-root proof groups for benchmark fixtures', () => {
    const txids = ['01', '02', '03', '04'].map(prefix => prefix.padEnd(64, '0'))
    const paths = makeBenchmarkMerklePaths(txids, 900_000, 7)
    expect(paths).toHaveLength(txids.length)
    expect(new Set(paths.map((path, index) => path.computeRoot(txids[index]))).size).toBe(1)
  })

  const localTest = process.env.WALLET_TOOLBOX_BENCH_MYSQL === 'true' ? test.skip : test
  localTest('records complete createAction latency for many distinct proven sources', async () => {
    const setup = await createBenchmarkContext()
    try {
      await replaceFundingCandidatesWithDistinctProvenSources(setup, 178, 1_000, 0)
      const measurement = await measureStorageCreateAction(setup, 178)
      expect(measurement.selectedInputCount).toBeGreaterThan(100)
      expect(measurement.distinctSourceCount).toBe(measurement.selectedInputCount)
      expect(measurement.resultBeefBytes).toBeGreaterThan(0)
      expect(measurement.queryCount).toBeLessThanOrEqual(15)
      process.stdout.write(`${JSON.stringify({ measurement }, null, 2)}\n`)
    } finally {
      await setup.ctx.wallet.destroy()
    }
  })

  const existingDatabase = process.env.WALLET_TOOLBOX_BENCH_EXISTING_DATABASE === 'true'
  const pxcTest = process.env.WALLET_TOOLBOX_BENCH_MYSQL === 'true' && !existingDatabase ? test : test.skip
  pxcTest('holds the direct and authenticated remote p50/p95 latency gates on PXC', async () => {
    const setup = await createBenchmarkContext()
    const samples = Number(process.env.WALLET_TOOLBOX_BENCH_SAMPLES ?? 20)
    let remote: Awaited<ReturnType<typeof createRemoteClient>> | undefined
    try {
      const directMeasurements: Measurement[] = []
      for (let sample = 0; sample < samples; sample++) {
        await replaceFundingCandidatesWithDistinctProvenSources(setup, 178, 1_000, sample + 1)
        await new Promise(resolve => setTimeout(resolve, 1_250))
        directMeasurements.push(await measureStorageCreateAction(setup, 178))
      }

      remote = await createRemoteClient(setup)
      const remoteMeasurements: Measurement[] = []
      for (let sample = 0; sample < samples; sample++) {
        await replaceFundingCandidatesWithDistinctProvenSources(setup, 178, 1_000, sample + 1_000, true)
        await new Promise(resolve => setTimeout(resolve, 1_250))
        remoteMeasurements.push(await measureRemoteWalletCreateAction(
          setup,
          remote.client,
          remote.events,
          remote.serverEvents,
          178
        ))
      }

      const typicalRemoteMeasurements: Measurement[] = []
      for (let sample = 0; sample < samples; sample++) {
        await replaceFundingCandidatesWithDistinctProvenSources(setup, 8, 200_000, sample + 2_000, true)
        await new Promise(resolve => setTimeout(resolve, 1_250))
        typicalRemoteMeasurements.push(await measureRemoteWalletCreateAction(
          setup,
          remote.client,
          remote.events,
          remote.serverEvents,
          8
        ))
      }

      const direct = summarize(directMeasurements)
      const authenticatedRemote = summarize(remoteMeasurements)
      const typicalAuthenticatedRemote = summarize(typicalRemoteMeasurements)
      const digestVerdicts = (await Promise.all(
        remote.verifyDigestBatch.mock.results.map(async result => await result.value)
      )).flat()
      process.stdout.write(`${JSON.stringify({
        direct,
        authenticatedRemote,
        typicalAuthenticatedRemote,
        digestVerificationBatches: remote.verifyDigestBatch.mock.calls.length,
        digestVerificationCount: digestVerdicts.length,
        digestVerificationFailures: digestVerdicts.filter(valid => !valid).length
      }, null, 2)}\n`)
      expect(direct.p50Ms).toBeLessThan(150)
      expect(direct.p95Ms).toBeLessThan(500)
      expect(authenticatedRemote.p50Ms).toBeLessThan(450)
      expect(authenticatedRemote.p95Ms).toBeLessThan(500)
      expect(authenticatedRemote.maxQueryCount).toBeLessThanOrEqual(33)
      expect(typicalAuthenticatedRemote.p50Ms).toBeLessThan(100)
      expect(typicalAuthenticatedRemote.p95Ms).toBeLessThan(150)
      expect(remoteMeasurements.every(measurement => measurement.selectedInputCount === 153)).toBe(true)
      expect(remoteMeasurements.every(measurement => measurement.distinctSourceCount === 153)).toBe(true)
      expect(typicalRemoteMeasurements.every(measurement => measurement.selectedInputCount === 1)).toBe(true)
      expect(typicalRemoteMeasurements.every(measurement => measurement.distinctSourceCount === 1)).toBe(true)
      expect(remote.verifyDigestBatch).toHaveBeenCalledTimes(samples * 2)
      expect(digestVerdicts).toHaveLength(samples * 154)
      expect(digestVerdicts).not.toContain(false)
    } finally {
      if (remote != null) {
        await remote.client.wallet.destroy()
        await remote.server.close()
        remote.verifier.dispose()
      }
      await setup.ctx.wallet.destroy()
    }
  })

  const existingDatabaseTest = existingDatabase ? test : test.skip
  existingDatabaseTest('measures against an isolated production-shaped database copy', async () => {
    const databaseName = process.env.WALLET_TOOLBOX_BENCH_MYSQL_DATABASE
    if (databaseName == null || databaseName.length === 0) throw new Error('benchmark database name is required')
    const events: TelemetryEvent[] = []
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      knex: _tu.createLocalMySQL(databaseName),
      chain: 'main',
      telemetry: { sink: { capture: event => events.push({ ...event }) } }
    })
    try {
      await storage.makeAvailable()
      storage.feeModel = { model: 'sat/kb', value: 100 }
      const user = await storage.knex('users').select('userId').first()
      const basket = await storage.knex('output_baskets').select('basketId').where({ name: 'default' }).first()
      if (user?.userId == null || basket?.basketId == null) throw new Error('production-shaped fixture is incomplete')
      const samples = Number(process.env.WALLET_TOOLBOX_BENCH_EXISTING_SAMPLES ?? 5)
      const measurements: Measurement[] = []
      for (let sample = 0; sample < samples; sample++) {
        const available = await storage.findAvailableManagedChangeInputCandidates(user.userId, basket.basketId)
        // Keep enough headroom for a large-input transaction fee while still
        // forcing the fragmented cohort to contribute well over 100 inputs.
        const target = Math.max(1, Math.floor(available.reduce((sum, output) => sum + output.satoshis, 0) * 0.7))
        const setup = { ctx: { activeStorage: storage, userId: user.userId } } as unknown as BenchmarkContext
        events.length = 0
        const probe = startQueryProbe(setup)
        const start = performance.now()
        const result = await storage.createAction({ userId: user.userId }, createActionArgs(target))
        const elapsedMs = performance.now() - start
        const query = probe.stop()
        const phaseMs: Record<string, number> = {}
        for (const event of events) {
          if (event.type !== 'span' || event.durationMs == null) continue
          phaseMs[event.name] = (phaseMs[event.name] ?? 0) + event.durationMs
        }
        measurements.push({
          candidateCount: available.length,
          selectedInputCount: result.inputs.length,
          distinctSourceCount: new Set(result.inputs.map(input => input.sourceTxid)).size,
          elapsedMs,
          ...query,
          resultBeefBytes: result.inputBeef?.length ?? 0,
          phaseMs
        })
        await expect(storage.abortAction(
          { userId: user.userId },
          { reference: result.reference }
        )).resolves.toEqual({ aborted: true })
      }
      const summary = summarize(measurements)
      process.stdout.write(`${JSON.stringify({
        productionShaped: summary,
        minSelectedInputCount: Math.min(...measurements.map(measurement => measurement.selectedInputCount)),
        minDistinctSourceCount: Math.min(...measurements.map(measurement => measurement.distinctSourceCount))
      }, null, 2)}\n`)
      expect(measurements.every(measurement => measurement.candidateCount > 100)).toBe(true)
      expect(measurements.every(measurement => measurement.selectedInputCount > 100)).toBe(true)
      expect(measurements.every(measurement => measurement.resultBeefBytes > 0)).toBe(true)
      expect(summary.maxQueryCount).toBeLessThanOrEqual(11)
      expect(summary.p50Ms).toBeLessThan(100)
      expect(summary.p95Ms).toBeLessThan(500)
    } finally {
      await storage.destroy()
    }
  })
})
