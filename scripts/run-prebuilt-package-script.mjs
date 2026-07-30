#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const BUILD_PREFIXES = ['pnpm build && ', 'pnpm run build && ', 'npm run build && ']

export function stripLeadingBuildCommand(script) {
  for (const prefix of BUILD_PREFIXES) {
    if (script.startsWith(prefix)) {
      const command = script.slice(prefix.length)
      if (command === '') throw new Error('package script has no command after its build prefix')
      return command
    }
  }
  return script
}

export function parseArguments(arguments_) {
  let scriptName = ''
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument !== '--script') throw new Error(`Unknown argument: ${argument}`)
    scriptName = arguments_[index + 1] ?? ''
    index += 1
  }
  if (scriptName === '') throw new Error('--script is required')
  return { scriptName }
}

export async function resolvePackageScript(packageDirectory, scriptName) {
  const manifestPath = path.join(packageDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const script = manifest.scripts?.[scriptName]
  if (typeof script !== 'string' || script === '') {
    throw new Error(`${manifest.name ?? manifestPath} does not define ${scriptName}`)
  }
  return {
    name: manifest.name ?? packageDirectory,
    command: stripLeadingBuildCommand(script)
  }
}

async function runCommand(command, packageDirectory) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, {
      cwd: packageDirectory,
      env: process.env,
      shell: true,
      stdio: 'inherit'
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`package script terminated by signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`package script exited with code ${code}`))
      } else {
        resolvePromise()
      }
    })
  })
}

async function main(arguments_) {
  if (process.env.PREBUILT_PACKAGE_OUTPUTS !== '1') {
    throw new Error(
      'PREBUILT_PACKAGE_OUTPUTS=1 is required; use the package script directly outside audited CI'
    )
  }
  const { scriptName } = parseArguments(arguments_)
  const packageDirectory = process.cwd()
  const resolved = await resolvePackageScript(packageDirectory, scriptName)
  console.log(`Running prebuilt ${resolved.name} ${scriptName}: ${resolved.command}`)
  await runCommand(resolved.command, packageDirectory)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
