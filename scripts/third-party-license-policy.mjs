#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readUtf8FileIfExists, writeUtf8FileAtomic } from './file-system.mjs'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const THIRD_PARTY_REGISTRY = 'governance/third-party-materials.json'
export const LICENSE_CONTINUITY_REGISTRY = 'governance/license-continuity.json'
export const LICENSE_PROVENANCE_EVIDENCE = 'governance/license-evidence/provenance.json'

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function validateRelativePath(value, context) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some(segment => segment === '' || segment === '..')
  ) {
    throw new Error(`${context} has unsafe path ${JSON.stringify(value)}`)
  }
}

export function loadThirdPartyRegistry(root = REPOSITORY_ROOT) {
  return readJson(path.join(root, THIRD_PARTY_REGISTRY))
}

function indexById(values, context) {
  const result = new Map()
  for (const value of values ?? []) {
    if (typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error(`${context} entry has no id`)
    }
    if (result.has(value.id)) throw new Error(`${context} has duplicate id ${value.id}`)
    result.set(value.id, value)
  }
  return result
}

function distributionIndex(registry) {
  const result = new Map()
  for (const distribution of registry.distributions ?? []) {
    const distributionPath = distribution.path
    if (typeof distributionPath !== 'string' || distributionPath.length === 0) {
      throw new Error('distribution has no path')
    }
    if (distributionPath !== '.') validateRelativePath(distributionPath, 'distribution')
    if (result.has(distributionPath)) {
      throw new Error(`duplicate distribution path ${distributionPath}`)
    }
    result.set(distributionPath, distribution)
  }
  return result
}

function materialIdsForDistribution(registry, distribution, distributions, seen = new Set()) {
  if (seen.has(distribution.path)) {
    throw new Error(`distribution inheritance cycle at ${distribution.path}`)
  }
  const nextSeen = new Set(seen).add(distribution.path)
  if (distribution.inherits !== undefined) {
    const inherited = distributions.get(distribution.inherits)
    if (inherited === undefined) {
      throw new Error(`${distribution.path} inherits unknown distribution ${distribution.inherits}`)
    }
    const inheritedIds = materialIdsForDistribution(registry, inherited, distributions, nextSeen)
    const ownIds = Array.isArray(distribution.materials) ? distribution.materials : []
    return [...new Set([...inheritedIds, ...ownIds])]
  }
  if (distribution.materials === 'all') return registry.materials.map(material => material.id)
  if (!Array.isArray(distribution.materials)) {
    throw new TypeError(`${distribution.path} must declare materials or inherits`)
  }
  return [...distribution.materials]
}

function clearanceApplies(clearance, materialIds, rootDistribution) {
  if (rootDistribution || clearance.materials.length === 0) return true
  return clearance.materials.some(id => materialIds.has(id))
}

function renderMaterial(material, licenseTexts) {
  const lines = [
    `## ${material.name} (${material.version})`,
    '',
    `- License: \`${material.licenseExpression}\``,
    `- Use in this stack: ${material.incorporation}`,
    `- Upstream: ${material.source}`
  ]
  if (material.licenseText === null) {
    lines.push('- License text: not preserved by the upstream source; see the clearance section')
  } else {
    const license = licenseTexts.get(material.licenseText)
    if (license === undefined) throw new Error(`${material.id} references unknown license text`)
    lines.push(
      `- License text: [${path.basename(license.path)}](./LICENSES/${path.basename(license.path)})`
    )
  }
  lines.push('- Incorporated paths:')
  for (const sourcePath of material.paths) lines.push(`  - \`${sourcePath}\``)
  lines.push('', ...material.copyright, '')
  return lines
}

export function renderThirdPartyNotice(registry, distributionPath) {
  const materials = indexById(registry.materials, 'materials')
  const licenseTexts = indexById(registry.licenseTexts, 'licenseTexts')
  const distributions = distributionIndex(registry)
  const distribution = distributions.get(distributionPath)
  if (distribution === undefined) throw new Error(`unknown distribution ${distributionPath}`)
  const materialIds = new Set(
    materialIdsForDistribution(registry, distribution, distributions).sort((left, right) =>
      left.localeCompare(right)
    )
  )
  const clearances = (registry.clearances ?? []).filter(clearance =>
    clearanceApplies(clearance, materialIds, distributionPath === '.')
  )
  const lines = [
    '<!-- Generated by scripts/third-party-license-policy.mjs. Do not edit by hand. -->',
    '',
    '# Third-Party Notices',
    '',
    'The Open BSV License Version 6 in `LICENSE.txt` applies to current TS Stack',
    'first-party contributions. It does not replace, narrow, or relicense historical',
    'or third-party material identified below. Each identified portion remains available',
    'under its stated terms.',
    '',
    'Distributors must keep this file and the referenced `LICENSES/` files with source,',
    'npm tarballs, browser bundles, WebAssembly artifacts, and container images that',
    'contain the corresponding material. Ordinary dependency licenses remain with those',
    'dependencies and are additionally inventoried in release SBOMs.',
    '',
    `Registry: \`${THIRD_PARTY_REGISTRY}\``,
    '',
    '## Release clearance status',
    ''
  ]
  if (clearances.length === 0) {
    lines.push('No unresolved clearance item is scoped to this distribution.', '')
  } else {
    lines.push(
      'The notices below reduce attribution risk but do not create rights. A release is',
      'blocked while any item marked `required` remains unresolved.',
      ''
    )
    for (const clearance of clearances) {
      lines.push(
        `- **${clearance.id} — ${clearance.status}:** ${clearance.finding}`,
        `  Accepted evidence: ${clearance.acceptedEvidence}`
      )
    }
    lines.push('')
  }
  for (const id of materialIds) {
    const material = materials.get(id)
    if (material === undefined)
      throw new Error(`${distributionPath} references unknown material ${id}`)
    lines.push(...renderMaterial(material, licenseTexts))
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function requiredLicenses(registry, distribution, distributions, materials, licenseTexts) {
  const ids = materialIdsForDistribution(registry, distribution, distributions)
  const result = new Map()
  for (const id of ids) {
    const material = materials.get(id)
    if (material === undefined)
      throw new Error(`${distribution.path} references unknown material ${id}`)
    if (material.licenseText === null) continue
    const license = licenseTexts.get(material.licenseText)
    if (license === undefined)
      throw new Error(`${id} references unknown license ${material.licenseText}`)
    result.set(path.basename(license.path), license)
  }
  return [...result.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function expectedThirdPartyFilesForPackage(packageName, root = REPOSITORY_ROOT) {
  const registry = loadThirdPartyRegistry(root)
  const materials = indexById(registry.materials, 'materials')
  const licenseTexts = indexById(registry.licenseTexts, 'licenseTexts')
  const distributions = distributionIndex(registry)
  const distribution = [...distributions.values()].find(item => item.packageName === packageName)
  if (distribution === undefined) return []
  const licenses = requiredLicenses(registry, distribution, distributions, materials, licenseTexts)
  return [
    registry.policy.noticeFile,
    ...licenses.map(
      license => `${registry.policy.licensesDirectory}/${path.basename(license.path)}`
    )
  ]
}

export function thirdPartyComponentsForPackage(packageName, root = REPOSITORY_ROOT) {
  const registry = loadThirdPartyRegistry(root)
  const materials = indexById(registry.materials, 'materials')
  const distributions = distributionIndex(registry)
  const distribution = [...distributions.values()].find(item => item.packageName === packageName)
  if (distribution === undefined) return []
  return materialIdsForDistribution(registry, distribution, distributions)
    .map(id => materials.get(id))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(material => ({
      type: 'library',
      'bom-ref': `urn:ts-stack:incorporated:${material.id}`,
      name: material.name,
      version: material.version,
      licenses: [{ license: { name: material.licenseExpression } }],
      externalReferences: [{ type: 'vcs', url: material.source }],
      properties: [
        { name: 'org.bsvblockchain.incorporated-material.id', value: material.id },
        {
          name: 'org.bsvblockchain.incorporated-material.form',
          value: material.incorporation
        },
        {
          name: 'org.bsvblockchain.incorporated-material.paths',
          value: material.paths.join(',')
        }
      ]
    }))
}

function synchronizeManifest(directory, registry, licenses) {
  const manifestPath = path.join(directory, 'package.json')
  const manifestSource = readUtf8FileIfExists(manifestPath)
  if (manifestSource === undefined) return
  const manifest = JSON.parse(manifestSource)
  if (!Array.isArray(manifest.files)) return
  const managed = new Set([registry.policy.noticeFile, registry.policy.licensesDirectory])
  const required = [registry.policy.noticeFile]
  if (licenses.length > 0) required.push(registry.policy.licensesDirectory)
  manifest.files = [...manifest.files.filter(entry => !managed.has(entry)), ...required]
  writeUtf8FileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export function synchronizeThirdPartyMaterials(root = REPOSITORY_ROOT) {
  const registry = loadThirdPartyRegistry(root)
  const materials = indexById(registry.materials, 'materials')
  const licenseTexts = indexById(registry.licenseTexts, 'licenseTexts')
  const distributions = distributionIndex(registry)
  for (const distribution of distributions.values()) {
    const directory = distribution.path === '.' ? root : path.join(root, distribution.path)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      path.join(directory, registry.policy.noticeFile),
      renderThirdPartyNotice(registry, distribution.path)
    )
    const licenses = requiredLicenses(
      registry,
      distribution,
      distributions,
      materials,
      licenseTexts
    )
    if (distribution.path !== '.') {
      const licensesDirectory = path.join(directory, registry.policy.licensesDirectory)
      fs.rmSync(licensesDirectory, { recursive: true, force: true })
      if (licenses.length > 0) fs.mkdirSync(licensesDirectory, { recursive: true })
      for (const license of licenses) {
        fs.copyFileSync(
          path.join(root, license.path),
          path.join(licensesDirectory, path.basename(license.path))
        )
      }
      synchronizeManifest(directory, registry, licenses)
    }
  }
}

function validateRegistryShape(registry, errors) {
  if (registry.schemaVersion !== 1) errors.push('third-party registry schemaVersion must be 1')
  if (registry.policy?.firstPartyLicense !== 'LicenseRef-Open-BSV-License-6') {
    errors.push('third-party registry first-party license must remain scoped to Open BSV v6')
  }
  if (registry.policy?.noticeFile !== 'THIRD_PARTY_NOTICES.md') {
    errors.push('third-party registry notice file must be THIRD_PARTY_NOTICES.md')
  }
  if (registry.policy?.licensesDirectory !== 'LICENSES') {
    errors.push('third-party registry licenses directory must be LICENSES')
  }
  if (registry.policy?.releaseRequiresAllClearances !== true) {
    errors.push('third-party registry must require every release clearance')
  }
  if (registry.policy?.evidenceFilesRequired !== true) {
    errors.push('third-party registry must require hash-pinned evidence files')
  }
  if (registry.policy?.licenseContinuityFile !== LICENSE_CONTINUITY_REGISTRY) {
    errors.push(`third-party registry continuity file must be ${LICENSE_CONTINUITY_REGISTRY}`)
  }
  if (registry.policy?.licenseProvenanceFile !== LICENSE_PROVENANCE_EVIDENCE) {
    errors.push(`third-party registry provenance file must be ${LICENSE_PROVENANCE_EVIDENCE}`)
  }
  if (!Array.isArray(registry.policy?.forbiddenUnlicensedArtifacts)) {
    errors.push('third-party registry must identify forbidden unlicensed artifacts')
  }
}

function validateForbiddenUnlicensedArtifacts(root, registry, errors) {
  const forbidden = registry.policy?.forbiddenUnlicensedArtifacts
  if (!Array.isArray(forbidden)) return
  for (const artifact of forbidden) {
    try {
      validateRelativePath(artifact, 'forbidden unlicensed artifact')
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (fs.existsSync(path.join(root, artifact))) {
      errors.push(`forbidden unlicensed artifact is present: ${artifact}`)
    }
  }
}

function validateEvidenceFiles(root, registry, errors) {
  let evidenceFiles
  try {
    evidenceFiles = indexById(registry.evidenceFiles, 'evidenceFiles')
  } catch (error) {
    errors.push(error.message)
    return
  }
  for (const evidence of evidenceFiles.values()) {
    try {
      validateRelativePath(evidence.path, `evidence ${evidence.id}`)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (!evidence.path.startsWith('governance/')) {
      errors.push(`${evidence.id} evidence must remain under governance/`)
    }
    const evidencePath = path.join(root, evidence.path)
    if (!fs.existsSync(evidencePath)) {
      errors.push(`${evidence.path} is missing`)
      continue
    }
    const actual = sha256(fs.readFileSync(evidencePath))
    if (actual !== evidence.sha256) {
      errors.push(`${evidence.path} hash is ${actual}, expected ${evidence.sha256}`)
    }
  }
  for (const requiredPath of [LICENSE_CONTINUITY_REGISTRY, LICENSE_PROVENANCE_EVIDENCE]) {
    if (![...evidenceFiles.values()].some(evidence => evidence.path === requiredPath)) {
      errors.push(`${requiredPath} is not hash-pinned by the third-party registry`)
    }
  }
}

function validateContinuitySnapshot(continuity, snapshot, errors) {
  if (continuity.schemaVersion !== 1) errors.push('license continuity schemaVersion must be 1')
  for (const field of ['uniformizationCommit', 'parentCommit']) {
    if (typeof snapshot[field] !== 'string' || !/^[0-9a-f]{40}$/.test(snapshot[field])) {
      errors.push(`license continuity snapshot has invalid ${field}`)
    }
  }
}

function validateContinuityRecordPath(record, seenPaths, errors) {
  try {
    validateRelativePath(record.path, 'license continuity record')
    if (record.scope !== '.') validateRelativePath(record.scope, 'license continuity scope')
  } catch (error) {
    errors.push(error.message)
    return false
  }
  if (seenPaths.has(record.path)) errors.push(`license continuity repeats ${record.path}`)
  seenPaths.add(record.path)
  if (typeof record.gitBlobSha1 !== 'string' || !/^[0-9a-f]{40}$/.test(record.gitBlobSha1)) {
    errors.push(`license continuity has invalid Git blob for ${record.path}`)
  }
  return true
}

function validateContinuityRecordScope(record, materials, licenseTexts, errors) {
  if (record.kind === 'licensing-policy') {
    if (record.licenseText !== null) {
      errors.push(`${record.path} is a policy record but references a license text`)
    }
    return
  }
  if (record.kind !== 'license') {
    errors.push(`${record.path} has invalid continuity kind ${record.kind}`)
    return
  }
  if (!licenseTexts.has(record.licenseText)) {
    errors.push(`${record.path} continuity references unknown license ${record.licenseText}`)
    return
  }
  const covered = [...materials.values()].some(
    material =>
      material.licenseText === record.licenseText &&
      material.paths.some(
        sourcePath => sourcePath === record.scope || sourcePath.startsWith(`${record.scope}/`)
      )
  )
  if (!covered) {
    errors.push(`${record.path} prior license is not scoped by an incorporated-material record`)
  }
}

function validateLicenseContinuity(root, registry, materials, licenseTexts, errors) {
  let continuity
  try {
    continuity = readJson(path.join(root, registry.policy.licenseContinuityFile))
  } catch (error) {
    errors.push(`license continuity registry is unreadable: ${error.message}`)
    return
  }
  const snapshot = continuity.snapshot ?? {}
  validateContinuitySnapshot(continuity, snapshot, errors)
  if (!Array.isArray(continuity.priorFiles)) {
    errors.push('license continuity registry has no priorFiles inventory')
    return
  }
  if (snapshot.preexistingLicenseOrPolicyFiles !== continuity.priorFiles.length) {
    errors.push('license continuity prior-file count does not match its snapshot summary')
  }
  const seenPaths = new Set()
  let modified = 0
  let removed = 0
  for (const record of continuity.priorFiles) {
    if (!validateContinuityRecordPath(record, seenPaths, errors)) continue
    if (record.uniformizationAction === 'modified') modified += 1
    else if (record.uniformizationAction === 'removed-or-renamed') removed += 1
    else errors.push(`license continuity has invalid action for ${record.path}`)
    validateContinuityRecordScope(record, materials, licenseTexts, errors)
  }
  if (snapshot.preexistingTextsModified !== modified) {
    errors.push('license continuity modified count does not match its snapshot summary')
  }
  if (snapshot.preexistingTextsRemovedOrRenamed !== removed) {
    errors.push('license continuity removed count does not match its snapshot summary')
  }
}

function validateProvenanceEvidence(root, registry, materials, errors) {
  let provenance
  try {
    provenance = readJson(path.join(root, registry.policy.licenseProvenanceFile))
  } catch (error) {
    errors.push(`license provenance evidence is unreadable: ${error.message}`)
    return
  }
  if (provenance.schemaVersion !== 1) errors.push('license provenance schemaVersion must be 1')
  let records
  try {
    records = indexById(provenance.records, 'provenance records')
  } catch (error) {
    errors.push(error.message)
    return
  }
  for (const id of [
    'aes-gcm-js',
    'bsv-2.0.10',
    'legacy-chaintracks-server',
    'legacy-fund-wallet',
    'legacy-message-box-server',
    'legacy-ts-p2p',
    'runar-r1k1-wallet-artifact'
  ]) {
    if (!materials.has(id)) continue
    const record = records.get(id)
    if (record === undefined) {
      errors.push(`license provenance is missing ${id}`)
      continue
    }
    if (record.conclusion !== 'cleared') {
      errors.push(`license provenance ${id} is not cleared`)
    }
    const material = materials.get(id)
    if (material === undefined || record.license !== material.licenseExpression) {
      errors.push(`license provenance ${id} does not match the incorporated-material registry`)
    }
    if (record.notice !== material?.copyright?.[0]) {
      errors.push(
        `license provenance ${id} notice does not match the incorporated-material registry`
      )
    }
  }
}

function validateLicenseTexts(root, licenseTexts, errors) {
  const basenames = new Map()
  for (const license of licenseTexts.values()) {
    try {
      validateRelativePath(license.path, `license ${license.id}`)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    const licensePath = path.join(root, license.path)
    if (!fs.existsSync(licensePath)) {
      errors.push(`${license.path} is missing`)
      continue
    }
    const actual = sha256(fs.readFileSync(licensePath))
    if (actual !== license.sha256) {
      errors.push(`${license.path} hash is ${actual}, expected ${license.sha256}`)
    }
    if (typeof license.source !== 'string' || license.source.length === 0) {
      errors.push(`${license.id} has no authoritative source`)
    }
    const basename = path.basename(license.path)
    if (basenames.has(basename)) {
      errors.push(`${license.id} and ${basenames.get(basename)} share license basename ${basename}`)
    }
    basenames.set(basename, license.id)
  }
}

function validateMaterialMetadata(material, licenseTexts, errors) {
  for (const field of ['name', 'version', 'licenseExpression', 'incorporation']) {
    if (typeof material[field] !== 'string' || material[field].length === 0) {
      errors.push(`${material.id} has no ${field}`)
    }
  }
  if (typeof material.source !== 'string' || !material.source.startsWith('https://')) {
    errors.push(`${material.id} must identify an HTTPS upstream source`)
  }
  if (
    !Array.isArray(material.copyright) ||
    material.copyright.length === 0 ||
    material.copyright.some(notice => typeof notice !== 'string' || notice.length === 0)
  ) {
    errors.push(`${material.id} has no complete copyright or attribution notice`)
  }
  if (material.licenseText !== null && !licenseTexts.has(material.licenseText)) {
    errors.push(`${material.id} references unknown license ${material.licenseText}`)
  }
}

function validateMaterialPaths(root, material, errors) {
  if (!Array.isArray(material.paths) || material.paths.length === 0) {
    errors.push(`${material.id} has no incorporated paths`)
    return
  }
  for (const sourcePath of material.paths) {
    try {
      validateRelativePath(sourcePath, `material ${material.id}`)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (!fs.existsSync(path.join(root, sourcePath))) {
      errors.push(`${material.id} incorporated path is missing: ${sourcePath}`)
    }
  }
  if (new Set(material.paths).size !== material.paths.length) {
    errors.push(`${material.id} repeats an incorporated path`)
  }
}

function validateMaterials(root, materials, licenseTexts, errors) {
  for (const material of materials.values()) {
    validateMaterialMetadata(material, licenseTexts, errors)
    validateMaterialPaths(root, material, errors)
  }
}

function registerDistributionPackageName(distribution, packageNames, errors) {
  if (distribution.packageName === undefined) return
  if (packageNames.has(distribution.packageName)) {
    errors.push(
      `${distribution.path} and ${packageNames.get(distribution.packageName)} share package name ${distribution.packageName}`
    )
  }
  packageNames.set(distribution.packageName, distribution.path)
}

function collectCoveredDistributionMaterials(
  registry,
  distribution,
  distributions,
  coveredMaterials,
  errors
) {
  if (distribution.path === '.') return
  try {
    for (const id of materialIdsForDistribution(registry, distribution, distributions)) {
      coveredMaterials.add(id)
    }
  } catch (error) {
    errors.push(error.message)
  }
}

function validateDistributionCoverage(registry, distributions, materials, errors) {
  if (distributions.get('.')?.materials !== 'all') {
    errors.push('root distribution must include all incorporated material')
  }
  const packageNames = new Map()
  const coveredMaterials = new Set()
  for (const distribution of distributions.values()) {
    registerDistributionPackageName(distribution, packageNames, errors)
    collectCoveredDistributionMaterials(
      registry,
      distribution,
      distributions,
      coveredMaterials,
      errors
    )
  }
  for (const id of materials.keys()) {
    if (!coveredMaterials.has(id)) errors.push(`${id} has no non-root distribution target`)
  }
}

function resolveDistributionPayload(
  registry,
  distribution,
  distributions,
  materials,
  licenseTexts,
  errors
) {
  try {
    return {
      expectedNotice: renderThirdPartyNotice(registry, distribution.path),
      licenses: requiredLicenses(registry, distribution, distributions, materials, licenseTexts)
    }
  } catch (error) {
    errors.push(error.message)
    return null
  }
}

function validateDistributionNotice(root, directory, registry, expectedNotice, errors) {
  const noticePath = path.join(directory, registry.policy.noticeFile)
  if (!fs.existsSync(noticePath) || fs.readFileSync(noticePath, 'utf8') !== expectedNotice) {
    errors.push(`${posixPath(path.relative(root, noticePath))} is missing or stale`)
  }
}

function validateDistributionLicenseFiles(root, licensesDirectory, licenses, errors) {
  const expectedLicenseNames = new Set(licenses.map(license => path.basename(license.path)))
  if (fs.existsSync(licensesDirectory)) {
    for (const entry of fs.readdirSync(licensesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !expectedLicenseNames.has(entry.name)) {
        errors.push(
          `${posixPath(path.relative(root, path.join(licensesDirectory, entry.name)))} is unexpected`
        )
      }
    }
  }
  for (const license of licenses) {
    const target = path.join(licensesDirectory, path.basename(license.path))
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== license.sha256) {
      errors.push(`${posixPath(path.relative(root, target))} is missing or stale`)
    }
  }
}

function validateDistributionManifestAllowlist(distribution, registry, licenses, manifest, errors) {
  if (!Array.isArray(manifest.files)) return
  if (!manifest.files.includes(registry.policy.noticeFile)) {
    errors.push(`${distribution.path} files allowlist omits ${registry.policy.noticeFile}`)
  }
  if (licenses.length > 0 && !manifest.files.includes(registry.policy.licensesDirectory)) {
    errors.push(`${distribution.path} files allowlist omits ${registry.policy.licensesDirectory}`)
  }
  if (licenses.length === 0 && manifest.files.includes(registry.policy.licensesDirectory)) {
    errors.push(`${distribution.path} files allowlist retains an unused licenses directory`)
  }
}

function validateDistributionManifest(directory, distribution, registry, licenses, errors) {
  const manifestPath = path.join(directory, 'package.json')
  if (!fs.existsSync(manifestPath)) return
  const manifest = readJson(manifestPath)
  if (distribution.packageName !== undefined && manifest.name !== distribution.packageName) {
    errors.push(`${distribution.path} package name does not match ${distribution.packageName}`)
  }
  validateDistributionManifestAllowlist(distribution, registry, licenses, manifest, errors)
}

function validateDistribution(
  root,
  registry,
  distribution,
  distributions,
  materials,
  licenseTexts,
  errors
) {
  const directory = distribution.path === '.' ? root : path.join(root, distribution.path)
  if (!fs.existsSync(directory)) {
    errors.push(`distribution directory is missing: ${distribution.path}`)
    return
  }
  const payload = resolveDistributionPayload(
    registry,
    distribution,
    distributions,
    materials,
    licenseTexts,
    errors
  )
  if (payload === null) return
  validateDistributionNotice(root, directory, registry, payload.expectedNotice, errors)
  if (distribution.path === '.') return
  const licensesDirectory = path.join(directory, registry.policy.licensesDirectory)
  validateDistributionLicenseFiles(root, licensesDirectory, payload.licenses, errors)
  validateDistributionManifest(directory, distribution, registry, payload.licenses, errors)
}

function loadValidationContext(root, errors) {
  const registry = loadThirdPartyRegistry(root)
  validateRegistryShape(registry, errors)
  return {
    registry,
    materials: indexById(registry.materials, 'materials'),
    licenseTexts: indexById(registry.licenseTexts, 'licenseTexts'),
    distributions: distributionIndex(registry)
  }
}

function validateClearanceFields(clearance, clearanceIds, errors) {
  if (typeof clearance.id !== 'string' || clearance.id.length === 0) {
    errors.push('clearance has no id')
    return false
  }
  if (clearanceIds.has(clearance.id)) errors.push(`duplicate clearance id ${clearance.id}`)
  clearanceIds.add(clearance.id)
  if (!['required', 'cleared'].includes(clearance.status)) {
    errors.push(`${clearance.id} has invalid status ${clearance.status}`)
  }
  if (typeof clearance.finding !== 'string' || clearance.finding.length === 0) {
    errors.push(`${clearance.id} has no finding`)
  }
  if (typeof clearance.acceptedEvidence !== 'string' || clearance.acceptedEvidence.length === 0) {
    errors.push(`${clearance.id} has no accepted evidence`)
  }
  return true
}

function validateClearanceMaterials(clearance, materialIds, clearanceMaterialIds, errors) {
  if (!Array.isArray(clearance.materials)) {
    errors.push(`${clearance.id} has no material list`)
    return
  }
  for (const materialId of clearance.materials) {
    clearanceMaterialIds.add(materialId)
    if (!materialIds.has(materialId)) {
      errors.push(`${clearance.id} references unknown material ${materialId}`)
    }
  }
}

function validateClearances(registry, materials, errors, release) {
  const materialIds = new Set(materials.keys())
  const clearanceIds = new Set()
  const clearanceMaterialIds = new Set()
  for (const clearance of registry.clearances ?? []) {
    if (!validateClearanceFields(clearance, clearanceIds, errors)) continue
    validateClearanceMaterials(clearance, materialIds, clearanceMaterialIds, errors)
    if (release && clearance.status !== 'cleared') {
      errors.push(`release blocked by clearance ${clearance.id}: ${clearance.finding}`)
    }
  }
  for (const material of materials.values()) {
    if (material.licenseText === null && !clearanceMaterialIds.has(material.id)) {
      errors.push(`${material.id} has no retained license text and no rights clearance`)
    }
  }
}

export function validateThirdPartyMaterials(root = REPOSITORY_ROOT, options = {}) {
  const errors = []
  let context
  try {
    context = loadValidationContext(root, errors)
  } catch (error) {
    return [...errors, error.message]
  }
  const { registry, materials, licenseTexts, distributions } = context
  validateLicenseTexts(root, licenseTexts, errors)
  validateMaterials(root, materials, licenseTexts, errors)
  validateEvidenceFiles(root, registry, errors)
  validateLicenseContinuity(root, registry, materials, licenseTexts, errors)
  validateProvenanceEvidence(root, registry, materials, errors)
  validateForbiddenUnlicensedArtifacts(root, registry, errors)
  validateDistributionCoverage(registry, distributions, materials, errors)
  for (const distribution of distributions.values()) {
    validateDistribution(
      root,
      registry,
      distribution,
      distributions,
      materials,
      licenseTexts,
      errors
    )
  }
  validateClearances(registry, materials, errors, options.release === true)
  return errors
}

function main() {
  const write = process.argv.includes('--write')
  const release = process.argv.includes('--release')
  if (write) synchronizeThirdPartyMaterials()
  const errors = validateThirdPartyMaterials(REPOSITORY_ROOT, { release })
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
    return
  }
  const registry = loadThirdPartyRegistry()
  console.log(
    `Verified ${registry.materials.length} incorporated material records across ` +
      `${registry.distributions.length} distributions${release ? ' for release' : ''}.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
