import { describe, expect, it } from '@jest/globals'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOutputLookupOpen, parseOutputLookupRead, type OutputLookupBatch } from '@bsv/sdk'
import { OutputKnowledge } from '../src/index.js'
import { LiveLookupSource } from '../src/sources/LiveLookupSource.js'
import { candidate, chain, corpus } from './evidence-fixture.js'
import { liveFixture, liveStores } from './live-lookup-fixture.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return {
    resolve,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('HTTP fixture progress deadline')), 5000)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }
}

describe('live source over actual HTTP', () => {
  it('ingests snapshot pages progressively, resumes missed live changes after restart, and preserves whole groups', async () => {
    const path = await mkdtemp(join(tmpdir(), 'lookup-http-'))
    let fixture!: ReturnType<typeof liveFixture>
    let secondPage: OutputLookupBatch | undefined
    let live: OutputLookupBatch | undefined
    const pending = new Set<ServerResponse>()
    const pageRequested = deferred(),
      headRequested = deferred(),
      liveReceived = deferred()
    const requests: { operation: string; body: unknown }[] = []
    const errors: unknown[] = []
    const send = (response: ServerResponse, packet: OutputLookupBatch) => {
      if (response.destroyed) return
      response.writeHead(200, Object.fromEntries(fixture.response().headers))
      response.end(JSON.stringify(packet))
    }
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 1048576) request.destroy()
      })
      request.on('end', () => {
        try {
          const input: unknown = JSON.parse(body)
          const operation = request.url?.split('/').at(-1) ?? ''
          requests.push({ operation, body: input })
          if (operation === 'open') {
            expect(parseOutputLookupOpen(input)).toEqual(fixture.open)
            send(response, fixture.packet)
          } else {
            const read = parseOutputLookupRead(input)
            expect(read.session).toBe(fixture.packet.session)
            expect(read.limits).toEqual(fixture.open.limits)
            if (read.cursor === 'page-a') {
              pageRequested.resolve()
              if (secondPage) send(response, secondPage)
              else pending.add(response)
            } else if (read.cursor === 'snapshot-complete') {
              headRequested.resolve()
              if (live) send(response, live)
              else pending.add(response)
            } else {
              expect(read.cursor).toBe('live-6')
              liveReceived.resolve()
              pending.add(response)
            }
            response.on('close', () => pending.delete(response))
          }
        } catch (error) {
          errors.push(error)
          response.writeHead(500)
          response.end()
        }
      })
    })
    let runtime: OutputKnowledge | undefined
    let stores: Awaited<ReturnType<typeof liveStores>> | undefined
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing fixture address')
      fixture = liveFixture({}, `http://127.0.0.1:${address.port}/api`)
      const scope = fixture.packet.scope
      const output = (id: string, name: string) => ({
        id,
        scope,
        kind: 'output' as const,
        payload: { evidence: candidate(name).evidence }
      })
      fixture.packet = {
        ...fixture.packet,
        cursor: 'page-a',
        snapshotComplete: false,
        groups: [{ id: 'page-a', sequence: '5', observations: [output('a', 'A')] }]
      }
      stores = await liveStores(path, fixture)
      const options = {
        configuration: fixture.config,
        trust: fixture.selection,
        now: () => 1000000
      }
      const source = new LiveLookupSource({ ...options, ...stores })
      const request = await source.connect()
      runtime = new OutputKnowledge({ store: stores.core, worker: stores.worker })
      const subscription = runtime.attach(source, request)
      await pageRequested.wait()
      await runtime.flush()
      expect((await stores.core.read()).observations.map(row => row.id)).toEqual(['a'])
      secondPage = {
        ...fixture.packet,
        cursor: 'snapshot-complete',
        snapshotComplete: true,
        groups: [{ id: 'page-b', sequence: '5', observations: [output('b', 'B')] }]
      }
      for (const response of pending) send(response, secondPage)
      pending.clear()
      await headRequested.wait()
      await runtime.flush()
      expect((await stores.core.read()).observations.map(row => row.id)).toEqual(['a', 'b'])
      subscription.close()
      await subscription.done.catch(error => expect(error).toMatchObject({ code: 'cancelled' }))
      await runtime.flush()
      await runtime.close()
      runtime = undefined
      await stores.control.close()
      // A change while this client is disconnected remains after the same cursor.
      live = {
        ...fixture.packet,
        phase: 'live',
        cursor: 'live-6',
        snapshotComplete: true,
        through: '6',
        highWater: '6',
        groups: [
          {
            id: 'replacement',
            sequence: '6',
            observations: [
              {
                id: 'remove-a',
                scope,
                kind: 'withdraw',
                payload: {
                  outpoint: { chain, txid: corpus.transactions.A.txid, outputIndex: 0 },
                  reason: 'Selection changed'
                }
              },
              output('c', 'Q')
            ]
          }
        ]
      }
      stores = await liveStores(path, fixture, false)
      const recovered = new LiveLookupSource({ ...options, ...stores })
      const recoveredRequest = await recovered.connect()
      runtime = new OutputKnowledge({ store: stores.core, worker: stores.worker })
      const resumed = runtime.attach(recovered, recoveredRequest)
      await liveReceived.wait()
      await runtime.flush()
      const state = await stores.core.read()
      expect(state.observations.map(row => row.id)).toEqual(['a', 'b', 'c', 'remove-a'])
      expect(
        state.reconciled.memberships.find(row => row.outpoint.txid === corpus.transactions.A.txid)
      ).toMatchObject({ present: false, observationId: 'remove-a' })
      expect(
        state.reconciled.memberships
          .filter(row => row.present)
          .map(row => row.observationId)
          .sort()
      ).toEqual(['b', 'c'])
      expect(state.facts.some(fact => fact.txid === corpus.transactions.A.txid)).toBe(true)
      const received = (await stores.core.inspect()).entries.filter(
        row => row.body.kind === 'receive'
      )
      const replacement = received.find(
        row => row.body.kind === 'receive' && row.body.batch.groups[0]?.id === 'replacement'
      )
      expect(replacement?.body).toMatchObject({
        kind: 'receive',
        batch: {
          groups: live.groups,
          checkpoint: { cursor: 'live-6' }
        }
      })
      expect(requests.filter(row => row.operation === 'open')).toHaveLength(1)
      expect(errors).toEqual([])
      resumed.close()
      await resumed.done.catch(error => expect(error).toMatchObject({ code: 'cancelled' }))
    } finally {
      if (runtime) await runtime.close()
      if (stores) {
        await stores.core.close()
        await stores.control.close()
      }
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(path, { recursive: true, force: true })
    }
  }, 15000)
})
