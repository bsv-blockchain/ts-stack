import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startRelay, stopRelay, usage } from './relay.js'
import type { RelayLogger } from './relay.js'

interface LogRecord {
  level: 'info' | 'error'
  fields: Record<string, unknown>
  message: string
}

function recordingLogger(): { log: RelayLogger; records: LogRecord[] } {
  const records: LogRecord[] = []
  return {
    records,
    log: {
      info: (fields, message) => records.push({ level: 'info', fields, message }),
      error: (fields, message) => records.push({ level: 'error', fields, message })
    }
  }
}

test('usage lists the relay environment variables', () => {
  const text = usage()
  for (const name of ['PORT', 'HOST', 'PUBLIC_URLS', 'TRUSTED_IP_HEADER', 'TURN_PROVIDER']) {
    assert.match(text, new RegExp(`\\b${name}\\b`))
  }
})

test('refuses a non-loopback HOST without PUBLIC_URLS', async () => {
  const { log, records } = recordingLogger()
  await assert.rejects(startRelay({ HOST: '0.0.0.0', PORT: '0' }, log), /PUBLIC_URLS/)
  assert.deepEqual(records, [])
})

test('refuses an invalid PORT', async () => {
  const { log } = recordingLogger()
  await assert.rejects(
    startRelay({ HOST: '127.0.0.1', PORT: 'invalid' }, log),
    /PORT must be a whole number/
  )
})

test('serves public health and readiness probes, then closes on request', async () => {
  const { log, records } = recordingLogger()
  const relay = await startRelay(
    { HOST: '127.0.0.1', PORT: '0', PUBLIC_URLS: 'wss://relay.example' },
    log
  )
  try {
    const listen = records.find(record => record.fields.operation === 'listen')
    assert.equal(listen?.fields.outcome, 'success')
    assert.equal(listen?.fields.port, relay.port)
    assert.deepEqual(listen?.fields.public_urls, ['wss://relay.example'])
    assert.equal(listen?.fields.turn, 'none')

    for (const path of ['/health', '/ready']) {
      const response = await fetch(`http://127.0.0.1:${relay.port}${path}`, {
        headers: { Origin: 'https://unregistered.example' }
      })
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('access-control-allow-origin'), '*', path)
      await response.arrayBuffer()
    }
  } finally {
    await stopRelay(relay, 'SIGTERM', log)
  }
  const shutdown = records.find(record => record.fields.operation === 'shutdown')
  assert.equal(shutdown?.fields.outcome, 'success')
  assert.equal(shutdown?.fields.signal, 'SIGTERM')
})
