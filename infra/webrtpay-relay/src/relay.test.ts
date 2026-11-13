import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readRelayOptions, startRelay, stopRelay, usage } from './relay.js'
import type { RelayLogger } from './relay.js'

interface LogRecord {
  level: 'info' | 'warn' | 'error'
  fields: Record<string, unknown>
  message: string
}

function recordingLogger(): { log: RelayLogger; records: LogRecord[] } {
  const records: LogRecord[] = []
  return {
    records,
    log: {
      info: (fields, message) => records.push({ level: 'info', fields, message }),
      warn: (fields, message) => records.push({ level: 'warn', fields, message }),
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

test('refuses a non-loopback HOST without PUBLIC_URLS', () => {
  assert.throws(() => readRelayOptions({ HOST: '0.0.0.0', PORT: '0' }), /PUBLIC_URLS/)
})

test('refuses an invalid PORT', () => {
  assert.throws(
    () => readRelayOptions({ HOST: '127.0.0.1', PORT: 'invalid' }),
    /PORT must be a whole number/
  )
})

test('logs the package operator warnings at warn level', async () => {
  const { log, records } = recordingLogger()
  const relay = await startRelay(readRelayOptions({ HOST: '127.0.0.1', PORT: '0' }), log)
  await stopRelay(relay, 'SIGTERM', log)
  const warnings = records.filter(record => record.level === 'warn')
  assert.ok(warnings.length > 0)
  assert.ok(warnings.every(record => record.message.includes('WARNING')))
  assert.ok(warnings.every(record => record.fields.operation === 'relay.event'))
})

test('serves public health and readiness probes, then closes on request', async () => {
  const { log, records } = recordingLogger()
  const relay = await startRelay(
    readRelayOptions({ HOST: '127.0.0.1', PORT: '0', PUBLIC_URLS: 'wss://relay.example' }),
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
