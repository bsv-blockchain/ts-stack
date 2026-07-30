#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT_PATH = join(ROOT, 'docs/reference/service-operations.md')
const DIGEST_IMAGE = /@sha256:[0-9a-f]{64}$/
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/
const STATEFUL_CLASS_ANNOTATION = 'ts-stack.bsvblockchain.org/workload-class'
const STATEFUL_CLASS = 'example-not-production'
const AUTOSCALING_POLICY_ANNOTATION = 'ts-stack.bsvblockchain.org/autoscaling-policy'
const DISRUPTION_POLICY_ANNOTATION = 'ts-stack.bsvblockchain.org/disruption-policy'
const SECRET_NAME_TOKENS = [
  'password',
  'privatekey',
  'encryptionkey',
  'secret',
  'token',
  'apikey',
  'credential',
  'creds',
  'serviceaccount',
  'knexurl',
  'mongourl',
  'dbpass',
  'connection'
]

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const isSecretName = name => {
  const normalized = String(name ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
  return SECRET_NAME_TOKENS.some(token => normalized.includes(token))
}

const podSpec = document => {
  if (document.kind === 'Deployment') return document.spec?.template?.spec
  if (document.kind === 'CronJob') return document.spec?.jobTemplate?.spec?.template?.spec
  return undefined
}

const yamlDocuments = async path => {
  const { default: YAML } = await import('yaml')
  return YAML.parseAllDocuments(await readFile(path, 'utf8'))
    .map(document => document.toJSON())
    .filter(document => document != null)
}

const workloadDocuments = async path =>
  (await yamlDocuments(path)).filter(document => podSpec(document) !== undefined)

const manifestFiles = async path => {
  const files = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) files.push(...(await manifestFiles(entryPath)))
    else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) files.push(entryPath)
  }
  return files
}

const validateContainer = (container, prefix, errors) => {
  if (!DIGEST_IMAGE.test(container.image ?? '')) {
    errors.push(`${prefix} image must use a tag or name plus sha256 digest`)
  }
  for (const environment of container.env ?? []) {
    if (
      isSecretName(environment.name) &&
      typeof environment.value === 'string' &&
      environment.value !== ''
    ) {
      errors.push(`${prefix} ${environment.name} must not contain a literal value`)
    }
  }
}

const validateRegistryShape = (registry, containers, errors) => {
  if (registry.schemaVersion !== 2) errors.push('service-operations schemaVersion must be 2')
  const governedNames = containers.components.map(component => component.name).sort()
  const serviceNames = registry.services.map(service => service.name).sort()
  if (JSON.stringify(governedNames) !== JSON.stringify(serviceNames)) {
    errors.push('service-operations services must exactly match container-images components')
  }
}

const validatePublicEdge = (policy, errors) => {
  const expected = {
    defaultCorsMode: 'public-wildcard',
    allowOpaqueOrigins: true,
    allowCredentials: false,
    allowlistIsOptIn: true,
    cspIsSeparate: true
  }
  for (const [field, value] of Object.entries(expected)) {
    if (policy?.[field] !== value) {
      errors.push(`public edge policy ${field} must remain ${JSON.stringify(value)}`)
    }
  }
}

const validateConfigMap = (document, manifestName, errors) => {
  for (const [name, value] of Object.entries(document.data ?? {})) {
    if (isSecretName(name) && typeof value === 'string' && value !== '') {
      errors.push(`${manifestName} ${name} must not contain secret material`)
    }
  }
}

const validateManifestWorkload = (spec, workload, errors) => {
  if (spec.automountServiceAccountToken !== false) {
    errors.push(`${workload} must disable service-account token mounting`)
  }
  for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
    validateContainer(container, `${workload} container ${container.name}`, errors)
  }
}

const validateManifestDocument = (root, manifest, document, errors) => {
  const manifestName = `${relative(root, manifest)} ${document.kind}/${document.metadata?.name}`
  if (document.kind === 'Secret') errors.push(`${manifestName} must not be checked in`)
  if (document.kind === 'ConfigMap') validateConfigMap(document, manifestName, errors)
  const spec = podSpec(document)
  if (spec !== undefined) validateManifestWorkload(spec, manifestName, errors)
}

const validateManifestRoot = async (root, manifestRoot, errors) => {
  const absoluteRoot = join(root, manifestRoot)
  if (!existsSync(absoluteRoot)) {
    errors.push(`service-operations references missing manifest root ${manifestRoot}`)
    return
  }
  for (const manifest of await manifestFiles(absoluteRoot)) {
    for (const document of await yamlDocuments(manifest)) {
      validateManifestDocument(root, manifest, document, errors)
    }
  }
}

const REQUIRED_SERVICE_FIELDS = [
  'path',
  'envExample',
  'port',
  'livenessPath',
  'readinessPath',
  'state',
  'migration',
  'backup',
  'rpo',
  'rto',
  'restoreValidation',
  'operatorGuide'
]

const requireStrings = (value, fields, prefix, errors) => {
  for (const field of fields) {
    if (typeof value?.[field] !== 'string' || value[field].trim() === '') {
      errors.push(`${prefix} must define ${field}`)
    }
  }
}

const validateStringArray = (value, prefix, errors, minimum = 1) => {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.some(item => typeof item !== 'string' || item.trim() === '')
  ) {
    errors.push(`${prefix} must contain at least ${minimum} non-empty string(s)`)
    return
  }
  if (new Set(value).size !== value.length) errors.push(`${prefix} must not contain duplicates`)
}

const validateEnvironmentGroup = (values, prefix, errors) => {
  validateStringArray(values, prefix, errors, 0)
  for (const value of values ?? []) {
    if (!ENVIRONMENT_NAME.test(value)) errors.push(`${prefix} contains invalid name ${value}`)
  }
}

const documentedEnvironment = document => {
  const names = new Set()
  for (const rawLine of document.split(/\r?\n/)) {
    let line = rawLine.trimStart()
    if (line.startsWith('#')) line = line.slice(1).trimStart()
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator)
    if (ENVIRONMENT_NAME.test(name)) names.add(name)
  }
  return names
}

const validateServiceEnvironment = async (root, service, telemetryPolicy, prefix, errors) => {
  const path = join(root, service.envExample)
  if (!existsSync(path)) {
    errors.push(`${prefix} references missing ${service.envExample}`)
    return
  }
  const configuration = service.configuration
  for (const group of ['required', 'optional', 'secrets']) {
    validateEnvironmentGroup(configuration?.[group], `${prefix} configuration.${group}`, errors)
  }
  const required = new Set(configuration.required)
  const optional = new Set(configuration.optional)
  for (const name of required) {
    if (optional.has(name)) errors.push(`${prefix} lists ${name} as both required and optional`)
  }
  const classified = new Set([...required, ...optional, ...telemetryPolicy.environment])
  for (const secret of configuration.secrets) {
    if (!classified.has(secret)) errors.push(`${prefix} secret ${secret} is not classified`)
    if (!isSecretName(secret) && !telemetryPolicy.secretEnvironment.includes(secret)) {
      errors.push(`${prefix} secret ${secret} does not look secret-bearing`)
    }
  }
  const documented = documentedEnvironment(await readFile(path, 'utf8'))
  for (const name of classified) {
    if (!documented.has(name)) errors.push(`${prefix} ${service.envExample} omits ${name}`)
  }
}

const validateServiceDockerfile = async (root, service, prefix, errors) => {
  const dockerfilePath = join(root, service.path, 'Dockerfile')
  if (!existsSync(dockerfilePath)) {
    errors.push(`${prefix} is missing Dockerfile`)
    return
  }
  const dockerfile = await readFile(dockerfilePath, 'utf8')
  if (!/^USER (?!root\b)\S+/m.test(dockerfile)) {
    errors.push(`${prefix} Dockerfile must end in a non-root runtime user`)
  }
  if (!/^HEALTHCHECK /m.test(dockerfile)) {
    errors.push(`${prefix} Dockerfile must define HEALTHCHECK`)
  }
  if (!dockerfile.includes(service.readinessPath)) {
    errors.push(`${prefix} Dockerfile health check must use ${service.readinessPath}`)
  }
  if (
    !service.observability.preload.split(/\s+/).every(fragment => dockerfile.includes(fragment))
  ) {
    errors.push(`${prefix} Dockerfile must preload telemetry with ${service.observability.preload}`)
  }
}

const validateTelemetryDependencies = (manifest, policy, prefix, errors) => {
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies }
  for (const [name, version] of Object.entries(policy.dependencyVersions)) {
    if (dependencies[name] !== version) {
      errors.push(`${prefix} must pin ${name} to the aligned range ${version}`)
    }
  }
  const governed = new Set(Object.keys(policy.dependencyVersions))
  for (const name of Object.keys(dependencies)) {
    if (name.startsWith('@opentelemetry/') && !governed.has(name)) {
      errors.push(`${prefix} has unmanaged direct telemetry dependency ${name}`)
    }
  }
}

const validateServiceObservability = async (root, service, telemetryPolicy, prefix, errors) => {
  const observability = service.observability
  if (!['cjs', 'esm'].includes(observability?.module)) {
    errors.push(`${prefix} observability.module must be cjs or esm`)
  }
  requireStrings(
    observability,
    ['telemetryFile', 'loggerFile', 'preload'],
    `${prefix} observability`,
    errors
  )
  validateStringArray(observability?.operations, `${prefix} observability.operations`, errors)
  for (const file of [observability.telemetryFile, observability.loggerFile]) {
    if (!existsSync(join(root, service.path, file))) {
      errors.push(`${prefix} observability references missing ${file}`)
    }
  }
  const manifest = await readJson(join(root, service.path, 'package.json'))
  validateTelemetryDependencies(manifest, telemetryPolicy, prefix, errors)
  const startCommands = [manifest.scripts?.start, manifest.scripts?.['start:prod']].filter(
    value => typeof value === 'string'
  )
  if (!startCommands.some(command => command.includes(observability.preload))) {
    errors.push(`${prefix} production start command must preload ${observability.preload}`)
  }
}

const validateLifecycle = (service, prefix, errors) => {
  const status = service.lifecycle?.status
  if (!['implemented', 'partial', 'release-ordered'].includes(status)) {
    errors.push(`${prefix} lifecycle.status is unsupported`)
  }
  requireStrings(
    service.lifecycle,
    ['shutdown', 'scaling', 'disruption', 'topology'],
    `${prefix} lifecycle`,
    errors
  )
}

const validateService = async (root, service, policy, errors) => {
  const prefix = `service ${service.name}`
  requireStrings(service, REQUIRED_SERVICE_FIELDS, prefix, errors)
  validateStringArray(service.criticalJourneys, `${prefix} criticalJourneys`, errors)
  validateStringArray(service.alerts, `${prefix} alerts`, errors)
  validateStringArray(service.corsPrefixes, `${prefix} corsPrefixes`, errors)
  if (service.publicProtocol !== true)
    errors.push(`${prefix} must remain a public protocol service`)
  for (const path of [service.path, service.operatorGuide]) {
    if (!existsSync(join(root, path))) errors.push(`${prefix} references missing ${path}`)
  }
  validateLifecycle(service, prefix, errors)
  await Promise.all([
    validateServiceDockerfile(root, service, prefix, errors),
    validateServiceEnvironment(root, service, policy.telemetry, prefix, errors),
    validateServiceObservability(root, service, policy.telemetry, prefix, errors)
  ])
}

const validatePodSecurity = (spec, prefix, errors) => {
  if (spec.automountServiceAccountToken !== false) {
    errors.push(`${prefix} must disable service-account token mounting`)
  }
  if (spec.securityContext?.runAsNonRoot !== true) {
    errors.push(`${prefix} pod must require a non-root user`)
  }
  if (spec.securityContext?.seccompProfile?.type !== 'RuntimeDefault') {
    errors.push(`${prefix} pod must use RuntimeDefault seccomp`)
  }
}

const validateContainerSecurity = (container, prefix, errors) => {
  if (container.securityContext?.allowPrivilegeEscalation !== false) {
    errors.push(`${prefix} must disable privilege escalation`)
  }
  if (container.securityContext?.readOnlyRootFilesystem !== true) {
    errors.push(`${prefix} must use a read-only root filesystem`)
  }
  if (!container.securityContext?.capabilities?.drop?.includes('ALL')) {
    errors.push(`${prefix} must drop all Linux capabilities`)
  }
  for (const field of ['startupProbe', 'readinessProbe', 'livenessProbe', 'resources']) {
    if (container[field] === undefined) errors.push(`${prefix} must define ${field}`)
  }
  const preStop = container.lifecycle?.preStop?.exec?.command
  if (
    !Array.isArray(preStop) ||
    preStop.length < 3 ||
    preStop.some(value => typeof value !== 'string' || value.trim() === '')
  ) {
    errors.push(`${prefix} must define a non-empty exec preStop hook`)
  }
}

const validateApplicationWorkload = async (root, workload, errors) => {
  const documents = await workloadDocuments(join(root, workload.manifest))
  const deployment = documents.find(document => document.kind === 'Deployment')
  const spec = deployment === undefined ? undefined : podSpec(deployment)
  const prefix = `${workload.manifest} container ${workload.container}`
  const container = spec?.containers?.find(item => item.name === workload.container)
  if (container === undefined) {
    errors.push(`${prefix} is missing`)
    return
  }
  validateContainer(container, prefix, errors)
  validatePodSecurity(spec, prefix, errors)
  validateContainerSecurity(container, prefix, errors)
  if (spec.terminationGracePeriodSeconds !== workload.terminationGracePeriodSeconds) {
    errors.push(
      `${prefix} termination grace must be ${workload.terminationGracePeriodSeconds} seconds`
    )
  }
  const expectedPreStop = ['/bin/sh', '-c', `sleep ${workload.preStopDelaySeconds}`]
  if (
    JSON.stringify(container.lifecycle?.preStop?.exec?.command) !== JSON.stringify(expectedPreStop)
  ) {
    errors.push(`${prefix} preStop must be ${JSON.stringify(expectedPreStop)}`)
  }
  if (
    !Array.isArray(spec.topologySpreadConstraints) ||
    !spec.topologySpreadConstraints.some(
      constraint => constraint.topologyKey === workload.topologyKey
    )
  ) {
    errors.push(`${prefix} must define a topology spread policy for ${workload.topologyKey}`)
  }
  requireStrings(
    workload,
    ['disruptionMode', 'autoscalingMode'],
    `${prefix} deployment posture`,
    errors
  )
  const annotations = deployment.metadata?.annotations ?? {}
  const podAnnotations = deployment.spec?.template?.metadata?.annotations ?? {}
  for (const [annotation, expected] of [
    [DISRUPTION_POLICY_ANNOTATION, workload.disruptionMode],
    [AUTOSCALING_POLICY_ANNOTATION, workload.autoscalingMode]
  ]) {
    if (annotations[annotation] !== expected || podAnnotations[annotation] !== expected) {
      errors.push(`${prefix} and its pod template must annotate ${annotation}=${expected}`)
    }
  }
}

const validateStatefulExample = async (root, example, errors) => {
  const documents = await workloadDocuments(join(root, example.manifest))
  const deployment = documents.find(
    document => document.kind === 'Deployment' && document.metadata?.name === example.workload
  )
  const prefix = `${example.manifest} Deployment/${example.workload}`
  if (deployment === undefined) {
    errors.push(`${prefix} is missing`)
    return
  }
  if (deployment.metadata?.annotations?.[STATEFUL_CLASS_ANNOTATION] !== STATEFUL_CLASS) {
    errors.push(`${prefix} must be classified ${STATEFUL_CLASS}`)
  }
}

const validatePolicy = (policy, errors) => {
  validatePublicEdge(policy.publicEdge, errors)
  requireStrings(policy.telemetry, ['implementation'], 'telemetry policy', errors)
  for (const field of [
    'environment',
    'secretEnvironment',
    'signals',
    'logFields',
    'correlationFields'
  ]) {
    validateStringArray(policy.telemetry?.[field], `telemetry policy ${field}`, errors)
  }
  requireStrings(
    policy.reliability,
    ['objectiveStatus', 'availability', 'errors', 'latency'],
    'reliability policy',
    errors
  )
  validateStringArray(policy.reliability?.dashboardPanels, 'reliability dashboardPanels', errors)
  validateStringArray(policy.incidentResponse, 'incidentResponse', errors)
  requireStrings(
    policy.deployment,
    [
      'productionDisruptionPolicy',
      'productionTopologyPolicy',
      'productionAutoscalingPolicy',
      'runtimeContract'
    ],
    'deployment policy',
    errors
  )
}

export async function validateServiceOperations(root = ROOT, { validateManifests = true } = {}) {
  const errors = []
  const registry = await readJson(join(root, 'governance/service-operations.json'))
  const containers = await readJson(join(root, 'governance/container-images.json'))

  validateRegistryShape(registry, containers, errors)
  validatePolicy(registry.policy, errors)
  for (const service of registry.services) {
    await validateService(root, service, registry.policy, errors)
  }
  if (validateManifests) {
    for (const manifestRoot of registry.manifestRoots ?? []) {
      await validateManifestRoot(root, manifestRoot, errors)
    }
    for (const workload of registry.applicationWorkloads) {
      await validateApplicationWorkload(root, workload, errors)
    }
    for (const example of registry.statefulExamples) {
      await validateStatefulExample(root, example, errors)
    }
  }

  return { errors, registry }
}

const escapeCell = value =>
  String(value)
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ')
const operatorGuideLink = path =>
  path.startsWith('docs/')
    ? `../${path.slice('docs/'.length)}`
    : `https://github.com/bsv-blockchain/ts-stack/blob/main/${path}`
const list = values => values.map(value => `- ${value}`).join('\n')
const inlineCode = values => values.map(value => `\`${value}\``).join(', ')

const renderService = service => `### ${service.name}

- Configuration: required ${inlineCode(service.configuration.required)}; optional
  ${inlineCode(service.configuration.optional)}; secret-bearing
  ${inlineCode(service.configuration.secrets)}.
- Telemetry: ${service.observability.module.toUpperCase()} bootstrap
  \`${service.observability.telemetryFile}\`, logger
  \`${service.observability.loggerFile}\`, preload
  \`${service.observability.preload}\`.
- Critical journeys:
${list(service.criticalJourneys)}
- Alerts:
${list(service.alerts)}
- State: ${service.state}
- Migration/startup: ${service.migration}
- Backup/restore: ${service.backup}
- RPO starting point: ${service.rpo}
- RTO starting point: ${service.rto}
- Restore validation: ${service.restoreValidation}
- Lifecycle status: **${service.lifecycle.status}** — ${service.lifecycle.shutdown}
- Scaling: ${service.lifecycle.scaling}
- Disruption: ${service.lifecycle.disruption}
- Topology: ${service.lifecycle.topology}
- Operator guide:
  [${service.operatorGuide}](${operatorGuideLink(service.operatorGuide)})
`

export function renderServiceOperations(registry) {
  const rows = registry.services
    .map(
      service =>
        `| \`${escapeCell(service.name)}\` | ${escapeCell(service.port)} | ` +
        `\`${escapeCell(service.livenessPath)}\` | \`${escapeCell(service.readinessPath)}\` | ` +
        `${service.lifecycle.status} | ` +
        `[guide](${operatorGuideLink(escapeCell(service.operatorGuide))}) |`
    )
    .join('\n')
  const telemetryDependencies = Object.entries(registry.policy.telemetry.dependencyVersions)
    .map(([name, version]) => `| \`${name}\` | \`${version}\` |`)
    .join('\n')
  const statefulRows = registry.statefulExamples
    .map(
      example =>
        `| \`${example.service}\` | \`${example.manifest}\` | ` +
        `\`${example.workload}\` | ${STATEFUL_CLASS} |`
    )
    .join('\n')

  return `---
id: service-operations
title: 'Service Operations Contract'
kind: reference
version: '2.0.0'
last_updated: '${registry.lastReviewed}'
last_verified: '${registry.lastReviewed}'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, operations, observability, slo, recovery]
---

# Service Operations Contract

This page is generated from \`governance/service-operations.json\`. CI verifies
all seven released services against their configuration, secret, telemetry,
container, health, lifecycle, recovery, and checked-in workload contracts.

## Public service boundary

These are public protocol services used by deployed applications, wallets,
webviews, mobile devices, opaque origins, and callers that are not known ahead
of time. Credential-free wildcard CORS is therefore the default. Exact-origin
allowlists are opt-in, cookie credentials are not enabled with wildcard origins,
and CSP remains an independent document/UI policy rather than API authorization.

## Runtime endpoints and lifecycle

| Service | Port contract | Liveness | Readiness | Lifecycle | Operations |
|---|---|---|---|---|---|
${rows}

Health endpoints are public and non-sensitive. They do not replace protocol
authentication, administrative authorization, rate limits, or dependency-aware
critical-journey monitoring.

## Observability contract

${registry.policy.telemetry.implementation}

Every service preloads telemetry before application imports and emits
${registry.policy.telemetry.signals.join(', ')}. Structured logs use
${inlineCode(registry.policy.telemetry.logFields)} and correlate through
${inlineCode(registry.policy.telemetry.correlationFields)}. Every environment
example documents ${inlineCode(registry.policy.telemetry.environment)};
\`OTEL_EXPORTER_OTLP_HEADERS\` is secret-bearing.

| Dependency | Aligned direct range |
|---|---|
${telemetryDependencies}

ESM services intentionally avoid the \`import-in-the-middle\` loader hook because
it can remove named exports from CommonJS dependencies imported as ESM. HTTP,
Express, database, and pino instrumentation remain patched through their
CommonJS dependency chains. This is a documented compatibility boundary, not an
untracked version fork.

## Reliability, dashboards, and incidents

${registry.policy.reliability.objectiveStatus}

- Availability: ${registry.policy.reliability.availability}
- Error budget: ${registry.policy.reliability.errors}
- Latency: ${registry.policy.reliability.latency}
- Required dashboard panels:
${list(registry.policy.reliability.dashboardPanels)}

Incident handling follows this evidence-preserving sequence:

${registry.policy.incidentResponse.map((step, index) => `${index + 1}. ${step}`).join('\n')}

## Service configuration, critical journeys, and recovery

${registry.services.map(renderService).join('\n')}
## Stateful example boundary

The checked-in database workloads are examples, not production database
architecture. They intentionally retain vendor initialization behavior rather
than receiving unsafe blanket application security settings. Production must
replace them with a managed database or an operator-owned stateful workload with
documented replication, backups, restore tests, upgrades, disruption handling,
capacity alerts, and credential rotation.

| Service | Manifest | Workload | Classification |
|---|---|---|---|
${statefulRows}

Application workloads retain non-root execution, RuntimeDefault seccomp, no
service-account token, dropped capabilities, read-only root filesystems, pinned
image digests, startup/readiness/liveness probes, resources, and the registered
termination grace. Production disruption, topology, and autoscaling choices must
follow the service-specific shared-state and leadership constraints above.

${registry.policy.deployment.runtimeContract}

## Release and change procedure

1. Change a service, package, Dockerfile, manifest, configuration example, or
   operator guide.
2. Update \`governance/service-operations.json\` when configuration, secret,
   signal, SLO, alert, recovery, lifecycle, or deployment behavior changes.
3. Run \`pnpm ops:docs\`, then \`pnpm ops:check\`; run affected builds, tests,
   audits, package gates, and the full repository merge gates.
4. Release dependency candidates before consumers. The standalone Overlay and
   Message Box lifecycle adapters remain compatible with the current published
   dependencies and automatically delegate to their package-owned close APIs
   once those independently reviewed packages are available.
5. Deploy only through a separately authorized release. Record exact source and
   image digests, configuration and secret names, probe and critical-journey
   evidence, migration result, telemetry delivery, backup/restore evidence, and
   rollback compatibility.
`
}

async function run() {
  const check = process.argv.includes('--check')
  if (process.argv.slice(2).some(argument => argument !== '--check')) {
    throw new Error('Usage: node scripts/service-operations.mjs [--check]')
  }
  const { errors, registry } = await validateServiceOperations()
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const { format, resolveConfig } = await import('prettier')
  const prettierConfig = (await resolveConfig(OUTPUT_PATH)) ?? {}
  const content = await format(renderServiceOperations(registry), {
    ...prettierConfig,
    filepath: OUTPUT_PATH
  })
  if (check) {
    const committed = await readFile(OUTPUT_PATH, 'utf8')
    if (committed !== content) throw new Error('service operations documentation is stale')
    console.log(`Verified ${relative(ROOT, OUTPUT_PATH)}`)
  } else {
    await writeFile(OUTPUT_PATH, content)
    console.log(`Generated ${relative(ROOT, OUTPUT_PATH)}`)
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await run()
