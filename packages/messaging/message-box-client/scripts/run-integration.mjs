import { spawn } from 'node:child_process'
import process from 'node:process'

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (value == null || value === '') {
    throw new Error(`${name} is required for the opt-in Message Box integration suite.`)
  }
  return value
}

if (process.env.MESSAGE_BOX_RUN_INTEGRATION !== 'true') {
  throw new Error(
    'Live Message Box integration tests are opt-in. Set MESSAGE_BOX_RUN_INTEGRATION=true, ' +
      'MESSAGE_BOX_INTEGRATION_HOST, and MESSAGE_BOX_WALLET_ORIGINATOR explicitly.'
  )
}

const host = new URL(requiredEnvironment('MESSAGE_BOX_INTEGRATION_HOST'))
requiredEnvironment('MESSAGE_BOX_WALLET_ORIGINATOR')
if (!['http:', 'https:'].includes(host.protocol)) {
  throw new Error('MESSAGE_BOX_INTEGRATION_HOST must use HTTP or HTTPS.')
}
if (
  host.hostname.endsWith('.bsvb.tech') &&
  process.env.MESSAGE_BOX_ALLOW_PRODUCTION_INTEGRATION !== 'true'
) {
  throw new Error(
    'Production integration targets require MESSAGE_BOX_ALLOW_PRODUCTION_INTEGRATION=true.'
  )
}

const child = spawn(
  process.execPath,
  [
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config=jest.config.integration.ts',
    '--watchman=false',
    '--runInBand'
  ],
  { stdio: 'inherit', env: process.env }
)

child.once('error', error => {
  throw error
})
child.once('exit', (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code ?? 1
})
