#!/usr/bin/env node

import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'

import { createCommandRunner } from './lib/command-runner.mjs'
import { governedWorkspacePackages, workspaceRuntimeClosure } from './lib/workspace-packages.mjs'

const COMMAND_TIMEOUT_MS = 240_000
const MAX_BUFFER_BYTES = 30 * 1024 * 1024
const MAX_ERROR_OUTPUT_CHARACTERS = 16_000
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')

const PROHIBITED_MODULE_PATTERNS = [
  /^node:/,
  /(?:^|[/\\])better-sqlite3(?:[/\\]|$)/,
  /(?:^|[/\\])body-parser(?:[/\\]|$)/,
  /(?:^|[/\\])dotenv(?:[/\\]|$)/,
  /(?:^|[/\\])express(?:[/\\]|$)/,
  /(?:^|[/\\])knex(?:[/\\]|$)/,
  /(?:^|[/\\])mysql2?(?:[/\\]|$)/,
  /(?:^|[/\\])oracledb(?:[/\\]|$)/,
  /(?:^|[/\\])pg(?:[/\\]|$)/,
  /(?:^|[/\\])tedious(?:[/\\]|$)/,
  /(?:^|[/\\])ws(?:[/\\]|$)/
]

const PROHIBITED_RUNTIME_MODULES = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'string_decoder',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib'
])

const STATIC_MODULE_SPECIFIER_PATTERNS = [
  /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']/g
]

function compareText(left, right) {
  return left.localeCompare(right)
}

function stableModuleName(module) {
  const normalized = module.replaceAll('\\', '/')
  const installed = normalized.lastIndexOf('/node_modules/')
  if (installed >= 0) return `node_modules/${normalized.slice(installed + '/node_modules/'.length)}`
  if (/\/browser-package-consumer-[^/]+\/entry\.mjs$/.test(normalized)) return 'entry.mjs'
  return normalized
}

function largestModules(moduleBytes, limit = 50) {
  return [...moduleBytes.entries()]
    .map(([module, bytes]) => ({ module: stableModuleName(module), bytes }))
    .sort((left, right) => right.bytes - left.bytes || compareText(left.module, right.module))
    .slice(0, limit)
}

function packageNameFromModuleId(moduleId) {
  const normalized = moduleId.replaceAll('\\', '/')
  const installed = normalized.split('/node_modules/').at(-1)
  if (!installed || installed === normalized) return undefined
  const parts = installed.split('/')
  return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function bundleComposition(moduleIds, files) {
  return {
    chunks: files.filter(file => /\.[cm]?js$/.test(file)).length,
    modules: new Set(moduleIds).size,
    packages: [...new Set(moduleIds.map(packageNameFromModuleId).filter(Boolean))].sort(compareText)
  }
}

const run = createCommandRunner({
  timeoutMs: COMMAND_TIMEOUT_MS,
  maxBufferBytes: MAX_BUFFER_BYTES,
  maxErrorOutputCharacters: MAX_ERROR_OUTPUT_CHARACTERS
})

export function bundleSizes(buffer) {
  return {
    raw: buffer.byteLength,
    gzip: gzipSync(buffer, { level: 9 }).byteLength,
    brotli: brotliCompressSync(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11
      }
    }).byteLength
  }
}

export function aggregateBundleSizes(buffers) {
  return buffers.map(bundleSizes).reduce(
    (total, sizes) => ({
      raw: total.raw + sizes.raw,
      gzip: total.gzip + sizes.gzip,
      brotli: total.brotli + sizes.brotli
    }),
    { raw: 0, gzip: 0, brotli: 0 }
  )
}

function positiveBudget(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`)
  }
}

export function validateBundleBudget(actual, maximum, label, enforce = true) {
  for (const dimension of ['raw', 'gzip', 'brotli']) {
    positiveBudget(maximum?.[dimension], `${label} budget ${dimension}`)
    if (enforce && actual[dimension] > maximum[dimension]) {
      throw new Error(
        `${label} ${dimension} size ${actual[dimension]} exceeds budget ${maximum[dimension]}`
      )
    }
  }
}

export function prohibitedModuleIds(moduleIds) {
  return [...new Set(moduleIds)]
    .filter(moduleId => PROHIBITED_MODULE_PATTERNS.some(pattern => pattern.test(moduleId)))
    .sort(compareText)
}

export function prohibitedRuntimeSpecifiers(code) {
  const violations = []
  for (const pattern of STATIC_MODULE_SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1]
      const normalized = specifier.replace(/^node:/, '')
      const rootModule = normalized.split('/')[0]
      if (PROHIBITED_RUNTIME_MODULES.has(rootModule)) violations.push(specifier)
    }
  }
  return [...new Set(violations)].sort(compareText)
}

function assertBrowserComposition(moduleIds, code, label) {
  const prohibitedIds = prohibitedModuleIds(moduleIds)
  const prohibitedSpecifiers = prohibitedRuntimeSpecifiers(code)
  if (prohibitedIds.length === 0 && prohibitedSpecifiers.length === 0) return

  const details = [
    prohibitedIds.length > 0 ? `prohibited modules:\n${prohibitedIds.join('\n')}` : '',
    prohibitedSpecifiers.length > 0
      ? `prohibited runtime specifiers:\n${prohibitedSpecifiers.join('\n')}`
      : ''
  ]
    .filter(Boolean)
    .join('\n')
  throw new Error(`${label} retained Node/server dependencies:\n${details}`)
}

function packageSpecifier(packageName, entry) {
  if (entry === '.') return packageName
  if (!entry.startsWith('./')) {
    throw new Error(`browser budget entry must be "." or start with "./": ${entry}`)
  }
  return `${packageName}/${entry.slice(2)}`
}

function validateStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
}

export function validateBrowserBudget(budget, manifest) {
  if (budget?.schemaVersion !== 1) throw new Error('browser budget schemaVersion must be 1')
  if (budget?.profile !== 'browser') throw new Error('browser budget profile must be browser')
  if (budget?.package !== manifest.name) {
    throw new Error(
      `browser budget package ${JSON.stringify(budget?.package)} does not match ${manifest.name}`
    )
  }
  packageSpecifier(manifest.name, budget.entry)
  validateStringArray(budget.requiredExports, 'browser budget requiredExports')
  validateStringArray(budget.prohibitedExports, 'browser budget prohibitedExports')
  for (const tool of ['vite', 'esbuild']) {
    validateBundleBudget({ raw: 0, gzip: 0, brotli: 0 }, budget.maximumBytes?.[tool], tool)
  }
  if (budget.umd !== undefined) {
    for (const field of ['path', 'global']) {
      if (typeof budget.umd?.[field] !== 'string' || budget.umd[field] === '') {
        throw new Error(`browser budget umd.${field} must be a non-empty string`)
      }
    }
    if (budget.umd.additionalPaths !== undefined) {
      validateStringArray(budget.umd.additionalPaths, 'browser budget umd.additionalPaths')
      const paths = [budget.umd.path, ...budget.umd.additionalPaths]
      if (new Set(paths).size !== paths.length) {
        throw new Error('browser budget umd paths must be unique')
      }
    }
    validateBundleBudget({ raw: 0, gzip: 0, brotli: 0 }, budget.umd.maximumBytes, 'umd')
  }
}

async function packPackage(packageDirectory, expectedName, packDirectory) {
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      npm_config_ignore_scripts: 'true'
    }
  })
  const result = JSON.parse(stdout)
  if (result.name !== expectedName) {
    throw new Error(`expected ${expectedName}, packed ${result.name}`)
  }
  return path.resolve(result.filename)
}

async function installConsumer(tarballPaths) {
  const consumerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-package-consumer-'))
  await fs.writeFile(
    path.join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`
  )
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--omit=dev',
      ...tarballPaths
    ],
    { cwd: consumerDirectory }
  )
  return consumerDirectory
}

function toolResolver(packageName) {
  return createRequire(path.join(REPOSITORY_ROOT, 'package.json')).resolve(packageName)
}

async function importTool(packageName) {
  return import(pathToFileURL(toolResolver(packageName)).href)
}

function consumerEntry(specifier, budget) {
  return [
    `import * as loaded from ${JSON.stringify(specifier)}`,
    `const required = ${JSON.stringify(budget.requiredExports)}`,
    `const prohibited = ${JSON.stringify(budget.prohibitedExports)}`,
    'for (const name of required) {',
    '  if (!(name in loaded) || loaded[name] === undefined) {',
    '    throw new Error(`Missing public export ${name}`)',
    '  }',
    '}',
    'for (const name of prohibited) {',
    '  if (name in loaded) throw new Error(`Unexpected browser export ${name}`)',
    '}',
    'globalThis.__bsvBrowserPackageContract = required.length'
  ].join('\n')
}

async function collectBundle(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectBundle(absolutePath)).files)
    else files.push(absolutePath)
  }

  const javascriptFiles = files.filter(file => /\.[cm]?js$/.test(file)).sort(compareText)
  const mapFiles = files.filter(file => file.endsWith('.map')).sort(compareText)
  if (javascriptFiles.length === 0 || mapFiles.length === 0) {
    throw new Error(`expected JavaScript and source maps in ${directory}`)
  }

  const code = Buffer.concat(await Promise.all(javascriptFiles.map(file => fs.readFile(file))))
  for (const file of mapFiles) {
    const sourceMap = JSON.parse(await fs.readFile(file, 'utf8'))
    const sourcesWithoutContent = Array.isArray(sourceMap.sources)
      ? sourceMap.sources.filter(
          (_source, index) => typeof sourceMap.sourcesContent?.[index] !== 'string'
        )
      : []
    if (
      !Array.isArray(sourceMap.sources) ||
      sourceMap.sources.length === 0 ||
      !Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length !== sourceMap.sources.length ||
      sourcesWithoutContent.length > 0
    ) {
      const details =
        sourcesWithoutContent.length > 0
          ? `; missing content for: ${sourcesWithoutContent.join(', ')}`
          : ''
      throw new Error(`source map ${file} must retain source paths and source content${details}`)
    }
  }
  return { code, files }
}

async function checkVite(consumerDirectory, entryPath, budget, enforceBudget) {
  const outputDirectory = path.join(consumerDirectory, 'vite-dist')
  const moduleIds = new Set()
  const moduleBytes = new Map()
  const { build } = await importTool('vite')
  await build({
    root: consumerDirectory,
    configFile: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'bsv-browser-package-composition',
        generateBundle(_options, bundle) {
          for (const artifact of Object.values(bundle)) {
            if (artifact.type !== 'chunk') continue
            for (const [moduleId, details] of Object.entries(artifact.modules)) {
              moduleIds.add(moduleId)
              moduleBytes.set(
                moduleId,
                (moduleBytes.get(moduleId) ?? 0) + (details.renderedLength ?? 0)
              )
            }
          }
        }
      }
    ],
    build: {
      emptyOutDir: true,
      lib: {
        entry: entryPath,
        fileName: () => 'consumer.mjs',
        formats: ['es']
      },
      minify: 'esbuild',
      outDir: outputDirectory,
      reportCompressedSize: false,
      sourcemap: true,
      target: 'es2022'
    }
  })
  const bundle = await collectBundle(outputDirectory)
  assertBrowserComposition([...moduleIds], bundle.code.toString('utf8'), 'Vite browser bundle')
  const measurements = bundleSizes(bundle.code)
  validateBundleBudget(measurements, budget, 'Vite browser bundle', enforceBudget)
  return {
    bytes: measurements,
    composition: {
      ...bundleComposition([...moduleIds], bundle.files),
      largestModules: largestModules(moduleBytes)
    }
  }
}

async function checkEsbuild(consumerDirectory, entryPath, budget, enforceBudget) {
  const outputDirectory = path.join(consumerDirectory, 'esbuild-dist')
  await fs.mkdir(outputDirectory)
  const outputPath = path.join(outputDirectory, 'consumer.mjs')
  const { build } = await importTool('esbuild')
  const result = await build({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ['browser', 'import', 'default'],
    entryPoints: [entryPath],
    format: 'esm',
    logLevel: 'silent',
    mainFields: ['browser', 'module', 'main'],
    metafile: true,
    minify: true,
    outfile: outputPath,
    platform: 'browser',
    sourcemap: true,
    sourcesContent: true,
    target: ['es2022']
  })
  const bundle = await collectBundle(outputDirectory)
  assertBrowserComposition(
    Object.keys(result.metafile.inputs),
    bundle.code.toString('utf8'),
    'esbuild browser bundle'
  )
  const measurements = bundleSizes(bundle.code)
  validateBundleBudget(measurements, budget, 'esbuild browser bundle', enforceBudget)
  const moduleBytes = new Map()
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [moduleId, details] of Object.entries(output.inputs ?? {})) {
      moduleBytes.set(moduleId, (moduleBytes.get(moduleId) ?? 0) + details.bytesInOutput)
    }
  }
  return {
    bytes: measurements,
    composition: {
      ...bundleComposition(Object.keys(result.metafile.inputs), bundle.files),
      largestModules: largestModules(moduleBytes)
    }
  }
}

function installedPackageDirectory(consumerDirectory, packageName) {
  return path.join(consumerDirectory, 'node_modules', ...packageName.split('/'))
}

async function removeTemporaryDirectory(directory) {
  await fs.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100
  })
}

async function checkUmd(consumerDirectory, manifest, budget, enforceBudget) {
  if (!budget.umd) return undefined
  const packageDirectory = installedPackageDirectory(consumerDirectory, manifest.name)
  const payloadPaths = [budget.umd.path, ...(budget.umd.additionalPaths ?? [])]
  const absolutePayloadPaths = payloadPaths.map(relativePath => {
    const absolutePath = path.resolve(packageDirectory, relativePath)
    if (!absolutePath.startsWith(`${packageDirectory}${path.sep}`)) {
      throw new Error(`UMD path escapes installed package: ${relativePath}`)
    }
    return absolutePath
  })
  const bundlePath = absolutePayloadPaths[0]
  const [payloads, sourceMapText] = await Promise.all([
    Promise.all(absolutePayloadPaths.map(payloadPath => fs.readFile(payloadPath))),
    fs.readFile(`${bundlePath}.map`, 'utf8')
  ])
  for (const [index, payloadPath] of absolutePayloadPaths.entries()) {
    if (/\.[cm]?js$/.test(payloadPath)) {
      assertBrowserComposition(
        [],
        payloads[index].toString('utf8'),
        `UMD payload ${payloadPaths[index]}`
      )
    }
  }
  const code = payloads[0]
  const sourceMap = JSON.parse(sourceMapText)
  if (
    !Array.isArray(sourceMap.sources) ||
    sourceMap.sources.length === 0 ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sourcesContent.length !== sourceMap.sources.length
  ) {
    throw new Error('UMD source map must retain source paths and source content')
  }
  const codeText = code.toString('utf8')
  if (!codeText.includes(budget.umd.global)) {
    throw new Error(`UMD bundle does not expose configured global ${budget.umd.global}`)
  }
  const measurements = aggregateBundleSizes(payloads)
  validateBundleBudget(measurements, budget.umd.maximumBytes, 'UMD browser payload', enforceBudget)
  return {
    bytes: measurements,
    composition: {
      chunks: payloads.filter((_payload, index) => /\.[cm]?js$/.test(payloadPaths[index])).length,
      modules: sourceMap.sources.length,
      packages: []
    }
  }
}

export function validateBudgetFile(packageDirectory, budgetFile, policy) {
  if (typeof budgetFile !== 'string' || !/^browser-[a-z0-9-]+\.json$/.test(budgetFile)) {
    throw new Error('browser budget selector must be a package-local browser-*.json filename')
  }
  if (budgetFile !== 'browser-budget.json') {
    const relativePath = path.relative(REPOSITORY_ROOT, path.resolve(packageDirectory))
    const registered = policy.packages.some(
      entry => entry.path === relativePath && entry.budget === `${relativePath}/${budgetFile}`
    )
    if (!registered) throw new Error('browser budget selector must identify a governed budget')
  }
  return budgetFile
}

export function parseBrowserArguments(arguments_) {
  const result = {
    packageDirectory: arguments_[0],
    budgetFile: 'browser-budget.json',
    measureOnly: false
  }
  if (!result.packageDirectory || result.packageDirectory.startsWith('--')) {
    throw new Error(
      'Usage: check-browser-package.mjs <package-directory> [--budget <filename>] [--measure]'
    )
  }
  let selectedBudget = false
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--measure' && !result.measureOnly) result.measureOnly = true
    else if (argument === '--budget' && !selectedBudget && arguments_[index + 1]) {
      result.budgetFile = arguments_[++index]
      selectedBudget = true
    } else throw new Error(`Invalid browser argument: ${argument}`)
  }
  return result
}

export async function checkBrowserPackage(
  packageDirectory,
  { enforceBudget = true, budgetFile = 'browser-budget.json' } = {}
) {
  const policy = JSON.parse(
    await fs.readFile(path.join(REPOSITORY_ROOT, 'governance/browser-artifact-policy.json'), 'utf8')
  )
  validateBudgetFile(packageDirectory, budgetFile, policy)
  const [manifestText, budgetText] = await Promise.all([
    fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8'),
    fs.readFile(path.join(packageDirectory, budgetFile), 'utf8')
  ])
  const manifest = JSON.parse(manifestText)
  const budget = JSON.parse(budgetText)
  validateBrowserBudget(budget, manifest)

  const packDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-package-pack-'))
  let consumerDirectory
  try {
    const tarballPath = await packPackage(packageDirectory, manifest.name, packDirectory)
    const workspacePackages = await governedWorkspacePackages(REPOSITORY_ROOT)
    const manifestsByName = new Map(
      [...workspacePackages].map(([name, project]) => [name, project.manifest])
    )
    const dependencyTarballs = []
    for (const name of workspaceRuntimeClosure(manifest, manifestsByName)) {
      const dependency = workspacePackages.get(name)
      dependencyTarballs.push(
        await packPackage(dependency.directory, dependency.manifest.name, packDirectory)
      )
    }
    consumerDirectory = await installConsumer([tarballPath, ...dependencyTarballs])
    const entryPath = path.join(consumerDirectory, 'entry.mjs')
    await fs.writeFile(
      entryPath,
      consumerEntry(packageSpecifier(manifest.name, budget.entry), budget)
    )
    const [vite, esbuild, umd] = await Promise.all([
      checkVite(consumerDirectory, entryPath, budget.maximumBytes.vite, enforceBudget),
      checkEsbuild(consumerDirectory, entryPath, budget.maximumBytes.esbuild, enforceBudget),
      checkUmd(consumerDirectory, manifest, budget, enforceBudget)
    ])
    return { vite, esbuild, ...(umd ? { umd } : {}) }
  } finally {
    await Promise.all([
      removeTemporaryDirectory(packDirectory),
      consumerDirectory ? removeTemporaryDirectory(consumerDirectory) : Promise.resolve()
    ])
  }
}

async function main(arguments_) {
  const { packageDirectory: directory, measureOnly, budgetFile } = parseBrowserArguments(arguments_)
  const packageDirectory = path.resolve(process.cwd(), directory)
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )
  const measurements = await checkBrowserPackage(packageDirectory, {
    enforceBudget: !measureOnly,
    budgetFile
  })
  const outputDirectory = process.env.BROWSER_COMPOSITION_DIRECTORY
  if (outputDirectory) {
    await fs.mkdir(outputDirectory, { recursive: true })
    const slug =
      manifest.name.replace(/^@/, '').replaceAll('/', '-') +
      (budgetFile === 'browser-budget.json' ? '' : `-${budgetFile.slice(0, -5)}`)
    const budget = JSON.parse(await fs.readFile(path.join(packageDirectory, budgetFile), 'utf8'))
    await fs.writeFile(
      path.join(outputDirectory, `${slug}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          package: manifest.name,
          version: manifest.version,
          entry: budget.entry,
          measurements
        },
        null,
        2
      )}\n`
    )
  }
  console.log(
    `${measureOnly ? 'Measured' : 'Verified'} ${manifest.name}@${manifest.version} ` +
      `exact-tarball browser contract: ` +
      JSON.stringify(measurements)
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
