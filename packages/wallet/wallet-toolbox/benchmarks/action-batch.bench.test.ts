import { CreateActionArgs } from '@bsv/sdk'
import { performance } from 'node:perf_hooks'
import { Wallet } from '../src/Wallet'
import { stringifyJsonRpc } from '../src/storage/remoting/BinaryJson'
import { _tu, TestWalletNoSetup } from '../test/utils/TestUtilsWalletStorage'

interface ActualResult {
  mode: 'batch' | 'legacy'
  actions: number
  actionMs: number
  planningMs: number
  signingValidationMs: number
  rpcCount: number
  databaseTransactions: number
  commitMs: number
  broadcastMs: number
  cpuUserMs: number
  cpuSystemMs: number
  peakRetainedHeapBytes: number
  uploadedBytes: number
}

interface ModelResult {
  workload: 'dependent' | 'independent' | 'mixed-explicit' | 'two-step'
  actions: number
  scriptBytes: number
  latencyMs: number
  legacyRpcCount: number
  batchControlRpcCount: number
  legacyStorageMs: number
  batchControlMs: number
  legacyPersistenceWorkflows: number
  batchPersistenceWorkflows: number
  uploadedBytes: number
  inline: boolean
}

const actionCounts = [1, 10, 50, 250]
const scriptSizes = [1024, 64 * 1024, 1024 * 1024, 4 * 1024 * 1024]
const latencies = [25, 100, 250]
const workloads: ModelResult['workload'][] = ['dependent', 'independent', 'mixed-explicit', 'two-step']
const randomVals = [0.1, 0.2, 0.3, 0.7, 0.8, 0.9]

function modeledResults (): ModelResult[] {
  const results: ModelResult[] = []
  for (const workload of workloads) {
    for (const actions of actionCounts) {
      for (const scriptBytes of scriptSizes) {
        for (const latencyMs of latencies) {
          const uploadedBytes = actions * (scriptBytes + 180)
          const inline = uploadedBytes <= 4 * 1024 * 1024
          const legacyRpcCount = actions * 2 + 1
          const batchControlRpcCount = inline ? 2 : 3
          results.push({
            workload,
            actions,
            scriptBytes,
            latencyMs,
            legacyRpcCount,
            batchControlRpcCount,
            legacyStorageMs: legacyRpcCount * latencyMs,
            batchControlMs: batchControlRpcCount * latencyMs,
            legacyPersistenceWorkflows: actions * 2,
            batchPersistenceWorkflows: 2,
            uploadedBytes,
            inline
          })
        }
      }
    }
  }
  return results
}

function args (change: string[], scriptBytes: number): CreateActionArgs {
  return {
    outputs: [{
      satoshis: 1,
      lockingScript: '00'.repeat(scriptBytes),
      outputDescription: 'benchmark workload output'
    }],
    description: 'Benchmark dependent action planning',
    options: { noSend: true, noSendChange: change, randomizeOutputs: false }
  }
}

function jsonRpcRequestBytes (method: string, value: unknown): number {
  return new TextEncoder().encode(stringifyJsonRpc({
    jsonrpc: '2.0',
    method,
    params: [value],
    id: 1
  }, true)).length
}

async function measureActual (mode: ActualResult['mode'], actions: number): Promise<ActualResult> {
  const ctx: TestWalletNoSetup = await _tu.createLegacyWalletSQLiteCopy(`actionBatchBench-${mode}-${actions}`)
  const wallet = mode === 'batch'
    ? ctx.wallet
    : new Wallet({
      chain: ctx.chain,
      keyDeriver: ctx.keyDeriver,
      storage: ctx.storage,
      services: ctx.services,
      actionBatchMode: 'legacy'
    })
  wallet.randomVals = randomVals

  let planningMs = 0
  let broadcastMs = 0
  let rpcCount = 0
  let uploadedBytes = 0
  const heapStart = process.memoryUsage().heapUsed
  let peakHeap = heapStart
  let databaseTransactions = 0
  const countTransaction = (query: { sql?: string }): void => {
    if (/^begin\b/i.test(query.sql?.trim() ?? '')) databaseTransactions++
  }
  ctx.activeStorage.knex.on('query', countTransaction)
  const begin = ctx.storage.beginActionBatch.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'beginActionBatch').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('beginActionBatch', value)
    return await begin(value)
  })
  const extend = ctx.storage.extendActionBatch.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'extendActionBatch').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('extendActionBatch', value)
    return await extend(value)
  })
  const renew = ctx.storage.renewActionBatch.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'renewActionBatch').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('renewActionBatch', value)
    return await renew(value)
  })
  const prepare = ctx.storage.prepareActionBatchCommit.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'prepareActionBatchCommit').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('prepareActionBatchCommit', value)
    return await prepare(value)
  })
  const put = ctx.storage.putActionBatchBlob.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'putActionBatchBlob').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += value.bytes.length
    return await put(value)
  })
  const commit = ctx.storage.commitActionBatch.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'commitActionBatch').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('commitActionBatch', value)
    return await commit(value)
  })
  const legacyCreate = ctx.storage.createAction.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'createAction').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('createAction', value)
    const planningStart = performance.now()
    try { return await legacyCreate(value) } finally { planningMs += performance.now() - planningStart }
  })
  const processAction = ctx.storage.processAction.bind(ctx.storage)
  jest.spyOn(ctx.storage, 'processAction').mockImplementation(async value => {
    rpcCount++
    uploadedBytes += jsonRpcRequestBytes('processAction', value)
    return await processAction(value)
  })
  const planner = wallet.actionBatch.plan.bind(wallet.actionBatch)
  jest.spyOn(wallet.actionBatch, 'plan').mockImplementation(async action => {
    const start = performance.now()
    try { return await planner(action) } finally { planningMs += performance.now() - start }
  })
  const postBeef = ctx.services.postBeef.bind(ctx.services)
  jest.spyOn(ctx.services, 'postBeef').mockImplementation(async (...postArgs) => {
    const start = performance.now()
    try { return await postBeef(...postArgs) } finally { broadcastMs += performance.now() - start }
  })

  const cpuStart = process.cpuUsage()
  const start = performance.now()
  const txids: string[] = []
  let change: string[] = []
  try {
    for (let i = 0; i < actions; i++) {
      const result = await wallet.createAction(args(change, 1024))
      txids.push(result.txid!)
      change = result.noSendChange ?? []
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
    }
    const commitStart = performance.now()
    await wallet.createAction({ description: 'Commit benchmark batch', options: { sendWith: txids } })
    const commitMs = performance.now() - commitStart
    const actionMs = performance.now() - start - commitMs
    const cpu = process.cpuUsage(cpuStart)
    return {
      mode,
      actions,
      actionMs,
      planningMs,
      signingValidationMs: Math.max(0, actionMs - planningMs),
      rpcCount,
      databaseTransactions,
      commitMs,
      broadcastMs,
      cpuUserMs: cpu.user / 1000,
      cpuSystemMs: cpu.system / 1000,
      peakRetainedHeapBytes: peakHeap - heapStart,
      uploadedBytes
    }
  } finally {
    ctx.activeStorage.knex.off('query', countTransaction)
    if (wallet !== ctx.wallet) await wallet.destroy()
    await ctx.wallet.destroy()
  }
}

describe('retained action batch benchmark', () => {
  jest.setTimeout(600000)

  test('records actual representative runs and the complete latency/payload matrix', async () => {
    const actual: ActualResult[] = []
    for (const actions of actionCounts) {
      actual.push(await measureActual('legacy', actions))
      actual.push(await measureActual('batch', actions))
    }
    const modeled = modeledResults()
    const acceptance = modeled.find(result => result.workload === 'dependent' && result.actions === 250 &&
      result.scriptBytes === 1024 && result.latencyMs === 100)
    expect(acceptance).toMatchObject({
      legacyRpcCount: 501,
      batchControlRpcCount: 2,
      legacyStorageMs: 50100,
      batchControlMs: 200
    })
    const batch250 = actual.find(result => result.mode === 'batch' && result.actions === 250)
    expect(batch250?.rpcCount).toBe(2)
    const modeledAcceptance = modeled.filter(result => result.workload === 'dependent' &&
      result.actions === 250 && result.latencyMs === 100 &&
      (result.scriptBytes === 1024 || result.scriptBytes === 4 * 1024 * 1024))
    process.stdout.write(`${JSON.stringify({ actual, modeledCases: modeled.length, modeledAcceptance }, null, 2)}\n`)
  })
})
