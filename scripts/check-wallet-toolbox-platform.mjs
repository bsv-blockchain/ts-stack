#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 240_000
const MAX_BUFFER_BYTES = 30 * 1024 * 1024
const MAX_ERROR_OUTPUT_CHARACTERS = 16_000

const profile = process.argv[2]

if (!['browser', 'mobile'].includes(profile) || process.argv.length !== 3) {
  throw new Error('Usage: check-wallet-toolbox-platform.mjs <browser|mobile>')
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const walletToolboxDirectory = path.join(repositoryRoot, 'packages', 'wallet', 'wallet-toolbox')
const packageDirectory = path.join(
  walletToolboxDirectory,
  profile === 'browser' ? 'client' : 'mobile'
)
const sdkDirectory = path.join(repositoryRoot, 'packages', 'sdk')

const expectedPackage =
  profile === 'browser' ? '@bsv/wallet-toolbox-client' : '@bsv/wallet-toolbox-mobile'
const requiredExports =
  profile === 'browser'
    ? [
        'Services',
        'SetupClient',
        'StorageClient',
        'StorageIdb',
        'Wallet',
        'WalletPermissionsManager',
        'WalletSettingsManager',
        'WalletSigner',
        'WalletStorageManager'
      ]
    : [
        'ArcSSEClient',
        'Services',
        'StorageClient',
        'Wallet',
        'WalletPermissionsManager',
        'WalletSettingsManager',
        'WalletSigner',
        'WalletStorageManager'
      ]

const prohibitedExports =
  profile === 'browser'
    ? ['Setup', 'StorageKnex', 'ShamirWalletManager']
    : ['Setup', 'SetupClient', 'StorageIdb', 'StorageKnex', 'ShamirWalletManager']

const prohibitedModulePatterns = [
  /^node:/,
  /(?:^|[/\\])better-sqlite3(?:[/\\]|$)/,
  /(?:^|[/\\])body-parser(?:[/\\]|$)/,
  /(?:^|[/\\])dotenv(?:[/\\]|$)/,
  /(?:^|[/\\])express(?:[/\\]|$)/,
  /(?:^|[/\\])knex(?:[/\\]|$)/,
  /(?:^|[/\\])mysql2(?:[/\\]|$)/,
  /(?:^|[/\\])ws(?:[/\\]|$)/,
  /(?:^|[/\\])StorageKnex\.[cm]?[jt]s$/,
  /(?:^|[/\\])adminServer(?:[/\\]|$)/
]

const prohibitedRuntimeModules = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'net',
  'os',
  'path',
  'stream',
  'tls',
  'url',
  'util',
  'worker_threads'
])

const staticModuleSpecifierPatterns = [
  /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']/g
]

function compareText(left, right) {
  return left.localeCompare(right)
}

function truncateCommandOutput(value) {
  const output = value?.toString().trim()
  if (!output || output.length <= MAX_ERROR_OUTPUT_CHARACTERS) return output
  const retainedCharacters = Math.floor(MAX_ERROR_OUTPUT_CHARACTERS / 2)
  return [
    output.slice(0, retainedCharacters),
    `\n... ${output.length - MAX_ERROR_OUTPUT_CHARACTERS} characters omitted ...\n`,
    output.slice(-retainedCharacters)
  ].join('')
}

function commandError(error) {
  return (
    [error.stdout, error.stderr]
      .map(truncateCommandOutput)
      .map(value => value?.toString().trim())
      .filter(Boolean)
      .join('\n') || error.message
  )
}

async function run(command, arguments_, options = {}) {
  try {
    return await execFileAsync(command, arguments_, {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: COMMAND_TIMEOUT_MS,
      ...options
    })
  } catch (error) {
    throw new Error(`${command} ${arguments_.join(' ')} failed:\n${commandError(error)}`)
  }
}

async function packProject(projectDirectory, expectedName, packDirectory) {
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: projectDirectory,
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

async function packPackages() {
  const packDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-platform-pack-'))
  const [packageTarballPath, sdkTarballPath] = await Promise.all([
    packProject(packageDirectory, expectedPackage, packDirectory),
    packProject(sdkDirectory, '@bsv/sdk', packDirectory)
  ])
  return {
    packDirectory,
    tarballPaths: [sdkTarballPath, packageTarballPath]
  }
}

async function installConsumer(tarballPaths) {
  const consumerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-platform-consumer-'))
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
  return createRequire(path.join(packageDirectory, 'package.json')).resolve(packageName)
}

function dependencyResolver(packageName, dependencyName) {
  return createRequire(toolResolver(`${packageName}/package.json`)).resolve(dependencyName)
}

async function importTool(packageName) {
  return import(pathToFileURL(toolResolver(packageName)).href)
}

function assertModuleComposition(moduleIds, label) {
  const prohibited = [...new Set(moduleIds)]
    .filter(moduleId => prohibitedModulePatterns.some(pattern => pattern.test(moduleId)))
    .sort(compareText)
  if (prohibited.length > 0) {
    throw new Error(`${label} included prohibited Node/server modules:\n${prohibited.join('\n')}`)
  }
}

function assertRuntimeComposition(code, label) {
  const violations = []
  for (const pattern of staticModuleSpecifierPatterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1].replace(/^node:/, '')
      const rootModule = specifier.split('/')[0]
      if (!prohibitedRuntimeModules.has(rootModule)) continue
      const start = Math.max(0, match.index - 120)
      const end = Math.min(code.length, match.index + match[0].length + 120)
      violations.push(`${specifier}: ${JSON.stringify(code.slice(start, end))}`)
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `${label} retained prohibited Node runtime references:\n${violations.join('\n')}`
    )
  }
}

function sizes(buffer) {
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

async function readBundle(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await readBundle(absolutePath)))
    } else {
      files.push(absolutePath)
    }
  }
  const javascriptFiles = files.filter(file => /\.[cm]?js$/.test(file))
  const mapFiles = files.filter(file => file.endsWith('.map'))
  if (javascriptFiles.length === 0 || mapFiles.length === 0) {
    throw new Error(`expected JavaScript and source maps in ${directory}`)
  }
  const code = Buffer.concat(
    await Promise.all(javascriptFiles.sort(compareText).map(file => fs.readFile(file)))
  )
  const sourceMaps = await Promise.all(
    mapFiles.sort(compareText).map(async file => JSON.parse(await fs.readFile(file, 'utf8')))
  )
  if (
    sourceMaps.some(
      sourceMap =>
        !Array.isArray(sourceMap.sources) ||
        sourceMap.sources.length === 0 ||
        !Array.isArray(sourceMap.sourcesContent) ||
        sourceMap.sourcesContent.length === 0
    )
  ) {
    throw new Error(`source maps in ${directory} must retain source paths and source content`)
  }
  return { code, sourceMaps }
}

function validateBudget(actual, maximum, label) {
  for (const dimension of ['raw', 'gzip', 'brotli']) {
    if (!Number.isSafeInteger(maximum?.[dimension]) || maximum[dimension] <= 0) {
      throw new Error(`${label} budget ${dimension} must be a positive safe integer`)
    }
    if (actual[dimension] > maximum[dimension]) {
      throw new Error(
        `${label} ${dimension} size ${actual[dimension]} exceeds budget ${maximum[dimension]}`
      )
    }
  }
}

function flattenSourceMaps(sourceMap) {
  if (!Array.isArray(sourceMap.sections)) return [sourceMap]
  return sourceMap.sections.flatMap(section => flattenSourceMaps(section.map))
}

function consumerEntry(packageName) {
  return [
    `import * as wallet from ${JSON.stringify(packageName)}`,
    `const required = ${JSON.stringify(requiredExports)}`,
    `const prohibited = ${JSON.stringify(prohibitedExports)}`,
    'for (const name of required) {',
    '  if (!(name in wallet) || wallet[name] === undefined) {',
    '    throw new Error(`Missing public export ${name}`)',
    '  }',
    '}',
    'for (const name of prohibited) {',
    '  if (name in wallet) throw new Error(`Unexpected platform export ${name}`)',
    '}',
    'globalThis.__walletToolboxPlatformContract = required.length'
  ].join('\n')
}

async function checkBrowser(consumerDirectory, budget) {
  const entryPath = path.join(consumerDirectory, 'entry.js')
  await fs.writeFile(entryPath, consumerEntry(expectedPackage))

  const viteOutputDirectory = path.join(consumerDirectory, 'vite-dist')
  const viteModules = new Set()
  const { build: viteBuild } = await importTool('vite')
  await viteBuild({
    root: consumerDirectory,
    configFile: false,
    logLevel: 'error',
    plugins: [
      {
        name: 'wallet-platform-composition',
        generateBundle(_options, bundle) {
          for (const artifact of Object.values(bundle)) {
            if (artifact.type !== 'chunk') continue
            for (const moduleId of Object.keys(artifact.modules)) viteModules.add(moduleId)
          }
        }
      }
    ],
    build: {
      emptyOutDir: true,
      lib: {
        entry: entryPath,
        formats: ['es'],
        fileName: () => 'wallet-toolbox-client.mjs'
      },
      minify: 'esbuild',
      outDir: viteOutputDirectory,
      reportCompressedSize: false,
      sourcemap: true
    }
  })
  assertModuleComposition([...viteModules], 'Vite browser bundle')
  const viteBundle = await readBundle(viteOutputDirectory)
  assertRuntimeComposition(viteBundle.code.toString('utf8'), 'Vite browser bundle')
  const viteSizes = sizes(viteBundle.code)
  validateBudget(viteSizes, budget.vite, 'Vite browser bundle')

  const esbuildOutputDirectory = path.join(consumerDirectory, 'esbuild-dist')
  await fs.mkdir(esbuildOutputDirectory)
  const esbuildOutput = path.join(esbuildOutputDirectory, 'wallet-toolbox-client.mjs')
  const { build: esbuildBuild } = await importTool('esbuild')
  const esbuildResult = await esbuildBuild({
    absWorkingDir: consumerDirectory,
    bundle: true,
    conditions: ['browser', 'import', 'default'],
    entryPoints: [entryPath],
    format: 'esm',
    logLevel: 'silent',
    mainFields: ['browser', 'module', 'main'],
    metafile: true,
    minify: true,
    outfile: esbuildOutput,
    platform: 'browser',
    sourcemap: true,
    target: ['es2022']
  })
  assertModuleComposition(Object.keys(esbuildResult.metafile.inputs), 'esbuild browser bundle')
  const esbuildBundle = await readBundle(esbuildOutputDirectory)
  assertRuntimeComposition(esbuildBundle.code.toString('utf8'), 'esbuild browser bundle')
  const esbuildSizes = sizes(esbuildBundle.code)
  validateBudget(esbuildSizes, budget.esbuild, 'esbuild browser bundle')

  return { vite: viteSizes, esbuild: esbuildSizes }
}

function hermesCompilerPath() {
  const packageRoot = path.dirname(toolResolver('hermes-compiler'))
  let platformDirectory
  switch (process.platform) {
    case 'darwin':
      platformDirectory = 'osx-bin'
      break
    case 'linux':
      platformDirectory = 'linux64-bin'
      break
    case 'win32':
      platformDirectory = 'win64-bin'
      break
    default:
      platformDirectory = ''
  }
  if (!platformDirectory) {
    throw new Error(`unsupported Hermes compiler platform ${process.platform}`)
  }
  return path.join(
    packageRoot,
    'hermesc',
    platformDirectory,
    process.platform === 'win32' ? 'hermesc.exe' : 'hermesc'
  )
}

async function checkMobile(consumerDirectory, budget) {
  const entryPath = path.join(consumerDirectory, 'index.js')
  await fs.writeFile(entryPath, consumerEntry(expectedPackage))
  await fs.writeFile(
    path.join(consumerDirectory, 'babel.config.cjs'),
    `module.exports = { presets: [${JSON.stringify(
      toolResolver('@react-native/babel-preset')
    )}] }\n`
  )
  const bundlePath = path.join(consumerDirectory, 'wallet-toolbox-mobile.js')
  const mapPath = `${bundlePath}.map`

  const [{ runBuild }, { getDefaultConfig, mergeConfig }] = await Promise.all([
    importTool('metro'),
    importTool('metro-config')
  ])
  const metroNodeModulesDirectory = path.dirname(path.dirname(toolResolver('metro/package.json')))
  const metroRuntimeDirectory = path.dirname(
    path.dirname(
      path.dirname(dependencyResolver('metro', 'metro-runtime/src/polyfills/require.js'))
    )
  )
  const defaultConfig = await getDefaultConfig(consumerDirectory)
  const metroConfig = mergeConfig(defaultConfig, {
    projectRoot: consumerDirectory,
    watchFolders: [consumerDirectory, metroRuntimeDirectory],
    transformer: {
      asyncRequireModulePath: dependencyResolver('metro', 'metro-runtime/src/modules/asyncRequire'),
      minifierConfig: {
        ...defaultConfig.transformer.minifierConfig,
        sourceMap: {
          ...defaultConfig.transformer.minifierConfig.sourceMap,
          includeSources: true
        }
      }
    },
    resolver: {
      nodeModulesPaths: [path.join(consumerDirectory, 'node_modules'), metroNodeModulesDirectory],
      resolverMainFields: ['react-native', 'browser', 'main'],
      sourceExts: [...new Set([...defaultConfig.resolver.sourceExts, 'cjs', 'mjs'])],
      unstable_conditionNames: ['react-native', 'import', 'require', 'default'],
      unstable_enablePackageExports: true
    }
  })
  const result = await runBuild(metroConfig, {
    bundleOut: bundlePath,
    dev: false,
    entry: path.relative(consumerDirectory, entryPath),
    minify: true,
    platform: 'ios',
    sourceMap: true,
    sourceMapOut: mapPath,
    sourceMapUrl: path.basename(mapPath)
  })
  const metroCode = Buffer.from(result.code)
  const sourceMap = JSON.parse(await fs.readFile(mapPath, 'utf8'))
  const sourceMaps = flattenSourceMaps(sourceMap)
  const sourcePaths = sourceMaps.flatMap(map => (Array.isArray(map.sources) ? map.sources : []))
  const sourcesContent = sourceMaps.flatMap(map =>
    Array.isArray(map.sourcesContent) ? map.sourcesContent : []
  )
  if (
    sourcePaths.length === 0 ||
    sourcesContent.length !== sourcePaths.length ||
    sourcesContent.some(content => typeof content !== 'string')
  ) {
    throw new Error(
      'Metro source map must retain source paths and source content ' +
        `(sources=${sourcePaths.length}, sourcesContent=${sourcesContent.length})`
    )
  }
  assertModuleComposition(sourcePaths, 'Metro mobile bundle')
  assertRuntimeComposition(result.code, 'Metro mobile bundle')
  const metroSizes = sizes(metroCode)
  validateBudget(metroSizes, budget.metro, 'Metro mobile bundle')

  const hermesPath = hermesCompilerPath()
  const bytecodePath = path.join(consumerDirectory, 'wallet-toolbox-mobile.hbc')
  await run(hermesPath, ['-O', '-emit-binary', '-out', bytecodePath, bundlePath])
  const hermesBytecode = await fs.readFile(bytecodePath)
  if (hermesBytecode.length === 0) throw new Error('Hermes compiler emitted empty bytecode')
  const hermesSizes = sizes(hermesBytecode)
  validateBudget(hermesSizes, budget.hermes, 'Hermes mobile bytecode')

  return { metro: metroSizes, hermes: hermesSizes }
}

async function main() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'package.json'), 'utf8')
  )
  if (manifest.name !== expectedPackage) {
    throw new Error(
      `profile ${profile} requires package ${expectedPackage}, found ${manifest.name}`
    )
  }
  const budget = JSON.parse(
    await fs.readFile(path.join(packageDirectory, 'platform-budget.json'), 'utf8')
  )
  if (budget.profile !== profile) {
    throw new Error(`platform budget profile ${budget.profile} does not match ${profile}`)
  }

  const packed = await packPackages()
  let consumerDirectory
  try {
    consumerDirectory = await installConsumer(packed.tarballPaths)
    const measurements =
      profile === 'browser'
        ? await checkBrowser(consumerDirectory, budget.maximumBytes)
        : await checkMobile(consumerDirectory, budget.maximumBytes)
    console.log(
      `Verified ${manifest.name}@${manifest.version} ${profile} platform contract: ` +
        `${JSON.stringify(measurements)}`
    )
  } finally {
    await Promise.all([
      fs.rm(packed.packDirectory, { recursive: true, force: true }),
      consumerDirectory
        ? fs.rm(consumerDirectory, { recursive: true, force: true })
        : Promise.resolve()
    ])
  }
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
