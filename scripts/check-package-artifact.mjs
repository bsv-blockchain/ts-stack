#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 180_000
const MAX_BUFFER_BYTES = 20 * 1024 * 1024

function optionValue(arguments_, name, fallback = '') {
  const index = arguments_.indexOf(name)
  return index === -1 ? fallback : (arguments_[index + 1] ?? fallback)
}

function csvOption(arguments_, name, fallback) {
  return optionValue(arguments_, name, fallback)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
}

function entryExportsOption(arguments_, rootExports) {
  const entries = { '.': rootExports }
  const value = optionValue(arguments_, '--entry-exports')
  if (!value) return entries
  for (const specification of value.split(';').filter(Boolean)) {
    const separator = specification.indexOf('=')
    if (separator === -1) {
      throw new Error(`invalid --entry-exports specification ${JSON.stringify(specification)}`)
    }
    const subpath = specification.slice(0, separator)
    if (subpath !== '.' && !subpath.startsWith('./')) {
      throw new Error(`entrypoint must be "." or start with "./": ${JSON.stringify(subpath)}`)
    }
    entries[subpath] = specification
      .slice(separator + 1)
      .split('|')
      .filter(Boolean)
  }
  return entries
}

function commandError(error) {
  const details = [error.stdout, error.stderr]
    .map(value => value?.toString().trim())
    .filter(Boolean)
    .join('\n')
  return details || error.message
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

function isDeclarationFile(file) {
  return /\.d\.[cm]?ts$/i.test(file)
}

function requiredFileErrors(files) {
  return ['package.json', 'LICENSE.txt'].flatMap(requiredFile =>
    files.filter(file => file === requiredFile).length === 1
      ? []
      : [`tarball must contain exactly one root ${requiredFile}`]
  )
}

function readmeErrors(files) {
  return files.some(file => /^readme(?:\.[^.]+)?$/i.test(file))
    ? []
    : ['tarball must contain a root README']
}

function packedFileErrors(file) {
  const errors = []
  if (
    /(^|\/)(?:__tests__|tests?|coverage)(?:\/|$)/i.test(file) ||
    /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)
  ) {
    errors.push(`tarball contains test artifact ${file}`)
  }
  if (/\.tsbuildinfo$/i.test(file)) {
    errors.push(`tarball contains compiler cache ${file}`)
  }
  if (/\.[cm]?tsx?$/i.test(file) && !isDeclarationFile(file)) {
    errors.push(`tarball contains uncompiled TypeScript source ${file}`)
  }
  if (/(^|\/)(?:package-lock|pnpm-lock|yarn\.lock)(?:\.json|\.yaml)?$/i.test(file)) {
    errors.push(`tarball contains a package-manager lockfile ${file}`)
  }
  return errors
}

function identityErrors(packResult, manifest) {
  const errors = []
  if (packResult.name !== manifest.name) {
    errors.push(
      `tarball name ${JSON.stringify(packResult.name)} does not match ` +
        JSON.stringify(manifest.name)
    )
  }
  if (packResult.version !== manifest.version) {
    errors.push(
      `tarball version ${JSON.stringify(packResult.version)} does not match ` +
        JSON.stringify(manifest.version)
    )
  }
  return errors
}

export function validatePackedFiles(packResult, manifest) {
  const files = (packResult.files ?? []).map(file => file.path)
  return [
    ...requiredFileErrors(files),
    ...readmeErrors(files),
    ...files.flatMap(packedFileErrors),
    ...identityErrors(packResult, manifest)
  ]
}

async function packPackage(packageDirectory) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-stack-package-artifact-'))
  const { stdout } = await run(
    'pnpm',
    ['pack', '--json', '--pack-destination', temporaryDirectory],
    {
      cwd: packageDirectory,
      env: {
        ...process.env,
        npm_config_ignore_scripts: 'true'
      }
    }
  )
  const result = JSON.parse(stdout)
  const tarballPath = path.resolve(result.filename)
  if (path.dirname(tarballPath) !== temporaryDirectory) {
    throw new Error(`pnpm pack wrote outside its temporary directory: ${tarballPath}`)
  }
  return { result, tarballPath, temporaryDirectory }
}

async function checkPublint(tarballPath) {
  const [{ publint }, { formatMessage }] = await Promise.all([
    import('publint'),
    import('publint/utils')
  ])
  const buffer = await fs.readFile(tarballPath)
  const tarball = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  const result = await publint({
    level: 'suggestion',
    pack: { tarball },
    strict: true
  })
  return result.messages
    .filter(message => message.type === 'error')
    .map(message => formatMessage(message, result.pkg, { color: false }))
}

export function typeProblemsForModes(problems, modes) {
  return problems.filter(
    problem =>
      !(
        problem.kind === 'NoResolution' &&
        problem.resolutionKind === 'node16-cjs' &&
        !modes.includes('cjs')
      )
  )
}

async function checkTypes(tarballPath, modes) {
  const [{ checkPackage, createPackageFromTarballData }, { problemKindInfo }] = await Promise.all([
    import('@arethetypeswrong/core'),
    import('@arethetypeswrong/core/problems')
  ])
  const tarball = new Uint8Array(await fs.readFile(tarballPath))
  const result = await checkPackage(createPackageFromTarballData(tarball))
  if (!result.types) {
    throw new Error('@arethetypeswrong/core found no package types')
  }
  const relevantProblems = typeProblemsForModes(result.problems, modes)
  if (relevantProblems.length > 0) {
    const problems = relevantProblems.map(problem => {
      const title = problemKindInfo[problem.kind]?.title ?? problem.kind
      return `${title}: ${JSON.stringify(problem)}`
    })
    throw new Error(
      `@arethetypeswrong/core found ${problems.length} strict type problem(s):\n` +
        problems.join('\n')
    )
  }
}

function exportValidation(expectedExports) {
  return [
    `const expected = ${JSON.stringify(expectedExports)};`,
    'for (const name of expected) {',
    '  if (!(name in loaded) || loaded[name] === undefined) {',
    '    throw new Error(`Missing public export ${name}`);',
    '  }',
    '}'
  ].join('\n')
}

function declaredBin(manifest, binName) {
  if (typeof manifest.bin === 'string') {
    const defaultName = manifest.name.split('/').at(-1)
    return binName === defaultName ? manifest.bin : undefined
  }
  return manifest.bin?.[binName]
}

async function checkInstalledBin(consumerDirectory, manifest, binName, binArguments) {
  if (!binName) return
  if (path.basename(binName) !== binName || !declaredBin(manifest, binName)) {
    throw new Error(`package does not declare the requested executable ${JSON.stringify(binName)}`)
  }
  await run(path.join(consumerDirectory, 'node_modules', '.bin', binName), binArguments, {
    cwd: consumerDirectory
  })
}

function packageSpecifier(packageName, subpath) {
  return subpath === '.' ? packageName : `${packageName}/${subpath.slice(2)}`
}

async function checkConsumer(tarballPath, manifest, modes, entryExports, binName, binArguments) {
  const consumerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-stack-package-consumer-'))
  try {
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
        tarballPath
      ],
      { cwd: consumerDirectory }
    )

    for (const [subpath, expectedExports] of Object.entries(entryExports)) {
      const specifier = packageSpecifier(manifest.name, subpath)
      const validation = exportValidation(expectedExports)
      if (modes.includes('esm')) {
        await run(
          'node',
          [
            '--input-type=module',
            '--eval',
            `const loaded = await import(${JSON.stringify(specifier)});\n${validation}`
          ],
          { cwd: consumerDirectory }
        )
      }
      if (modes.includes('cjs')) {
        await run(
          'node',
          ['--eval', `const loaded = require(${JSON.stringify(specifier)});\n${validation}`],
          { cwd: consumerDirectory }
        )
      }
    }
    await checkInstalledBin(consumerDirectory, manifest, binName, binArguments)
  } finally {
    await fs.rm(consumerDirectory, { recursive: true, force: true })
  }
}

export async function checkPackageArtifact({
  packageDirectory,
  modes = ['esm', 'cjs'],
  expectedExports = [],
  entryExports = { '.': expectedExports },
  binName = '',
  binArguments = [],
  validateTypes = true
}) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const packed = await packPackage(packageDirectory)
  try {
    const payloadErrors = validatePackedFiles(packed.result, manifest)
    const publintErrors = await checkPublint(packed.tarballPath)
    const errors = [...payloadErrors, ...publintErrors]
    if (errors.length > 0) {
      throw new Error(errors.join('\n'))
    }
    if (validateTypes) await checkTypes(packed.tarballPath, modes)
    await checkConsumer(packed.tarballPath, manifest, modes, entryExports, binName, binArguments)
    return manifest
  } finally {
    await fs.rm(packed.temporaryDirectory, { recursive: true, force: true })
  }
}

async function main(arguments_) {
  const target = arguments_[0] && !arguments_[0].startsWith('-') ? arguments_[0] : '.'
  const packageDirectory = path.resolve(process.cwd(), target)
  const modes = csvOption(arguments_, '--modes', 'esm,cjs')
  const expectedExports = csvOption(arguments_, '--exports', '')
  const entryExports = entryExportsOption(arguments_, expectedExports)
  const binName = optionValue(arguments_, '--bin')
  const binArguments = csvOption(arguments_, '--bin-args', '')
  const validateTypes = !arguments_.includes('--skip-types')
  const manifest = await checkPackageArtifact({
    packageDirectory,
    modes,
    expectedExports,
    entryExports,
    binName,
    binArguments,
    validateTypes
  })
  const validations = [
    'packed payload',
    'publint',
    ...(validateTypes ? ['strict type resolution'] : []),
    `${modes.join('/')} clean consumers`,
    ...(binName ? [`installed ${binName} executable`] : [])
  ]
  console.log(`Verified ${manifest.name}@${manifest.version}: ${validations.join(', ')}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
