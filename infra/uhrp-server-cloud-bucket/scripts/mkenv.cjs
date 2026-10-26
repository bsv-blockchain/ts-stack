'use strict'

const { closeSync, constants, fchmodSync, openSync, writeFileSync } = require('node:fs')

const REQUIRED_RUNTIME_ENVIRONMENT = [
  'NODE_ENV',
  'PRICE_PER_GB_MO',
  'MIN_HOSTING_MINUTES',
  'HOSTING_DOMAIN',
  'ADMIN_TOKEN',
  'SERVER_PRIVATE_KEY',
  'GCP_PROJECT_ID',
  'GCP_BUCKET_NAME',
  'WALLET_STORAGE_URL',
  'BSV_NETWORK',
  'HTTP_PORT'
]

const OPTIONAL_RUNTIME_ENVIRONMENT = [
  // Local-development compatibility only. Production should use the runtime
  // service account through Application Default Credentials.
  'GCP_STORAGE_CREDS',
  'OTEL_SERVICE_NAME',
  'OTEL_CONSOLE_EXPORTERS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_DIAG',
  'DEPLOY_ENV',
  'LOG_LEVEL',
  'UHRP_CORS_MODE',
  'UHRP_CORS_ALLOWED_ORIGINS',
  'UHRP_CORS_ALLOWED_HEADERS',
  'UHRP_CROSS_ORIGIN_RESOURCE_POLICY',
  'UHRP_CROSS_ORIGIN_OPENER_POLICY',
  'UHRP_FRAME_OPTIONS',
  'UHRP_PERMISSIONS_POLICY',
  'UHRP_STRICT_TRANSPORT_SECURITY',
  'UHRP_RESOURCE_PROFILE',
  'UHRP_JSON_MAX_BODY_BYTES',
  'UHRP_MAX_RESPONSE_BYTES',
  'UHRP_MAX_CONCURRENT_REQUESTS',
  'UHRP_MAX_CONNECTIONS',
  'UHRP_LIST_DEFAULT_LIMIT',
  'UHRP_LIST_MAX_LIMIT',
  'UHRP_LIST_MAX_OFFSET',
  'UHRP_MAX_FILE_BYTES',
  'UHRP_MAX_RETENTION_MINUTES',
  'UHRP_REQUEST_TIMEOUT_MS',
  'UHRP_HEADERS_TIMEOUT_MS',
  'UHRP_KEEP_ALIVE_TIMEOUT_MS',
  'UHRP_SOCKET_TIMEOUT_MS',
  'UHRP_MAX_REQUESTS_PER_SOCKET',
  'CHIRP_OBJECT_MAX_BODY_BYTES',
  'CHIRP_MAX_LOGICAL_BYTES',
  'CHIRP_MAX_OBJECTS',
  'CHIRP_MAX_RETENTION_SECONDS',
  'CHIRP_STAGING_SECONDS',
  'CHIRP_GC_INTERVAL_MS',
  'CHIRP_GC_MAX_ENTRIES',
  'CHIRP_MAX_ACTIVE_SESSIONS',
  'CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY',
  'CHIRP_MAX_STAGED_OBJECTS_PER_SESSION',
  'CHIRP_MAX_STAGED_BYTES_PER_SESSION',
  'CHIRP_COMMIT_CACHE_ROOTS',
  'CHIRP_COMMIT_CACHE_OBJECTS',
  'CHIRP_COMMIT_CACHE_SECONDS',
  'UHRP_PRE_AUTH_RATE_LIMIT_MAX',
  'UHRP_PRE_AUTH_RATE_LIMIT_WINDOW_MS',
  'UHRP_AUTHENTICATED_RATE_LIMIT_MAX',
  'UHRP_AUTHENTICATED_RATE_LIMIT_WINDOW_MS',
  'TRUST_PROXY_HOPS'
]

function requiredEnvironment(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} is required to generate the deployment manifest`)
  }
  return value
}

function normalizedEnvironment(environment) {
  return {
    ...environment,
    GCP_PROJECT_ID: environment.GCP_PROJECT_ID || environment.GOOGLE_PROJECT_ID
  }
}

function renderServiceManifest(environment) {
  const values = normalizedEnvironment(environment)
  const lines = [
    'apiVersion: serving.knative.dev/v1',
    'kind: Service',
    'metadata:',
    `  name: ${JSON.stringify(requiredEnvironment(values, 'SERVICE'))}`,
    'spec:',
    '  template:',
    '    spec:',
    '      timeoutSeconds: 3540',
    '      containers:',
    `      - image: ${JSON.stringify(requiredEnvironment(values, 'IMAGE'))}`,
    '        ports:',
    '        - name: http1',
    '          containerPort: 8080',
    '        resources:',
    '          limits:',
    '            memory: "4Gi"',
    '        env:'
  ]
  for (const name of REQUIRED_RUNTIME_ENVIRONMENT) {
    lines.push(`        - name: ${name}`)
    lines.push(`          value: ${JSON.stringify(requiredEnvironment(values, name))}`)
  }
  for (const name of OPTIONAL_RUNTIME_ENVIRONMENT) {
    const value = values[name]
    if (typeof value !== 'string' || value === '') continue
    lines.push(`        - name: ${name}`)
    lines.push(`          value: ${JSON.stringify(value)}`)
  }
  return `${lines.join('\n')}\n`
}

function renderDispatchEnvironment(environment) {
  const values = normalizedEnvironment(environment)
  return [
    `HOSTING_DOMAIN: ${JSON.stringify(requiredEnvironment(values, 'HOSTING_DOMAIN'))}`,
    `ADMIN_TOKEN: ${JSON.stringify(requiredEnvironment(values, 'ADMIN_TOKEN'))}`,
    ''
  ].join('\n')
}

function writePrivateFile(path, contents) {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
    0o600
  )
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, contents, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function main(arguments_, environment = process.env) {
  if (arguments_.length !== 2 || arguments_.some(value => value === '')) {
    throw new Error('Usage: mkenv.sh <service-manifest-path> <dispatch-environment-path>')
  }
  const [serviceManifestPath, dispatchEnvironmentPath] = arguments_
  writePrivateFile(serviceManifestPath, renderServiceManifest(environment))
  writePrivateFile(dispatchEnvironmentPath, renderDispatchEnvironment(environment))
  console.log('Deployment environment files generated without printing secret values.')
}

module.exports = {
  main,
  renderDispatchEnvironment,
  renderServiceManifest
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
