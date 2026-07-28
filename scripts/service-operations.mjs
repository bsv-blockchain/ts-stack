#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT_PATH = join(ROOT, 'docs/reference/service-operations.md')
const DIGEST_IMAGE = /@sha256:[0-9a-f]{64}$/
const SECRET_NAME =
  /(password|private.?key|secret|token|api.?key|credential|knex.?url|mongo.?url|db.?pass|connection)/i

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

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
      SECRET_NAME.test(environment.name ?? '') &&
      typeof environment.value === 'string' &&
      environment.value !== ''
    ) {
      errors.push(`${prefix} ${environment.name} must not contain a literal value`)
    }
  }
}

export async function validateServiceOperations(root = ROOT) {
  const errors = []
  const registry = await readJson(join(root, 'governance/service-operations.json'))
  const containers = await readJson(join(root, 'governance/container-images.json'))

  if (registry.schemaVersion !== 1) errors.push('service-operations schemaVersion must be 1')
  const governedNames = containers.components.map(component => component.name).sort()
  const serviceNames = registry.services.map(service => service.name).sort()
  if (JSON.stringify(governedNames) !== JSON.stringify(serviceNames)) {
    errors.push('service-operations services must exactly match container-images components')
  }

  for (const manifestRoot of registry.manifestRoots ?? []) {
    const absoluteRoot = join(root, manifestRoot)
    if (!existsSync(absoluteRoot)) {
      errors.push(`service-operations references missing manifest root ${manifestRoot}`)
      continue
    }
    for (const manifest of await manifestFiles(absoluteRoot)) {
      for (const document of await yamlDocuments(manifest)) {
        const manifestName = `${relative(root, manifest)} ${document.kind}/${document.metadata?.name}`
        if (document.kind === 'Secret') {
          errors.push(`${manifestName} must not be checked in`)
        }
        if (document.kind === 'ConfigMap') {
          for (const [name, value] of Object.entries(document.data ?? {})) {
            if (SECRET_NAME.test(name) && typeof value === 'string' && value !== '') {
              errors.push(`${manifestName} ${name} must not contain secret material`)
            }
          }
        }
        const spec = podSpec(document)
        if (spec === undefined) continue
        const workload = manifestName
        if (spec.automountServiceAccountToken !== false) {
          errors.push(`${workload} must disable service-account token mounting`)
        }
        for (const container of [...(spec.initContainers ?? []), ...(spec.containers ?? [])]) {
          validateContainer(container, `${workload} container ${container.name}`, errors)
        }
      }
    }
  }

  for (const service of registry.services) {
    const prefix = `service ${service.name}`
    for (const field of [
      'path',
      'port',
      'livenessPath',
      'readinessPath',
      'state',
      'migration',
      'backup',
      'operatorGuide'
    ]) {
      if (typeof service[field] !== 'string' || service[field].trim() === '') {
        errors.push(`${prefix} must define ${field}`)
      }
    }
    for (const path of [service.path, service.operatorGuide]) {
      if (!existsSync(join(root, path))) errors.push(`${prefix} references missing ${path}`)
    }
    const dockerfilePath = join(root, service.path, 'Dockerfile')
    if (!existsSync(dockerfilePath)) {
      errors.push(`${prefix} is missing Dockerfile`)
      continue
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
  }

  for (const workload of registry.applicationWorkloads) {
    const documents = await workloadDocuments(join(root, workload.manifest))
    const deployment = documents.find(document => document.kind === 'Deployment')
    const spec = deployment === undefined ? undefined : podSpec(deployment)
    const prefix = `${workload.manifest} container ${workload.container}`
    const container = spec?.containers?.find(item => item.name === workload.container)
    if (container === undefined) {
      errors.push(`${prefix} is missing`)
      continue
    }
    validateContainer(container, prefix, errors)
    if (spec.automountServiceAccountToken !== false) {
      errors.push(`${prefix} must disable service-account token mounting`)
    }
    if (spec.securityContext?.runAsNonRoot !== true) {
      errors.push(`${prefix} pod must require a non-root user`)
    }
    if (spec.securityContext?.seccompProfile?.type !== 'RuntimeDefault') {
      errors.push(`${prefix} pod must use RuntimeDefault seccomp`)
    }
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

export function renderServiceOperations(registry) {
  const rows = registry.services
    .map(
      service =>
        `| \`${escapeCell(service.name)}\` | ${escapeCell(service.port)} | ` +
        `\`${escapeCell(service.livenessPath)}\` | \`${escapeCell(service.readinessPath)}\` | ` +
        `[guide](${operatorGuideLink(escapeCell(service.operatorGuide))}) |`
    )
    .join('\n')
  const recovery = registry.services
    .map(
      service =>
        `### ${service.name}\n\n` +
        `- State: ${service.state}\n` +
        `- Migration/startup: ${service.migration}\n` +
        `- Backup/restore: ${service.backup}\n` +
        `- Operator guide: [${service.operatorGuide}](${operatorGuideLink(service.operatorGuide)})\n`
    )
    .join('\n')

  return `---
id: service-operations
title: 'Service Operations Contract'
kind: reference
version: '1.0.0'
last_updated: '${registry.lastReviewed}'
last_verified: '${registry.lastReviewed}'
review_cadence_days: 30
status: stable
tags: [reference, infrastructure, operations, health, recovery]
---

# Service Operations Contract

This page is generated from \`governance/service-operations.json\`. CI verifies
that all seven released services have a non-root, digest-pinned container with a
real health check and that checked-in application workloads retain startup,
readiness, liveness, resources, seccomp, dropped capabilities, a read-only root
filesystem, and secret indirection.

## Runtime endpoints

| Service | Port contract | Liveness | Readiness | Operations |
|---|---|---|---|---|
${rows}

Health endpoints are public and non-sensitive. They do not replace protocol
authentication or rate limits. Public services retain wildcard,
credential-free CORS by default; CSP remains a separate document/UI policy.

## State, migration, and recovery

${recovery}
## Change procedure

1. Change a service, Dockerfile, manifest, or operator guide.
2. Update \`governance/service-operations.json\` when the operational contract changes.
3. Run \`pnpm ops:docs\`, then \`pnpm ops:check\`.
4. Run the affected service tests and the full repository health, container,
   documentation, security, and merge gates.
5. Deploy only through a separately authorized release and record the exact image
   digest, probe evidence, migration result, backup, and rollback outcome.
`
}

async function run() {
  const check = process.argv.includes('--check')
  if (process.argv.slice(2).some(argument => argument !== '--check')) {
    throw new Error('Usage: node scripts/service-operations.mjs [--check]')
  }
  const { errors, registry } = await validateServiceOperations()
  if (errors.length > 0) throw new Error(errors.join('\n'))
  const content = renderServiceOperations(registry)
  if (check) {
    const committed = await readFile(OUTPUT_PATH, 'utf8')
    if (committed !== content) throw new Error('service operations documentation is stale')
    console.log(`Verified ${relative(ROOT, OUTPUT_PATH)}`)
  } else {
    await writeFile(OUTPUT_PATH, content)
    console.log(`Generated ${relative(ROOT, OUTPUT_PATH)}`)
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await run()
