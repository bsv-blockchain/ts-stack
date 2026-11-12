#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const LICENSE_DECLARATION = 'Apache-2.0'
export const LICENSE_FILE = 'LICENSE'
export const NOTICE_FILE = 'NOTICE'
export const PATENTS_FILE = 'PATENTS'
export const LICENSE_NAME = 'Apache License, Version 2.0'
export const OCI_LICENSE_REFERENCE = 'Apache-2.0'
export const EXPECTED_LICENSE_SHA256 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'
export const EXPECTED_PATENTS_SHA256 =
  '02988c67da2b43a9c2a566df2f3ff1376e7fa3eaed3562fa983d12f78a8cd8e0'

const IGNORED_DIRECTORIES = new Set([
  '.cache',
  '.git',
  '.next',
  '.pagefind',
  '.ssr',
  '.stryker-tmp',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'out'
])
const LEGACY_LICENSE_FILES = [
  'LICENSE.txt',
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
  const noticePath = path.join(root, NOTICE_FILE)
  const patentsPath = path.join(root, PATENTS_FILE)
  if ([canonicalPath, noticePath, patentsPath].some(file => !fs.existsSync(file))) {
    return {
      errors: [LICENSE_FILE, NOTICE_FILE, PATENTS_FILE]
        .filter(file => !fs.existsSync(path.join(root, file)))
        .map(file => `${file} is missing from the repository root`),
      canonical: null,
      notice: null,
      patents: null
    }
  }

  const canonical = fs.readFileSync(canonicalPath)
  const notice = fs.readFileSync(noticePath)
  const patents = fs.readFileSync(patentsPath)
  const actualHash = sha256(canonical)
  const errors = []
  if (actualHash !== EXPECTED_LICENSE_SHA256) {
    errors.push(
      `${LICENSE_FILE} must be the exact ${LICENSE_NAME} ` +
        `text (${EXPECTED_LICENSE_SHA256}); received ${actualHash}`
    )
  }
  const patentsHash = sha256(patents)
  if (patentsHash !== EXPECTED_PATENTS_SHA256) {
    errors.push(
      `${PATENTS_FILE} must be the approved patent statement ` +
        `(${EXPECTED_PATENTS_SHA256}); received ${patentsHash}`
    )
  }
  return { errors, canonical, notice, patents }
}

function normalizeFilesAllowlist(files) {
  if (!Array.isArray(files)) return files
  return [
    ...files.filter(
      entry =>
        typeof entry !== 'string' ||
        (!LICENSE_ENTRY_PATTERN.test(entry) && entry !== NOTICE_FILE && entry !== PATENTS_FILE)
    ),
    LICENSE_FILE,
    NOTICE_FILE,
    PATENTS_FILE
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

function synchronizeLicenseFiles(directory, root, canonical, notice, patents) {
  if (directory !== root) {
    fs.writeFileSync(path.join(directory, LICENSE_FILE), canonical)
    fs.writeFileSync(path.join(directory, NOTICE_FILE), notice)
    fs.writeFileSync(path.join(directory, PATENTS_FILE), patents)
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
  const { errors, canonical, notice, patents } = validateCanonicalLicense(root)
  if (errors.length > 0) throw new Error(errors.join('\n'))

  for (const manifestPath of discoverPackageManifests(root)) {
    const directory = path.dirname(manifestPath)
    synchronizeManifest(manifestPath)
    synchronizeLicenseFiles(directory, root, canonical, notice, patents)
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
  const noticeEntries = manifest.files.filter(entry => entry === NOTICE_FILE)
  const patentsEntries = manifest.files.filter(entry => entry === PATENTS_FILE)
  if (
    licenseEntries.length === 1 &&
    licenseEntries[0] === LICENSE_FILE &&
    noticeEntries.length === 1 &&
    patentsEntries.length === 1
  ) {
    return []
  }
  return [
    `${project} files allowlist must contain exactly ${LICENSE_FILE}, ${NOTICE_FILE} ` +
      `and ${PATENTS_FILE} ` +
      'and no legacy license filename'
  ]
}

function validateCopy(project, directory, file, expected) {
  const copyPath = path.join(directory, file)
  if (!fs.existsSync(copyPath)) return [`${project} is missing ${file}`]
  if (fs.readFileSync(copyPath).equals(expected)) return []
  return [`${project}/${file} does not match the repository root ${file}`]
}

function validateLicenseCopy(project, directory, canonical, notice, patents) {
  return [
    ...validateCopy(project, directory, LICENSE_FILE, canonical),
    ...validateCopy(project, directory, NOTICE_FILE, notice),
    ...validateCopy(project, directory, PATENTS_FILE, patents)
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
  const { errors, canonical, notice, patents } = validateCanonicalLicense(root)
  if (!canonical) return errors

  for (const manifestPath of discoverPackageManifests(root)) {
    const directory = path.dirname(manifestPath)
    const project = relativePath(directory, root)
    const manifest = readJson(manifestPath)
    errors.push(
      ...validateManifestDeclaration(project, manifest),
      ...validateFilesAllowlist(project, manifest),
      ...validateLicenseCopy(project, directory, canonical, notice, patents),
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
      `the ${LICENSE_NAME}.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
