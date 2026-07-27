#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
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

export function trackedPackageManifests(root = REPOSITORY_ROOT) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024
  })
    .split('\0')
    .filter(file => file === 'package.json' || file.endsWith('/package.json'))
    .sort((left, right) => left.localeCompare(right))
}

export function inspectTypeScriptToolchain(root = REPOSITORY_ROOT) {
  const findings = []
  let governed = 0
  let codegen = 0

  for (const relativePath of trackedPackageManifests(root)) {
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
