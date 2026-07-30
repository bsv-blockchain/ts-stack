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
const APPROVED_TYPESCRIPT_PROFILES = new Set([
  'config/typescript/browser.json',
  'config/typescript/cli.json',
  'config/typescript/dual-runtime.json',
  'config/typescript/node-library.json',
  'config/typescript/node-service.json',
  'config/typescript/react-native.json',
  'config/typescript/strict-new.json',
  'config/typescript/test.json',
  'config/typescript/wasm-worker.json'
])
const REQUIRED_STRICT_OPTIONS = [
  'strict',
  'strictNullChecks',
  'noImplicitAny',
  'useUnknownInCatchVariables',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch'
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

function parseJsonWithComments(source, relativePath) {
  let result = ''
  let inString = false
  let escaped = false
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    const next = source[index + 1]
    if (inString) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
      result += character
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index++
      result += '\n'
    } else if (character === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') result += '\n'
        index++
      }
      index++
    } else {
      result += character
    }
  }
  try {
    return JSON.parse(result.replace(/,\s*([}\]])/g, '$1'))
  } catch (error) {
    throw new SyntaxError(
      `${relativePath} is not valid JSONC: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export function repositoryTypeScriptConfigs(root = REPOSITORY_ROOT) {
  const configs = []

  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(root, relativeDirectory)
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_MANIFEST_DIRECTORIES.has(entry.name)) {
          visit(path.join(relativeDirectory, entry.name))
        }
      } else if (
        entry.isFile() &&
        (/^tsconfig(?:\.[^.]+)*\.json$/.test(entry.name) ||
          relativeDirectory.split(path.sep).join('/') === 'config/typescript')
      ) {
        configs.push(path.join(relativeDirectory, entry.name).split(path.sep).join('/'))
      }
    }
  }

  visit('')
  return configs.sort((left, right) => left.localeCompare(right))
}

function resolveExtendedConfig(relativePath, extendedConfig) {
  if (!extendedConfig.startsWith('.')) return undefined
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), extendedConfig)
  )
  return resolved.endsWith('.json') ? resolved : `${resolved}.json`
}

export function inspectTypeScriptProfiles(root = REPOSITORY_ROOT) {
  const findings = []
  const configs = repositoryTypeScriptConfigs(root)
  const parsedConfigs = new Map()

  for (const relativePath of configs) {
    parsedConfigs.set(
      relativePath,
      parseJsonWithComments(fs.readFileSync(path.join(root, relativePath), 'utf8'), relativePath)
    )
    if (path.posix.basename(relativePath) === 'tsconfig.eslint.json') {
      findings.push(`${relativePath} is an obsolete ESLint-era TypeScript configuration`)
    }
  }

  let governed = 0
  for (const relativePath of configs) {
    if (relativePath.startsWith('config/typescript/')) continue
    governed++
    const chain = []
    const seen = new Set()
    let currentPath = relativePath
    while (currentPath !== undefined) {
      if (seen.has(currentPath)) {
        findings.push(`${relativePath} has a circular extends chain through ${currentPath}`)
        break
      }
      seen.add(currentPath)
      const config = parsedConfigs.get(currentPath)
      if (config === undefined) {
        findings.push(`${relativePath} extends missing configuration ${currentPath}`)
        break
      }
      chain.push({ relativePath: currentPath, config })
      if (typeof config.extends !== 'string') break
      const resolved = resolveExtendedConfig(currentPath, config.extends)
      if (resolved === undefined) {
        findings.push(`${relativePath} uses unsupported non-repository extends ${config.extends}`)
        break
      }
      currentPath = resolved
    }

    const approvedProfile = chain.find(entry =>
      APPROVED_TYPESCRIPT_PROFILES.has(entry.relativePath)
    )?.relativePath
    if (approvedProfile === undefined) {
      findings.push(`${relativePath} does not inherit an approved TypeScript runtime profile`)
      continue
    }

    const effectiveCompilerOptions = {}
    for (const entry of [...chain].reverse()) {
      Object.assign(effectiveCompilerOptions, entry.config.compilerOptions ?? {})
    }
    for (const option of REQUIRED_STRICT_OPTIONS) {
      if (effectiveCompilerOptions[option] !== true) {
        findings.push(`${relativePath} must enable compilerOptions.${option}`)
      }
    }
    for (const option of ['noUnusedLocals', 'noUnusedParameters']) {
      if (effectiveCompilerOptions[option] !== false) {
        findings.push(
          `${relativePath} must leave compilerOptions.${option}=false; Oxlint owns unused-symbol enforcement`
        )
      }
    }

    const strictNew = approvedProfile === 'config/typescript/strict-new.json'
    for (const option of ['noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) {
      if (effectiveCompilerOptions[option] !== strictNew) {
        findings.push(
          `${relativePath} must set compilerOptions.${option}=${strictNew} for ${approvedProfile}`
        )
      }
    }
  }

  return { findings, governed, profiles: APPROVED_TYPESCRIPT_PROFILES.size }
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

  const profileReport = inspectTypeScriptProfiles(root)
  findings.push(...profileReport.findings)
  return {
    findings,
    governed,
    codegen,
    configurations: profileReport.governed,
    profiles: profileReport.profiles
  }
}

function main() {
  const report = inspectTypeScriptToolchain()
  for (const finding of report.findings) console.error(`TYPESCRIPT TOOLCHAIN  ${finding}`)
  console.log(
    `TypeScript toolchain: ${report.governed} native compiler profiles, ` +
      `${report.codegen} isolated codegen API profile, ${report.configurations} governed ` +
      `tsconfig files across ${report.profiles} runtime profiles, ${report.findings.length} findings.`
  )
  if (report.findings.length > 0) process.exitCode = 1
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main()
