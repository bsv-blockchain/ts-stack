#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const LICENSE_DECLARATION = 'SEE LICENSE IN LICENSE.txt'
export const LICENSE_FILE = 'LICENSE.txt'
export const LICENSE_VERSION = 6
export const OCI_LICENSE_REFERENCE = `LicenseRef-Open-BSV-License-${LICENSE_VERSION}`
export const EXPECTED_LICENSE_SHA256 =
  'bac995a0c84dd533f7d5335b6d870aae9fee7d28d189b8aa78b103e0c9932bc0'

const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.pagefind',
  '.ssr',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'out'
])
const LEGACY_LICENSE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'license.md',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt'
]
const LICENSE_ENTRY_PATTERN = /^(?:licen[cs]e)(?:\.(?:md|txt))?$/i

function relativePath(filePath, root = REPOSITORY_ROOT) {
  const relative = path.relative(root, filePath).split(path.sep).join('/')
  return relative === '' ? '.' : relative
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function findPackageManifests(directory, results) {
  const manifestPath = path.join(directory, 'package.json')
  if (fs.existsSync(manifestPath)) results.push(manifestPath)

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue
    findPackageManifests(path.join(directory, entry.name), results)
  }
}

export function discoverPackageManifests(root = REPOSITORY_ROOT) {
  const manifests = []
  findPackageManifests(root, manifests)
  return manifests.sort((left, right) => left.localeCompare(right))
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validateCanonicalLicense(root) {
  const canonicalPath = path.join(root, LICENSE_FILE)
  if (!fs.existsSync(canonicalPath)) {
    return {
      errors: [`${LICENSE_FILE} is missing from the repository root`],
      canonical: null
    }
  }

  const canonical = fs.readFileSync(canonicalPath)
  const actualHash = sha256(canonical)
  const errors = []
  if (actualHash !== EXPECTED_LICENSE_SHA256) {
    errors.push(
      `${LICENSE_FILE} must be the exact Open BSV License Version ${LICENSE_VERSION} ` +
        `text (${EXPECTED_LICENSE_SHA256}); received ${actualHash}`
    )
  }
  return { errors, canonical }
}

function normalizeFilesAllowlist(files) {
  if (!Array.isArray(files)) return files
  return [
    ...files.filter(entry => typeof entry !== 'string' || !LICENSE_ENTRY_PATTERN.test(entry)),
    LICENSE_FILE
  ]
}

function packageLockPath(directory) {
  const candidate = path.join(directory, 'package-lock.json')
  return fs.existsSync(candidate) ? candidate : null
}

function synchronizeManifest(manifestPath) {
  const manifest = readJson(manifestPath)
  manifest.license = LICENSE_DECLARATION
  if (Array.isArray(manifest.files)) {
    manifest.files = normalizeFilesAllowlist(manifest.files)
  }
  writeJson(manifestPath, manifest)
}

function synchronizeLicenseFiles(directory, root, canonical) {
  const projectLicensePath = path.join(directory, LICENSE_FILE)
  if (projectLicensePath !== path.join(root, LICENSE_FILE)) {
    fs.writeFileSync(projectLicensePath, canonical)
  }
  for (const legacyFile of LEGACY_LICENSE_FILES) {
    const legacyPath = path.join(directory, legacyFile)
    if (fs.existsSync(legacyPath)) fs.rmSync(legacyPath)
  }
}

function synchronizePackageLock(directory, root) {
  const lockPath = packageLockPath(directory)
  if (!lockPath) return

  const lock = readJson(lockPath)
  if (!lock.packages?.['']) {
    throw new Error(`${relativePath(lockPath, root)} has no root package entry`)
  }
  lock.packages[''].license = LICENSE_DECLARATION
  writeJson(lockPath, lock)
}

export function synchronizePackageLicenses(root = REPOSITORY_ROOT) {
  const { errors, canonical } = validateCanonicalLicense(root)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  for (const manifestPath of discoverPackageManifests(root)) {
    const directory = path.dirname(manifestPath)
    synchronizeManifest(manifestPath)
    synchronizeLicenseFiles(directory, root, canonical)
    synchronizePackageLock(directory, root)
  }
}

function validateManifestDeclaration(project, manifest) {
  if (manifest.license === LICENSE_DECLARATION) return []
  return [`${project} must declare license ${JSON.stringify(LICENSE_DECLARATION)}`]
}

function validateFilesAllowlist(project, manifest) {
  if (!Array.isArray(manifest.files)) return []

  const licenseEntries = manifest.files.filter(
    entry => typeof entry === 'string' && LICENSE_ENTRY_PATTERN.test(entry)
  )
  if (licenseEntries.length === 1 && licenseEntries[0] === LICENSE_FILE) return []
  return [
    `${project} files allowlist must contain exactly ${LICENSE_FILE} ` +
      'and no legacy license filename'
  ]
}

function validateLicenseCopy(project, directory, canonical) {
  const projectLicensePath = path.join(directory, LICENSE_FILE)
  if (!fs.existsSync(projectLicensePath)) {
    return [`${project} is missing ${LICENSE_FILE}`]
  }
  if (fs.readFileSync(projectLicensePath).equals(canonical)) return []
  return [
    `${project}/${LICENSE_FILE} does not match the canonical Version ` + `${LICENSE_VERSION} text`
  ]
}

function validateLegacyFiles(project, directory) {
  return LEGACY_LICENSE_FILES.filter(legacyFile =>
    fs.existsSync(path.join(directory, legacyFile))
  ).map(legacyFile => `${project} retains legacy license file ${legacyFile}`)
}

function validatePackageLock(directory, root) {
  const lockPath = packageLockPath(directory)
  if (!lockPath) return []
  const lockLicense = readJson(lockPath).packages?.['']?.license
  if (lockLicense === LICENSE_DECLARATION) return []
  return [
    `${relativePath(lockPath, root)} root package must declare ` +
      JSON.stringify(LICENSE_DECLARATION)
  ]
}

export function validatePackageLicenses(root = REPOSITORY_ROOT) {
  const { errors, canonical } = validateCanonicalLicense(root)
  if (!canonical) return errors

  for (const manifestPath of discoverPackageManifests(root)) {
    const directory = path.dirname(manifestPath)
    const project = relativePath(directory, root)
    const manifest = readJson(manifestPath)
    errors.push(
      ...validateManifestDeclaration(project, manifest),
      ...validateFilesAllowlist(project, manifest),
      ...validateLicenseCopy(project, directory, canonical),
      ...validateLegacyFiles(project, directory),
      ...validatePackageLock(directory, root)
    )
  }
  return errors
}

function main() {
  const write = process.argv.includes('--write')
  if (write) synchronizePackageLicenses()

  const errors = validatePackageLicenses()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
    return
  }
  console.log(
    `Verified ${discoverPackageManifests().length} package manifests against ` +
      `Open BSV License Version ${LICENSE_VERSION}.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
