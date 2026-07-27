#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const NATIVE_TYPESCRIPT_SPECIFIER = 'npm:typescript@7.0.2'
export const COMPATIBILITY_TYPESCRIPT_SPECIFIER = 'npm:@typescript/typescript6@6.0.2'
export const CODEGEN_TYPESCRIPT_SPECIFIER = '5.9.3'
export const CODEGEN_MANIFEST = 'tools/codegen/node/package.json'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]
const IGNORED_MANIFEST_DIRECTORIES = new Set([
  '.git',
  '.stryker-tmp',
  '.venv',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'out'
])

function compilerScript(manifest) {
  return Object.values(manifest.scripts ?? {}).some(
    command => typeof command === 'string' && /\btsc(?:6)?\b/.test(command)
  )
}

function dependencyEntries(manifest, dependency) {
  return DEPENDENCY_FIELDS.flatMap(field =>
    Object.hasOwn(manifest[field] ?? {}, dependency)
      ? [{ field, specifier: manifest[field][dependency] }]
      : []
  )
}

export function inspectTypeScriptManifest(relativePath, manifest) {
  const findings = []
  const nativeEntries = dependencyEntries(manifest, '@typescript/native')
  const compatibilityEntries = dependencyEntries(manifest, 'typescript')

  if (relativePath === CODEGEN_MANIFEST) {
    if (
      nativeEntries.length !== 0 ||
      compatibilityEntries.length !== 1 ||
      compatibilityEntries[0].field !== 'dependencies' ||
      compatibilityEntries[0].specifier !== CODEGEN_TYPESCRIPT_SPECIFIER
    ) {
      findings.push(
        `${relativePath} must retain its isolated TypeScript ${CODEGEN_TYPESCRIPT_SPECIFIER} ` +
          'code-generation API and must not install the native workspace compiler'
      )
    }
    return { findings, governed: false, codegen: true }
  }

  const requiresCompiler =
    nativeEntries.length > 0 ||
    compatibilityEntries.length > 0 ||
    compilerScript(manifest) ||
    Object.hasOwn(manifest.devDependencies ?? {}, 'ts-jest') ||
    Object.hasOwn(manifest.devDependencies ?? {}, 'tsdown')

  if (!requiresCompiler) return { findings, governed: false, codegen: false }

  if (
    nativeEntries.length !== 1 ||
    nativeEntries[0].field !== 'devDependencies' ||
    nativeEntries[0].specifier !== NATIVE_TYPESCRIPT_SPECIFIER
  ) {
    findings.push(
      `${relativePath} must declare devDependency @typescript/native as ` +
        JSON.stringify(NATIVE_TYPESCRIPT_SPECIFIER)
    )
  }

  if (
    compatibilityEntries.length !== 1 ||
    compatibilityEntries[0].field !== 'devDependencies' ||
    compatibilityEntries[0].specifier !== COMPATIBILITY_TYPESCRIPT_SPECIFIER
  ) {
    findings.push(
      `${relativePath} must declare devDependency typescript as ` +
        JSON.stringify(COMPATIBILITY_TYPESCRIPT_SPECIFIER)
    )
  }

  return { findings, governed: true, codegen: false }
}

export function repositoryPackageManifests(root = REPOSITORY_ROOT) {
  const manifests = []

  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory)
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_MANIFEST_DIRECTORIES.has(entry.name)) {
          visit(path.join(relativeDirectory, entry.name))
        }
      } else if (entry.isFile() && entry.name === 'package.json') {
        manifests.push(path.join(relativeDirectory, entry.name).split(path.sep).join('/'))
      }
    }
  }

  visit('')
  return manifests.sort((left, right) => left.localeCompare(right))
}

export function inspectTypeScriptToolchain(root = REPOSITORY_ROOT) {
  const findings = []
  let governed = 0
  let codegen = 0

  for (const relativePath of repositoryPackageManifests(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
    const result = inspectTypeScriptManifest(relativePath, manifest)
    findings.push(...result.findings)
    if (result.governed) governed++
    if (result.codegen) codegen++
  }

  return { findings, governed, codegen }
}

function main() {
  const report = inspectTypeScriptToolchain()
  for (const finding of report.findings) console.error(`TYPESCRIPT TOOLCHAIN  ${finding}`)
  console.log(
    `TypeScript toolchain: ${report.governed} native compiler profiles, ` +
      `${report.codegen} isolated codegen API profile, ${report.findings.length} findings.`
  )
  if (report.findings.length > 0) process.exitCode = 1
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
