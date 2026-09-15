import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const registry = JSON.parse(readFileSync(join(root, 'governance/service-operations.json'), 'utf8'))

async function probe(service, environment) {
  const constructed = []
  const emitted = []
  const output = []
  const handlers = new Map()
  const exits = []
  let started = 0
  let stopped = 0
  let options
  const constructors = Object.fromEntries(
    [
      'RuntimeNodeInstrumentation',
      'OTLPTraceExporter',
      'OTLPMetricExporter',
      'OTLPLogExporter',
      'ConsoleSpanExporter',
      'BatchSpanProcessor',
      'SimpleSpanProcessor',
      'PeriodicExportingMetricReader',
      'ConsoleMetricExporter',
      'BatchLogRecordProcessor',
      'SimpleLogRecordProcessor',
      'ConsoleLogRecordExporter',
      'DiagConsoleLogger'
    ].map(name => [
      name,
      class {
        constructor(...args) {
          this.kind = name
          this.args = args
          constructed.push(this)
        }
      }
    ])
  )
  const modules = {
    ...constructors,
    NodeSDK: class {
      constructor(config) {
        options = config
      }
      start() {
        started += 1
      }
      async shutdown() {
        stopped += 1
      }
    },
    getNodeAutoInstrumentations: () => [],
    resourceFromAttributes: attributes => attributes,
    ATTR_SERVICE_NAME: 'service.name',
    ATTR_SERVICE_VERSION: 'service.version',
    logs: { getLogger: () => ({ emit: record => emitted.push(record) }) },
    SeverityNumber: { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 },
    diag: { setLogger() {} },
    DiagLogLevel: { INFO: 60 }
  }
  const appConsole = Object.fromEntries(
    ['debug', 'info', 'log', 'warn', 'error'].map(name => [
      name,
      (...args) => output.push({ name, args })
    ])
  )
  const originalLog = appConsole.log
  const fakeProcess = {
    env: environment,
    cwd: () => join(root, service.path),
    on(signal, handler) {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler])
    },
    listeners: signal => handlers.get(signal) ?? [],
    exit: code => exits.push(code)
  }
  const packageRequire = () => ({ name: service.name, version: '1.0.0' })
  const context = vm.createContext({
    console: appConsole,
    process: fakeProcess,
    require: packageRequire
  })
  const sourcePath = join(root, service.path, service.observability.telemetryFile)
  const source = stripTypeScriptTypes(readFileSync(sourcePath, 'utf8'))
  const module = new vm.SourceTextModule(source, {
    context,
    initializeImportMeta(meta) {
      meta.url = pathToFileURL(sourcePath).href
    }
  })
  await module.link(specifier => {
    const exports =
      specifier === 'node:module'
        ? { createRequire: () => packageRequire }
        : specifier === 'node:path'
          ? { join }
          : modules
    assert.ok(specifier.startsWith('@opentelemetry/') || specifier.startsWith('node:'))
    return new vm.SyntheticModule(
      Object.keys(exports),
      function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
      },
      { context }
    )
  })
  await module.evaluate()
  const otlp = Boolean(environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim())
  const enabled = otlp || environment.OTEL_CONSOLE_EXPORTERS === 'true'
  assert.equal(started, Number(enabled))
  assert.equal(handlers.size, enabled ? 2 : 0)
  appConsole.log('application message')
  assert.equal(output.filter(record => record.args[0] === 'application message').length, 1)
  assert.equal(emitted.length, otlp ? 1 : 0)
  if (!otlp) assert.equal(appConsole.log, originalLog)
  if (!enabled) {
    assert.equal(constructed.length, 0)
    return
  }
  const exporters = constructed
    .filter(value => value.kind.endsWith('Exporter'))
    .map(value => value.kind)
  assert.deepEqual(
    exporters,
    otlp
      ? ['OTLPTraceExporter', 'OTLPMetricExporter', 'OTLPLogExporter']
      : ['ConsoleSpanExporter', 'ConsoleMetricExporter', 'ConsoleLogRecordExporter']
  )
  assert.equal(options.spanProcessors[0].kind, otlp ? 'BatchSpanProcessor' : 'SimpleSpanProcessor')
  // An application's drain handler keeps ownership of process exit.
  fakeProcess.on('SIGTERM', () => {})
  handlers.get('SIGTERM')[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, 1)
  assert.deepEqual(exits, [])
}

if (process.argv.includes('--bootstrap-probe')) {
  for (const service of registry.services) {
    for (const environment of [
      {},
      { NODE_ENV: 'production', OTEL_CONSOLE_EXPORTERS: 'false' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: '   ' },
      { OTEL_CONSOLE_EXPORTERS: 'true' },
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.invalid:4318',
        OTEL_CONSOLE_EXPORTERS: 'true'
      }
    ])
      await probe(service, environment)
  }
} else {
  test('all seven telemetry bootstraps preserve quiet defaults, explicit console mode, OTLP precedence and application shutdown', () => {
    execFileSync(
      process.execPath,
      ['--experimental-vm-modules', fileURLToPath(import.meta.url), '--bootstrap-probe'],
      { cwd: root, stdio: 'pipe', timeout: 30000 }
    )
  })
}
