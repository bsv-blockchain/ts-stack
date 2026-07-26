#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { publint } from 'publint'
import { formatMessage } from 'publint/utils'

const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const COMMAND_TIMEOUT_MS = 180_000
const MAX_BUFFER_BYTES = 20 * 1024 * 1024

function optionValue(arguments_, name, fallback = '') {
  const index = arguments_.indexOf(name)
  return index === -1 ? fallback : arguments_[index + 1] ?? fallback
}

function csvOption(arguments_, name, fallback) {
  return optionValue(arguments_, name, fallback)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
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
    throw new Error(
      `${command} ${arguments_.join(' ')} failed:\n${commandError(error)}`
    )
  }
}

function isDeclarationFile(file) {
  return /\.d\.[cm]?ts$/i.test(file)
}

export function validatePackedFiles(packResult, manifest) {
  const files = (packResult.files ?? []).map(file => file.path)
  const errors = []
  const required = ['package.json', 'LICENSE.txt']

  for (const requiredFile of required) {
    if (files.filter(file => file === requiredFile).length !== 1) {
      errors.push(`tarball must contain exactly one root ${requiredFile}`)
    }
  }
  if (!files.some(file => /^readme(?:\.[^.]+)?$/i.test(file))) {
    errors.push('tarball must contain a root README')
  }

  for (const file of files) {
    if (/(^|\/)(?:__tests__|tests?|coverage)(?:\/|$)/i.test(file) ||
        /\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file)) {
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
  }

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

async function packPackage(packageDirectory) {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ts-stack-package-artifact-')
  )
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
  const buffer = await fs.readFile(tarballPath)
  const tarball = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
  const result = await publint({
    level: 'suggestion',
    pack: { tarball },
    strict: true
  })
  return result.messages
    .filter(message => message.type === 'error')
    .map(message => formatMessage(message, result.pkg, { color: false }))
}

async function checkTypes(tarballPath) {
  await run(
    'pnpm',
    [
      'exec',
      'attw',
      tarballPath,
      '--profile',
      'strict',
      '--no-color',
      '--no-emoji',
      '--no-summary'
    ],
    { cwd: REPOSITORY_ROOT }
  )
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

async function checkConsumer(tarballPath, manifest, modes, expectedExports) {
  const consumerDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ts-stack-package-consumer-')
  )
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

    const validation = exportValidation(expectedExports)
    if (modes.includes('esm')) {
      await run(
        'node',
        [
          '--input-type=module',
          '--eval',
          `const loaded = await import(${JSON.stringify(manifest.name)});\n${validation}`
        ],
        { cwd: consumerDirectory }
      )
    }
    if (modes.includes('cjs')) {
      await run(
        'node',
        [
          '--eval',
          `const loaded = require(${JSON.stringify(manifest.name)});\n${validation}`
        ],
        { cwd: consumerDirectory }
      )
    }
  } finally {
    await fs.rm(consumerDirectory, { recursive: true, force: true })
  }
}

export async function checkPackageArtifact({
  packageDirectory,
  modes = ['esm', 'cjs'],
  expectedExports = []
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
    await checkTypes(packed.tarballPath)
    await checkConsumer(
      packed.tarballPath,
      manifest,
      modes,
      expectedExports
    )
    return manifest
  } finally {
    await fs.rm(packed.temporaryDirectory, { recursive: true, force: true })
  }
}

async function main(arguments_) {
  const target = arguments_[0] && !arguments_[0].startsWith('-')
    ? arguments_[0]
    : '.'
  const packageDirectory = path.resolve(process.cwd(), target)
  const modes = csvOption(arguments_, '--modes', 'esm,cjs')
  const expectedExports = csvOption(arguments_, '--exports', '')
  const manifest = await checkPackageArtifact({
    packageDirectory,
    modes,
    expectedExports
  })
  console.log(
    `Verified ${manifest.name}@${manifest.version}: packed payload, publint, ` +
    `strict type resolution, and ${modes.join('/')} clean consumers.`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
