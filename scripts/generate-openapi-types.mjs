#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GO_TOOLS = resolve(ROOT, 'tools/codegen')
const PYTHON_TOOLS = resolve(ROOT, 'tools/codegen')
const NODE_TOOLS = resolve(ROOT, 'tools/codegen/node')
const CHECK = process.argv.slice(2).includes('--check')

const contracts = [
  {
    name: 'overlay',
    spec: 'specs/overlay/overlay-http.yaml',
    goPackage: 'overlay'
  },
  {
    name: 'broadcast',
    spec: 'specs/broadcast/arc.yaml',
    goPackage: 'broadcast'
  },
  {
    name: 'messaging',
    spec: 'specs/messaging/message-box-http.yaml',
    goPackage: 'messaging'
  }
]

const generatedFiles = []
const temporaryRoot = mkdtempSync(join(tmpdir(), 'ts-stack-codegen-'))
const deterministicEnvironment = {
  ...process.env,
  CI: 'true',
  LC_ALL: 'C.UTF-8',
  NO_COLOR: '1',
  PYTHONHASHSEED: '0',
  TZ: 'UTC'
}

function executable (name) {
  return process.platform === 'win32' ? `${name}.cmd` : name
}

function run (command, args, options = {}) {
  let resolvedCommand = executable(command)
  if (options.exactPath === true) {
    resolvedCommand = process.platform === 'win32' ? `${command}.cmd` : command
  }
  const result = spawnSync(resolvedCommand, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    env: deterministicEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.captureStdout === true
      ? ['ignore', 'pipe', 'inherit']
      : 'inherit'
  })

  if (result.error != null) {
    throw new Error(`Unable to run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
  }
  return result.stdout ?? ''
}

function outputPath (temporaryDirectory, fileName) {
  const temporary = resolve(temporaryDirectory, fileName)
  const committed = resolve(ROOT, 'conformance/generated', fileName)
  generatedFiles.push({ committed, temporary })
  mkdirSync(dirname(temporary), { recursive: true })
  return temporary
}

function generateContract (contract) {
  const specification = resolve(ROOT, contract.spec)
  const typescriptOutput = outputPath(
    temporaryRoot,
    `${contract.name}/types.gen.d.ts`
  )
  const goOutput = outputPath(
    temporaryRoot,
    `${contract.name}/types.gen.go`
  )
  const pythonOutput = outputPath(
    temporaryRoot,
    `${contract.name}/models.py`
  )

  run(resolve(NODE_TOOLS, 'node_modules/.bin/openapi-typescript'), [
    specification,
    '--output',
    typescriptOutput
  ], { exactPath: true })

  const goSource = run('go', [
    'tool',
    'oapi-codegen',
    '-generate',
    'types',
    '-package',
    contract.goPackage,
    specification
  ], {
    captureStdout: true,
    cwd: GO_TOOLS
  })
  writeFileSync(goOutput, goSource)

  run('uv', [
    'run',
    '--project',
    PYTHON_TOOLS,
    '--locked',
    'datamodel-codegen',
    '--input',
    specification,
    '--input-file-type',
    'openapi',
    '--output',
    pythonOutput,
    '--output-model-type',
    'pydantic_v2.BaseModel',
    '--disable-timestamp',
    '--formatters',
    'black',
    'isort'
  ])
}

function verifyGeneratedFiles () {
  const stale = generatedFiles.filter(({ committed, temporary }) => {
    if (!existsSync(committed)) return true
    return !readFileSync(committed).equals(readFileSync(temporary))
  })

  if (stale.length === 0) {
    console.log(`Code generation is reproducible: ${generatedFiles.length} files are current.`)
    return
  }

  console.error('Generated OpenAPI types are missing or stale:')
  for (const { committed } of stale) {
    console.error(`  - ${committed.slice(ROOT.length + 1)}`)
  }
  console.error('Run `pnpm codegen` and commit the resulting files.')
  process.exitCode = 1
}

function updateGeneratedFiles () {
  for (const { committed, temporary } of generatedFiles) {
    mkdirSync(dirname(committed), { recursive: true })
    copyFileSync(temporary, committed)
    console.log(`updated ${committed.slice(ROOT.length + 1)}`)
  }
  console.log(`OpenAPI code generation complete: ${generatedFiles.length} files updated.`)
}

try {
  for (const contract of contracts) generateContract(contract)
  if (CHECK) verifyGeneratedFiles()
  else updateGeneratedFiles()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
