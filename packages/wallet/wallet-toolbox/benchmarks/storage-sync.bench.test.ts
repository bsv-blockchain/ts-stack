import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { _tu, TestWalletNoSetup, TestWalletOnly } from '../test/utils/TestUtilsWalletStorage'
import { RequestSyncChunkArgs } from '../src/sdk/WalletStorage.interfaces'
import { StorageClient } from '../src/storage/remoting/StorageClient'
import { KnexSessionManager } from '../src/storage/remoting/KnexSessionManager'
import { StorageServer, WalletStorageServerOptions } from '../src/storage/remoting/StorageServer'
import { TableTransaction } from '../src/storage/schema/tables'

const entityNames = [
  'provenTx',
  'outputBasket',
  'outputTag',
  'txLabel',
  'transaction',
  'output',
  'txLabelMap',
  'outputTagMap',
  'certificate',
  'certificateField',
  'commission',
  'provenTxReq'
]

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]
}

async function seedSyncFixture(ctx: TestWalletNoSetup, recordCount: number): Promise<Date> {
  const since = new Date()
  await new Promise(resolve => setTimeout(resolve, 10))
  await ctx.activeStorage.transaction(async trx => {
    for (let index = 0; index < recordCount; index++) {
      const txid = (index + 1).toString(16).padStart(64, '0')
      const provenTx = await _tu.insertTestProvenTx(ctx.activeStorage, txid, trx)
      const now = new Date()
      const transaction: TableTransaction = {
        created_at: now,
        updated_at: now,
        transactionId: 0,
        userId: ctx.userId,
        provenTxId: provenTx.provenTxId,
        status: 'completed',
        reference: `sync-benchmark-${index}`,
        isOutgoing: true,
        satoshis: index + 1,
        description: 'candidate-provider sync benchmark',
        txid
      }
      await ctx.activeStorage.insertTransaction(transaction, trx)
    }
  })
  return since
}

async function createCandidateProvider(): Promise<{
  ctx: TestWalletNoSetup
  client: TestWalletOnly
  server: StorageServer
}> {
  const databaseName = process.env.WALLET_TOOLBOX_BENCH_MYSQL_DATABASE ?? 'storageSyncBench'
  const ctx =
    process.env.WALLET_TOOLBOX_BENCH_MYSQL === 'true'
      ? await _tu.createLegacyWalletMySQLCopy(databaseName)
      : await _tu.createLegacyWalletSQLiteCopy(databaseName)
  const options: WalletStorageServerOptions = {
    port: 0,
    wallet: ctx.wallet,
    monetize: false,
    logRpcRequests: false,
    sessionManager: new KnexSessionManager(ctx.activeStorage.knex),
    adminIdentityKeys: [],
    calculateRequestPrice: async () => 0
  }
  const server = new StorageServer(ctx.activeStorage, options)
  server.start()
  if (!server.server.listening) await once(server.server, 'listening')
  const address = server.server.address()
  if (address == null || typeof address === 'string') throw new Error('candidate provider did not bind')
  const client = await _tu.createTestWalletWithStorageClient({
    rootKeyHex: ctx.rootKey.toHex(),
    endpointUrl: `http://localhost:${address.port}`,
    chain: ctx.chain
  })
  await client.storage.getAuth(true)
  return { ctx, client, server }
}

describe('candidate-provider wallet sync benchmark', () => {
  jest.setTimeout(600_000)

  test('measures an authenticated 250-record page over HTTP', async () => {
    const recordCount = Number(process.env.WALLET_TOOLBOX_BENCH_SYNC_RECORDS ?? 250)
    const samples = Number(process.env.WALLET_TOOLBOX_BENCH_SAMPLES ?? 7)
    const candidate = await createCandidateProvider()
    try {
      const since = await seedSyncFixture(candidate.ctx, recordCount)
      const storageClient = candidate.client.storage.getActive() as StorageClient
      const sourceReads = jest.spyOn(candidate.ctx.activeStorage, 'getProvenTxsForUser')
      const elapsedMs: number[] = []
      const sourceQueryLimits: number[][] = []
      let totalRecords = 0
      for (let sample = 0; sample < samples; sample++) {
        const firstRead = sourceReads.mock.calls.length
        const args: RequestSyncChunkArgs = {
          identityKey: candidate.ctx.identityKey,
          fromStorageIdentityKey: candidate.ctx.activeStorage.getSettings().storageIdentityKey,
          toStorageIdentityKey: '33'.repeat(32),
          since,
          maxItems: recordCount,
          maxRoughSize: 8 * 1024 * 1024,
          includeTotals: true,
          offsets: entityNames.map(name => ({ name, offset: 0 }))
        }
        const started = performance.now()
        const chunk = await storageClient.getSyncChunk(args)
        elapsedMs.push(performance.now() - started)
        expect(chunk.provenTxs).toHaveLength(recordCount)
        expect(chunk.totals).toBeDefined()
        totalRecords = chunk.totals!.totalRecords
        sourceQueryLimits.push(sourceReads.mock.calls.slice(firstRead).map(call => call[0].paged?.limit ?? 0))
      }

      const result = {
        provider: process.env.WALLET_TOOLBOX_BENCH_MYSQL === 'true' ? 'MySQL 8.4 over HTTP' : 'SQLite over HTTP',
        fixture: { provenTxs: recordCount, transactions: recordCount, totalRecords },
        samples,
        p50Ms: percentile(elapsedMs, 0.5),
        p95Ms: percentile(elapsedMs, 0.95),
        maxMs: Math.max(...elapsedMs),
        sourceQueriesPerPage: sourceQueryLimits.map(limits => limits.length),
        sourceQueryLimits
      }
      process.stdout.write(`${JSON.stringify({ candidateProviderSync: result }, null, 2)}\n`)
      expect(sourceQueryLimits.every(limits => limits.length === 3)).toBe(true)
      expect(sourceQueryLimits.every(limits => limits.join(',') === '10,80,160')).toBe(true)
    } finally {
      await candidate.client.wallet.destroy()
      await candidate.server.close()
      await candidate.ctx.wallet.destroy()
    }
  })
})
