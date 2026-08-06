#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TEST_PRIVATE_KEY = `${'0'.repeat(63)}1`
const TEST_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const TEST_ENCRYPTION_KEY = 'ab'.repeat(32)
const TEST_DATABASE_PASSWORD = process.env.CONTRACT_DB_PASSWORD ?? ''
const databaseConnection = database =>
  JSON.stringify({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: TEST_DATABASE_PASSWORD,
    database
  })
const WALLET_URL = 'http://127.0.0.1:3998'
const COMMON_ENVIRONMENT = {
  DEPLOY_ENV: 'container-contract',
  LOG_LEVEL: 'info',
  OTEL_DIAG: 'false',
  OTEL_EXPORTER_OTLP_ENDPOINT: '',
  OTEL_SDK_DISABLED: 'true'
}

const packagedEdgePolicySources = {
  'overlay-server': {
    lock: '../infra/overlay-server/package-lock.json',
    location: 'node_modules/@bsv/overlay-express',
    manifest: '../packages/overlays/overlay-express/package.json'
  },
  'wallet-infra': {
    lock: '../infra/wallet-infra/package-lock.json',
    location: 'node_modules/@bsv/wallet-toolbox',
    manifest: '../packages/wallet/wallet-toolbox/package.json'
  }
}

const imageContainsCurrentEdgePolicy = component => {
  const source = packagedEdgePolicySources[component]
  if (source === undefined) return true
  const lock = JSON.parse(readFileSync(new URL(source.lock, import.meta.url), 'utf8'))
  const manifest = JSON.parse(readFileSync(new URL(source.manifest, import.meta.url), 'utf8'))
  return lock.packages?.[source.location]?.version === manifest.version
}

const contracts = {
  'chaintracks-server': {
    port: 3011,
    environment: {
      CHAIN: 'test',
      ENABLE_BULK_HEADERS_CDN: 'false',
      SOURCE_CDN_URL: 'https://cdn.projectbabbage.com/blockheaders/'
    },
    invalidEnvironment: { CHAIN: 'invalid' },
    liveness: '/getInfo',
    readiness: '/getInfo',
    transaction: { method: 'GET', path: '/getInfo', status: 200 },
    migration: 'not-applicable'
  },
  'message-box-server': {
    port: 8080,
    walletDependency: true,
    environment: {
      BSV_NETWORK: 'testnet',
      ENABLE_FIREBASE: 'false',
      ENABLE_WEBSOCKETS: 'true',
      KNEX_DB_CLIENT: 'mysql2',
      KNEX_DB_CONNECTION: databaseConnection('container_contract_message'),
      NODE_ENV: 'development',
      PORT: '8080',
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      WALLET_STORAGE_URL: WALLET_URL
    },
    invalidEnvironment: { PORT: 'invalid' },
    liveness: '/health',
    readiness: '/ready',
    transaction: { method: 'GET', path: '/openapi.json', status: 200 },
    migration: 'readiness-after-startup-migration'
  },
  'overlay-server': {
    port: 8080,
    walletDependency: true,
    environment: {
      ARC_API_KEY: 'container-contract-only-not-a-secret',
      BASM_ENABLED: 'false',
      BASM_REORG_STREAM_ENABLED: 'false',
      GASP_ENABLED: 'false',
      HOSTING_URL: 'https://overlay.container-contract.example',
      KNEX_URL: `mysql://root:${encodeURIComponent(TEST_DATABASE_PASSWORD)}@127.0.0.1:3306/container_contract_overlay`,
      MONGO_URL: 'mongodb://127.0.0.1:27017/container_contract_overlay',
      NETWORK: 'test',
      NODE_NAME: 'container-contract',
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      WALLET_STORAGE_URL: WALLET_URL
    },
    invalidEnvironment: { HOSTING_URL: 'http://127.0.0.1:8080' },
    liveness: '/health/live',
    readiness: '/health/ready',
    transaction: { method: 'GET', path: '/listTopicManagers', status: 200 },
    migration: 'readiness-after-startup-migration'
  },
  'uhrp-server-basic': {
    port: 8080,
    walletDependency: true,
    environment: {
      BSV_NETWORK: 'testnet',
      HOSTING_DOMAIN: '127.0.0.1:8080',
      HTTP_PORT: '8080',
      MIN_HOSTING_MINUTES: '1',
      PRICE_PER_GB_MO: '0.03',
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      WALLET_STORAGE_URL: WALLET_URL
    },
    invalidEnvironment: { SERVER_PRIVATE_KEY: 'invalid' },
    liveness: '/health',
    readiness: '/ready',
    transaction: {
      method: 'POST',
      path: '/quote',
      status: 200,
      body: { fileSize: 1024, retentionPeriod: 60 }
    },
    migration: 'not-applicable'
  },
  'uhrp-server-cloud-bucket': {
    port: 8080,
    walletDependency: true,
    environment: {
      BSV_NETWORK: 'testnet',
      HOSTING_DOMAIN: '127.0.0.1:8080',
      HTTP_PORT: '8080',
      MIN_HOSTING_MINUTES: '1',
      PRICE_PER_GB_MO: '0.03',
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      WALLET_STORAGE_URL: WALLET_URL
    },
    invalidEnvironment: { SERVER_PRIVATE_KEY: 'invalid' },
    liveness: '/health',
    readiness: '/ready',
    transaction: {
      method: 'POST',
      path: '/quote',
      status: 200,
      body: { fileSize: 1024, retentionPeriod: 60 }
    },
    migration: 'not-applicable'
  },
  wab: {
    port: 8080,
    environment: {
      BSV_NETWORK: 'test',
      DB_CLIENT: 'mysql2',
      DB_HOST: '127.0.0.1',
      DB_NAME: 'container_contract_wab',
      DB_PASS: TEST_DATABASE_PASSWORD,
      DB_PORT: '3306',
      DB_USER: 'root',
      NODE_ENV: 'production',
      PORT: '8080',
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      SHARE_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      STORAGE_URL: WALLET_URL
    },
    invalidEnvironment: { DB_CLIENT: 'invalid' },
    liveness: '/info',
    readiness: '/info',
    transaction: { method: 'GET', path: '/info', status: 200 },
    migration: 'readiness-after-startup-migration'
  },
  'wallet-infra': {
    port: 3998,
    environment: {
      BSV_NETWORK: 'test',
      ENABLE_NGINX: 'false',
      HTTP_PORT: '3998',
      KNEX_DB_CONNECTION: databaseConnection('container_contract_wallet'),
      SERVER_PRIVATE_KEY: TEST_PRIVATE_KEY,
      WALLET_INFRA_ROLE: 'all',
      WALLET_STORAGE_MONITOR_START_TASKS: 'true',
      WALLET_STORAGE_MONITOR_STARTUP_TASK_MODE: 'multiuser',
      WALLET_STORAGE_TRUST_PROXY_HOPS: '1',
      ADMIN_HOST: '127.0.0.1',
      ADMIN_IDENTITY_KEYS: TEST_PUBLIC_KEY,
      ADMIN_PORT: '3999',
      ADMIN_ROOT_KEY_HEX: TEST_PRIVATE_KEY
    },
    invalidEnvironment: { SERVER_PRIVATE_KEY: '' },
    liveness: '/',
    readiness: '/',
    transaction: {
      method: 'GET',
      path: '/',
      status: 200,
      headers: { 'X-Forwarded-For': '198.51.100.7' }
    },
    auxiliaryEndpoints: [
      { port: 3999, path: '/healthz', status: 200 },
      { port: 3999, path: '/admin', status: 200 }
    ],
    requiredLogPatterns: [
      '"monitor_tasks_enabled":true',
      '"monitor_startup_task_mode":"multiuser"',
      '"monitor_admin_enabled":true',
      '"operation":"monitor_admin.start"'
    ],
    forbiddenLogPatterns: ['ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'],
    migration: 'readiness-after-startup-migration'
  }
}

const parseArguments = argv => {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '')
    const value = argv[index + 1]
    if (name === undefined || value === undefined) {
      throw new Error('arguments must be supplied as --name value pairs')
    }
    values[name] = value
  }
  return values
}

const docker = async (...arguments_) =>
  await execFileAsync('docker', arguments_, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  })

const containerLogs = async name => {
  const { stdout, stderr } = await docker('logs', name)
  return `${stdout}${stderr}`
}

const environmentArguments = environment =>
  Object.entries({ ...COMMON_ENVIRONMENT, ...environment }).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`
  ])

const removeContainer = async name => {
  await docker('rm', '--force', name).catch(() => undefined)
}

const inspectContainer = async (name, template) =>
  (await docker('inspect', '--format', template, name)).stdout.trim()

const waitForExit = async (name, timeoutMilliseconds) => {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    const running = await inspectContainer(name, '{{.State.Running}}')
    if (running === 'false') {
      return Number(await inspectContainer(name, '{{.State.ExitCode}}'))
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return undefined
}

const assertImageMetadata = async image => {
  const user = await inspectContainer(image, '{{.Config.User}}').catch(async () =>
    (await docker('image', 'inspect', '--format', '{{.Config.User}}', image)).stdout.trim()
  )
  if (user === '' || user === '0' || user === 'root') {
    throw new Error(`${image} must run as a non-root image user`)
  }
  const healthcheck = (
    await docker('image', 'inspect', '--format', '{{json .Config.Healthcheck.Test}}', image)
  ).stdout.trim()
  if (healthcheck === '' || healthcheck === 'null') {
    throw new Error(`${image} must contain an image health check`)
  }
}

const assertInvalidConfigurationFails = async (component, image, contract) => {
  const name = `contract-invalid-${component}`
  await removeContainer(name)
  await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'host',
    ...environmentArguments({ ...contract.environment, ...contract.invalidEnvironment }),
    image
  )
  const exitCode = await waitForExit(name, 30_000)
  const logs = await containerLogs(name)
  await removeContainer(name)
  if (exitCode === undefined) {
    throw new Error(`${component} accepted an intentionally invalid configuration\n${logs}`)
  }
  if (exitCode === 0) {
    throw new Error(`${component} invalid configuration exited successfully\n${logs}`)
  }
}

const startContainer = async (name, image, environment) => {
  await removeContainer(name)
  await docker(
    'run',
    '--detach',
    '--name',
    name,
    '--network',
    'host',
    ...environmentArguments(environment),
    image
  )
}

const responseAt = async (port, request) => {
  const headers = {
    Origin: 'https://unregistered-container-contract.example',
    ...request.headers
  }
  let body
  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(request.body)
  }
  return await fetch(`http://127.0.0.1:${port}${request.path}`, {
    method: request.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(5_000)
  })
}

const waitForEndpoint = async (container, port, request, timeoutMilliseconds = 180_000) => {
  const deadline = Date.now() + timeoutMilliseconds
  let lastError
  while (Date.now() < deadline) {
    if ((await inspectContainer(container, '{{.State.Running}}')) === 'false') {
      const state = await inspectContainer(container, '{{json .State}}')
      const logs = await containerLogs(container)
      throw new Error(`${container} exited before ${request.path} became ready\n${state}\n${logs}`)
    }
    try {
      const response = await responseAt(port, request)
      if (response.status === request.status) return response
      lastError = new Error(`${request.path} returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
  const logs = await containerLogs(container)
  throw new Error(`${container} did not become ready: ${String(lastError)}\n${logs}`)
}

const assertPublicResponse = async (component, response) => {
  if (response.headers.get('access-control-allow-origin') !== '*') {
    throw new Error(`${component} must retain credential-free wildcard CORS by default`)
  }
  await response.arrayBuffer()
}

const assertForwardCompatiblePreflight = async (component, container, port, path) => {
  const requestedHeaders = ['X-Correlation-ID', 'X-TS-Stack-Contract-Probe']
  const response = await waitForEndpoint(container, port, {
    path,
    method: 'OPTIONS',
    status: 204,
    headers: {
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': requestedHeaders.join(', ')
    }
  })
  if (response.headers.get('access-control-allow-origin') !== '*') {
    throw new Error(`${component} preflight must retain credential-free wildcard CORS`)
  }
  const allowedHeaders = new Set(
    (response.headers.get('access-control-allow-headers') ?? '')
      .split(',')
      .map(header => header.trim().toLowerCase())
      .filter(Boolean)
  )
  for (const header of requestedHeaders) {
    if (!allowedHeaders.has(header.toLowerCase())) {
      throw new Error(`${component} preflight omitted additive request header ${header}`)
    }
  }
  await response.arrayBuffer()
}

const stopGracefully = async name => {
  await docker('kill', '--signal', 'SIGTERM', name)
  const exitCode = await waitForExit(name, 30_000)
  const logs = await containerLogs(name)
  if (exitCode !== 0) {
    throw new Error(`${name} did not shut down cleanly (exit ${String(exitCode)})\n${logs}`)
  }
  await removeContainer(name)
}

const startWalletDependency = async walletImage => {
  if (walletImage === undefined) {
    throw new Error('--wallet-image is required for this component')
  }
  const contract = contracts['wallet-infra']
  await startContainer('contract-wallet-dependency', walletImage, contract.environment)
  const ready = await waitForEndpoint('contract-wallet-dependency', contract.port, {
    path: contract.readiness,
    status: 200
  })
  await assertPublicResponse('wallet-infra dependency', ready)
  if (imageContainsCurrentEdgePolicy('wallet-infra')) {
    await assertForwardCompatiblePreflight(
      'wallet-infra dependency',
      'contract-wallet-dependency',
      contract.port,
      contract.liveness
    )
  } else {
    console.log(
      'wallet-infra dependency CORS header probe awaits the protected published-version sync'
    )
  }
}

export const contractNames = () => Object.keys(contracts)

export const contractEnvironment = component => ({ ...contracts[component]?.environment })

export async function runContainerRuntimeContract({ component, image, walletImage }) {
  const contract = contracts[component]
  if (contract === undefined) throw new Error(`unknown component ${component}`)
  if (image === undefined) throw new Error('--image is required')
  if (TEST_DATABASE_PASSWORD === '') {
    throw new Error('CONTRACT_DB_PASSWORD is required')
  }

  await assertImageMetadata(image)
  await assertInvalidConfigurationFails(component, image, contract)

  let completed = false
  try {
    if (contract.walletDependency === true) {
      await startWalletDependency(walletImage)
    }
    const name = `contract-${component}`
    await startContainer(name, image, contract.environment)
    const liveness = await waitForEndpoint(name, contract.port, {
      path: contract.liveness,
      status: 200
    })
    await assertPublicResponse(component, liveness)
    const readiness = await waitForEndpoint(name, contract.port, {
      path: contract.readiness,
      status: 200
    })
    await assertPublicResponse(component, readiness)
    const headerCompatibilityVerified = imageContainsCurrentEdgePolicy(component)
    if (headerCompatibilityVerified) {
      await assertForwardCompatiblePreflight(component, name, contract.port, contract.liveness)
    } else {
      console.log(`${component} CORS header probe awaits the protected published-version sync`)
    }
    const transaction = await waitForEndpoint(name, contract.port, contract.transaction)
    await assertPublicResponse(component, transaction)
    for (const endpoint of contract.auxiliaryEndpoints ?? []) {
      const response = await waitForEndpoint(name, endpoint.port, endpoint)
      await assertPublicResponse(`${component} ${endpoint.path}`, response)
    }
    const logs = await containerLogs(name)
    for (const pattern of contract.requiredLogPatterns ?? []) {
      if (!logs.includes(pattern)) {
        throw new Error(
          `${component} did not emit required runtime log pattern: ${pattern}\n${logs}`
        )
      }
    }
    for (const pattern of contract.forbiddenLogPatterns ?? []) {
      if (logs.includes(pattern)) {
        throw new Error(`${component} emitted forbidden runtime log pattern: ${pattern}\n${logs}`)
      }
    }
    await stopGracefully(name)
    completed = true
  } finally {
    if (completed) await removeContainer(`contract-${component}`)
    if (completed && contract.walletDependency === true) {
      await stopGracefully('contract-wallet-dependency').catch(async error => {
        await removeContainer('contract-wallet-dependency')
        throw error
      })
    }
  }

  return {
    component,
    migration: contract.migration,
    checks: [
      'image-user',
      'image-healthcheck',
      'configuration-failure',
      'startup',
      'liveness',
      'readiness',
      'migration-order',
      'public-cors',
      imageContainsCurrentEdgePolicy(component)
        ? 'cors-request-header-forward-compatibility'
        : 'cors-request-header-pending-published-dependency-sync',
      ...(contract.auxiliaryEndpoints == null ? [] : ['auxiliary-endpoints']),
      'minimal-transaction',
      'graceful-shutdown'
    ]
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arguments_ = parseArguments(process.argv.slice(2))
  const result = await runContainerRuntimeContract({
    component: arguments_.component,
    image: arguments_.image,
    walletImage: arguments_['wallet-image']
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
