import { EventEmitter } from 'node:events'
import type { TelemetryEvent } from '@bsv/sdk'
import { StorageKnex } from '../StorageKnex'

describe('StorageKnex telemetry', () => {
  it('times parallel Knex queries by query UID without SQL, bindings, or rows', async () => {
    const events: TelemetryEvent[] = []
    let nextSpanId = 1
    const knex = new EventEmitter() as any
    knex.client = { config: { client: 'better-sqlite3' } }
    knex.destroy = jest.fn(async () => undefined)
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex,
      telemetry: {
        sink: {
          capture: event => events.push(event)
        },
        traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, '0')
      }
    })
    const first = {
      __knexQueryUid: 'query-1',
      method: 'select',
      sql: 'select secret from users where identityKey = ?',
      bindings: ['never-report-this']
    }
    const second = {
      __knexQueryUid: 'query-2',
      method: 'insert',
      sql: 'insert into certificates values (?)',
      bindings: ['private-certificate']
    }

    knex.emit('query', first)
    knex.emit('query', second)
    knex.emit('query-response', [{ identityKey: 'private' }], first)
    knex.emit('query-error', new Error('database unavailable'), second)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      name: 'wallet.storage.db.query',
      spanStatus: 'ok',
      attributes: {
        'db.system': 'sqlite',
        'db.operation': 'select'
      }
    })
    expect(events[1]).toMatchObject({
      name: 'wallet.storage.db.query',
      spanStatus: 'error',
      attributes: {
        'db.system': 'sqlite',
        'db.operation': 'insert'
      }
    })
    expect(JSON.stringify(events)).not.toContain('select secret')
    expect(JSON.stringify(events)).not.toContain('never-report-this')
    expect(JSON.stringify(events)).not.toContain('private-certificate')
    expect(JSON.stringify(events)).not.toContain('query-1')

    knex.emit('query', { __knexQueryUid: 'query-pending', method: 'delete' })
    await storage.destroy()
    expect(events.at(-1)?.spanStatus).toBe('cancelled')
    expect(knex.destroy).toHaveBeenCalled()
  })
})
