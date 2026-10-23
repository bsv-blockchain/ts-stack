import { createServer, ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { Monitor, MonitorOptions } from '../../../../monitor/Monitor'
import { TaskReorg } from '../../../../monitor/tasks/TaskReorg'
import { GoChaintracksServiceClient } from '../GoChaintracksServiceClient'
import { BlockHeader } from '../Api/BlockHeaderApi'
import { blockHash, genesisHeader, validateHeaderProofOfWork } from '../util/blockHeaderUtilities'

function mine(parent: BlockHeader, branch: number): BlockHeader {
  const header = {
    ...parent,
    height: parent.height + 1,
    previousHash: parent.hash,
    merkleRoot: branch.toString(16).padStart(64, '0'),
    time: parent.time + 1,
    nonce: 0
  }
  for (let nonce = 0; nonce < 1000; nonce++) {
    header.nonce = nonce
    header.hash = blockHash(header)
    try {
      validateHeaderProofOfWork(header, 'regtest')
      return header
    } catch {
      // Regtest's easy target requires only a few attempts for these fixed fixtures.
    }
  }
  throw new Error('fixture mining exceeded its bounded attempts')
}

// Contract: go-chaintracks v1.4.5 chaintracks/types.go and chainmanager/sync.go,
// with embedded go-sdk v1.7.2 block/header.go JSON fields. These are genuine
// divergent, linked, PoW-valid regtest branches; no live node is required.
test('local Go-shaped HTTP/SSE reorg invalidates prepared proofs and schedules each orphan for repair', async () => {
  const ancestor = genesisHeader('regtest')
  const parent = mine(ancestor, 1)
  const oldTip = mine(parent, 2)
  const newTip = mine(mine(mine(ancestor, 3), 4), 5)
  const orphaned = [oldTip, parent]
  const requests: string[] = []
  const streams = new Set<ServerResponse>()
  let reorgStream!: ServerResponse
  let onReorgStream!: (response: ServerResponse) => void
  const streamReady = new Promise<void>(resolve => {
    const serverHandler = (response: ServerResponse) => {
      reorgStream = response
      resolve()
    }
    onReorgStream = serverHandler
  })
  const server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push(path)
    if (path.endsWith('/stream')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.flushHeaders()
      streams.add(response)
      response.on('close', () => streams.delete(response))
      if (path.endsWith('/reorg/stream')) onReorgStream(response)
      return
    }
    if (path === '/v2/network') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify('regtest'))
      return
    }
    const header = orphaned.find(item => path === `/v2/header/hash/${item.hash}`)
    response.writeHead(header == null ? 404 : 200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(header)) // Go endpoint returns the raw header.
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = new GoChaintracksServiceClient(
    'regtest',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2`
  )
  const invalidatePreparedBeefsForReorg = jest.fn(async () => {})
  const reproveHeader = jest.fn(async (_hash: string) => ({ log: 'repaired\n', unavailable: [], unchanged: [] }))
  const monitor = new Monitor({
    chain: 'regtest',
    services: { chain: 'regtest' },
    chaintracks: client,
    chaintracksWithEvents: client,
    storage: { invalidatePreparedBeefsForReorg, reproveHeader },
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 0,
    unprovenAttemptsLimitTest: 0,
    unprovenAttemptsLimitMain: 0,
    maxRebroadcastAttempts: 0
  } as unknown as MonitorOptions)
  const delivered = new Promise<void>(resolve => {
    const process = monitor.processReorg.bind(monitor)
    jest.spyOn(monitor, 'processReorg').mockImplementation((...args) => {
      process(...args)
      resolve()
    })
  })
  try {
    await monitor.ready
    await streamReady
    reorgStream.write(
      `data: ${JSON.stringify({ depth: 2, commonAncestor: ancestor, newTip, orphanedHashes: orphaned.map(header => header.hash) })}\n\n`
    )
    await delivered
    await monitor.reorgInvalidationPromise
    expect(client.streamErrorCount).toBe(0)
    expect(invalidatePreparedBeefsForReorg).toHaveBeenCalledTimes(1)
    expect(monitor.deactivatedHeaders.map(item => item.header.hash)).toEqual(orphaned.map(item => item.hash))
    const task = new TaskReorg(monitor, 0)
    expect(task.trigger(Date.now() + 1)).toEqual({ run: true })
    await expect(task.runTask()).resolves.toBe('repaired\nrepaired\n')
    expect(reproveHeader.mock.calls).toEqual(orphaned.map(item => [item.hash]))
    expect(monitor.deactivatedHeaders).toEqual([])
    expect(requests.filter(path => path.includes('/header/hash/'))).toEqual(
      orphaned.map(item => `/v2/header/hash/${item.hash}`)
    )
  } finally {
    await monitor.destroy()
    for (const stream of streams) stream.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error == null ? resolve() : reject(error))))
  }
})
